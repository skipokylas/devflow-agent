import type Anthropic from "@anthropic-ai/sdk";
import type { Storage } from "../db/storage";
import { Tracer, type OpenSpan, type TraceSink } from "../trace/sink";
import type { Channel } from "./channel";
import type { Llm } from "./llm";
import { ASK_HUMAN, type ToolContext, type ToolRegistry } from "./tools";
import type { Run } from "./types";

export type Deps = {
  llm: Llm;
  storage: Storage;
  tools: ToolRegistry;
  channel: Channel;
  trace: TraceSink;
  model: string;
  maxSteps: number;
  root: string;
  system?: string;
};

export class NotWaiting extends Error {
  constructor(id: string, status: string) {
    super(`${id} має статус ${status}, відповідь не потрібна`);
  }
}

export class NotRetryable extends Error {
  constructor(id: string, status: string) {
    super(`${id} має статус ${status}; повторювати можна тільки failed або обірваний running`);
  }
}

/** Крутить цикл до завершення або до паузи на людині. Зберігає стан після кожного кроку. */
export async function advance(run: Run, deps: Deps, parentId: string | null = null): Promise<Run> {
  let current = run;
  const tracer = new Tracer(deps.trace, run.id);
  const root = tracer.start();
  const name = parentId ? "advance" : "run";

  try {
    const finished = await loop(current, deps, tracer, root.id, (next) => (current = next));
    await tracer.finish(root, { parentId, type: "run", name, output: finished.status });
    return finished;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tracer.finish(root, { parentId, type: "run", name, error: message });
    // Будь-яка помилка (401, 429, обрив мережі) не має лишати run у статусі running назавжди.
    return await fail(current, message, deps, err);
  }
}

async function loop(
  start: Run,
  deps: Deps,
  tracer: Tracer,
  rootId: string,
  track: (run: Run) => void,
): Promise<Run> {
  let current = start;

  for (let step = 1; step <= deps.maxSteps; step++) {
    const call = tracer.start();
    const response = await deps.llm({
      model: deps.model,
      max_tokens: 4096,
      ...(deps.system ? { system: deps.system } : {}),
      tools: deps.tools.definitions(),
      messages: current.messages,
    });
    await tracer.finish(call, {
      parentId: rootId,
      type: "llm_call",
      name: deps.model,
      input: { step, messages: current.messages.length },
      // Повний content, а не лише stop_reason: саме тут видно, що модель вирішила й написала.
      output: { stopReason: response.stop_reason, content: response.content },
      cost: {
        model: deps.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });

    current = await push(current, { role: "assistant", content: response.content }, deps);
    track(current);

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason !== "end_turn") {
        return fail(current, `модель зупинилась: ${response.stop_reason}`, deps);
      }
      current = await deps.storage.save({ ...current, status: "done" });
      await deps.channel.notify(current, renderText(response.content));
      return current;
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const results: Anthropic.ToolResultBlockParam[] = [];
    const ctx: ToolContext = {
      runId: current.id,
      root: deps.root,
      approvedActions: new Set(),
    };

    // Спершу виконуємо всі звичайні інструменти: кожен tool_use мусить отримати результат.
    for (const use of toolUses) {
      if (use.name === ASK_HUMAN) continue;
      await deps.channel.notify(current, `  → ${use.name} ${JSON.stringify(use.input)}`);
      results.push(await runTool(deps, use, ctx, tracer, call.id));
    }

    // Тепер пауза, якщо модель попросила людину.
    const [ask, ...extraAsks] = toolUses.filter((b) => b.name === ASK_HUMAN);
    if (ask) {
      for (const extra of extraAsks) {
        results.push(errorResult(extra.id, "за раз можна поставити лише одне питання"));
      }
      return await pause(current, ask, results, deps, tracer, call.id);
    }

    current = await push(current, { role: "user", content: results }, deps);
    track(current);
  }

  return fail(current, `вичерпано maxSteps (${deps.maxSteps})`, deps);
}

/** Записує причину падіння в стан. Якщо навіть це не вдалось — кидаємо початкову помилку далі. */
async function fail(run: Run, reason: string, deps: Deps, original?: unknown): Promise<Run> {
  let failed: Run;
  try {
    failed = await deps.storage.save({ ...run, status: "failed", error: reason });
  } catch {
    throw original ?? new Error(reason);
  }
  await deps.channel.notify(failed, `зупинено: ${reason}`);
  return failed;
}

/** Повторює перерваний run: історія вже правильна, потрібен лише ще один виклик моделі. */
export async function retry(runId: string, deps: Deps): Promise<Run> {
  const run = await deps.storage.load(runId);
  if (run.status !== "failed" && run.status !== "running") {
    throw new NotRetryable(runId, run.status);
  }

  const resumed = await deps.storage.save({ ...run, status: "running", error: null });
  return advance(resumed, deps);
}

/** Піднімає run з паузи, підставляє відповідь людини як tool_result і йде далі. */
export async function resume(runId: string, answer: string, deps: Deps): Promise<Run> {
  const run = await deps.storage.load(runId);
  if (run.status !== "waiting_human" || !run.pending) throw new NotWaiting(runId, run.status);

  const tracer = new Tracer(deps.trace, run.id);
  const root = tracer.start();

  const { toolUseId, partialResults } = run.pending;
  const resumed = await push(
    { ...run, status: "running", pending: null, error: null },
    {
      role: "user",
      content: [...partialResults, { type: "tool_result", tool_use_id: toolUseId, content: answer }],
    },
    deps,
  );

  const answerSpan = tracer.start();
  await tracer.finish(answerSpan, { parentId: root.id, type: "answer", name: "людина", output: answer });

  const finished = await advance(resumed, deps, root.id);
  await tracer.finish(root, { parentId: null, type: "run", name: "reply", output: finished.status });
  return finished;
}

// ─────────────────────────── допоміжне ───────────────────────────

async function push(run: Run, message: Anthropic.MessageParam, deps: Deps): Promise<Run> {
  return deps.storage.save({ ...run, messages: [...run.messages, message] });
}

async function pause(
  run: Run,
  ask: Anthropic.ToolUseBlock,
  partialResults: Anthropic.ToolResultBlockParam[],
  deps: Deps,
  tracer: Tracer,
  parentId: string,
): Promise<Run> {
  const input = ask.input as { question?: string; options?: string[] };
  const question = input.question ?? "(питання без тексту)";
  const options = input.options ?? [];

  const paused = await deps.storage.save({
    ...run,
    status: "waiting_human",
    pending: { toolUseId: ask.id, question, options, partialResults },
  });

  const span = tracer.start();
  await tracer.finish(span, { parentId, type: "question", name: "ask_human", output: question });

  await deps.channel.ask(paused, { question, options });
  return paused;
}

/** Помилка інструмента повертається в модель, а не вгору: модель виправиться сама. */
async function runTool(
  deps: Deps,
  use: Anthropic.ToolUseBlock,
  ctx: ToolContext,
  tracer: Tracer,
  parentId: string,
): Promise<Anthropic.ToolResultBlockParam> {
  const span = tracer.start();
  try {
    const output = await deps.tools.execute(use.name, use.input, ctx);
    await tracer.finish(span, {
      parentId,
      type: "tool_call",
      name: use.name,
      input: use.input,
      output: output.length > 4000 ? `${output.slice(0, 4000)}…` : output,
    });
    return { type: "tool_result", tool_use_id: use.id, content: output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tracer.finish(span, {
      parentId,
      type: "tool_call",
      name: use.name,
      input: use.input,
      error: message,
    });
    return errorResult(use.id, message);
  }
}

function errorResult(id: string, message: string): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: message, is_error: true };
}

function renderText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
