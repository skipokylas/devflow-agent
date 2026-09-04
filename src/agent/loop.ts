import type Anthropic from "@anthropic-ai/sdk";
import type { Storage } from "../db/storage";
import { Tracer, type OpenSpan, type TraceSink } from "../trace/sink";
import type { Channel } from "./channel";
import { priceOf } from "../trace/types";
import type { Llm } from "./llm";
import { ASK_HUMAN, WRITE_ACCESS, type ToolContext, type ToolRegistry } from "./tools";
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
  /**
   * Питати дозволу на кожну write-дію. Типово вимкнено: справжні ворота — це
   * рев'ю PR, а не діалог посеред роботи. Робоча копія одноразова, шляхи
   * обмежені коренем, команди з закритого переліку, у main нічого не потрапляє.
   * Питання посеред роботи не стримує агента — воно лише привчає тиснути «так».
   */
  confirmWrites?: boolean;
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

  await deps.channel.progress?.(run, { kind: "start", task: taskOf(run) });

  try {
    const finished = await loop(current, deps, tracer, root.id, (next) => (current = next));
    await deps.channel.progress?.(finished, { kind: "end", status: finished.status });
    await tracer.finish(root, {
      parentId,
      type: "run",
      name,
      input: taskOf(run),
      output: { status: finished.status, answer: answerOf(finished) },
    });
    return finished;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await tracer.finish(root, { parentId, type: "run", name, input: taskOf(run), error: message });
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
      // Кешується найдовший стабільний префікс: інструменти, системний промпт і
      // вся історія до цього кроку. Наступний крок читає її вдесятеро дешевше
      // замість того, щоб платити за неї повну ціну знову.
      cache_control: { type: "ephemeral" },
      ...(deps.system ? { system: deps.system } : {}),
      tools: deps.tools.definitions(),
      messages: current.messages,
    });

    const cost = {
      model: deps.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };

    await tracer.finish(call, {
      parentId: rootId,
      type: "llm_call",
      name: deps.model,
      // Повний запит, а не його розмір: інакше в переглядачі не видно, що саме пішло в модель.
      input: {
        step,
        system: deps.system ?? "",
        tools: deps.tools.definitions().map((t) => t.name),
        messages: current.messages,
      },
      // Повний content, а не лише stop_reason: саме тут видно, що модель вирішила й написала.
      output: { stopReason: response.stop_reason, content: response.content },
      cost,
    });

    await deps.channel.progress?.(current, {
      kind: "llm",
      step,
      model: deps.model,
      stopReason: response.stop_reason,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      cachedTokens: cost.cacheReadTokens,
      costUsd: priceOf(cost),
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
      // Дозволи, видані людиною раніше в цьому ж run. Порожній набір тут означав
      // би, що ворота пропускають виклик, а реєстр його відхиляє — і агент
      // упирався б у стіну після кожного підтвердження.
      // Коли підтвердження вимкнені, дозвіл на write вважається виданим наперед.
      approvedActions: new Set(
        deps.confirmWrites ? current.approved : [WRITE_ACCESS, ...current.approved],
      ),
    };

    // Ворота дозволу: write-дія без згоди людини зупиняє цикл. Перевірка стоїть
    // у коді, а не в промпті — інакше вона трималася б на слухняності моделі.
    const gated = deps.confirmWrites
      ? toolUses.find(
          (use) => deps.tools.needsApproval(use.name) && !current.approved.includes(WRITE_ACCESS),
        )
      : undefined;
    if (gated) {
      return await pause(current, gated, results, deps, tracer, call.id, {
        tool: gated.name,
        input: gated.input,
      });
    }

    // Спершу виконуємо всі звичайні інструменти: кожен tool_use мусить отримати результат.
    for (const use of toolUses) {
      if (use.name === ASK_HUMAN) continue;
      const startedAt = Date.now();
      const result = await runTool(deps, use, ctx, tracer, call.id);
      await deps.channel.progress?.(current, {
        kind: "tool",
        name: use.name,
        input: use.input,
        ok: result.is_error !== true,
        ms: Date.now() - startedAt,
      });
      if (!deps.channel.progress) {
        await deps.channel.notify(current, `  → ${use.name} ${JSON.stringify(use.input)}`);
      }
      results.push(result);
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

  const { toolUseId, partialResults, approval } = run.pending;
  const agreed = approval !== null && isYes(answer);

  const base: Run = {
    ...run,
    status: "running",
    pending: null,
    error: null,
    approved: agreed ? [...run.approved, WRITE_ACCESS] : run.approved,
  };

  // Пауза через ворота — це не питання моделі, а відкладена дія: після згоди
  // виконуємо саме її, і модель отримує справжній результат, а не слово «так».
  const result: Anthropic.ToolResultBlockParam = agreed
    ? await runTool(
        { ...deps, tools: deps.tools },
        { type: "tool_use", id: toolUseId, name: approval.tool, input: approval.input, caller: { type: "direct" } },
        { runId: run.id, root: deps.root, approvedActions: new Set([WRITE_ACCESS, ...base.approved]) },
        new Tracer(deps.trace, run.id),
        toolUseId,
      )
    : {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: approval ? `людина не дала дозволу: ${answer}` : answer,
        ...(approval ? { is_error: true } : {}),
      };

  const resumed = await push(base, { role: "user", content: [...partialResults, result] }, deps);

  const answerSpan = tracer.start();
  await tracer.finish(answerSpan, { parentId: root.id, type: "answer", name: "людина", output: answer });

  const finished = await advance(resumed, deps, root.id);
  await tracer.finish(root, {
    parentId: null,
    type: "run",
    name: "reply",
    input: taskOf(run),
    output: { status: finished.status, answer: answerOf(finished) },
  });
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
  approval: { tool: string; input: unknown } | null = null,
): Promise<Run> {
  const input = ask.input as { question?: string; options?: string[] };
  const question = approval
    ? `Дозволити правки в цьому прогоні? Дозвіл діє на всі зміни файлів і ` +
      `перевірки до кінця задачі.\n\nПерша дія — ${approval.tool}:\n${describe(approval.input)}`
    : (input.question ?? "(питання без тексту)");
  const options = approval ? ["так", "ні"] : (input.options ?? []);

  const paused = await deps.storage.save({
    ...run,
    status: "waiting_human",
    pending: {
      toolUseId: ask.id,
      question,
      options,
      partialResults,
      askedAt: new Date().toISOString(),
      approval,
    },
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
      output: output.length > 20_000 ? `${output.slice(0, 20_000)}…(обрізано)` : output,
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

/**
 * Аргументи наміру людською мовою: рішення приймається за ними, а не за назвою
 * дії. String() на масиві обʼєктів давав «[object Object]» — тобто рівно там,
 * де треба було побачити план, людина бачила нічого.
 */
function describe(input: unknown): string {
  if (!input || typeof input !== "object") return "";

  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        const items = value.map((item, i) => `  ${i + 1}. ${itemLine(item)}`).join("\n");
        return `${key} (${value.length}):\n${items}`;
      }
      return `${key}: ${one(String(value), 160)}`;
    })
    .join("\n");
}

/** Обʼєкт у списку показуємо за назвою, а не серіалізацією. */
function itemLine(item: unknown): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const title = record["title"] ?? record["name"] ?? record["path"];
    if (typeof title === "string") {
      const detail = typeof record["body"] === "string" ? ` — ${one(record["body"], 90)}` : "";
      return `${title}${detail}`;
    }
    return one(JSON.stringify(item), 140);
  }
  return one(String(item), 140);
}

const one = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/**
 * Згода людини. Свідомо вузький перелік: усе інше — відмова.
 * Без \b: у JS він працює за ASCII, тому після «так» межі слова не бачить.
 */
function isYes(answer: string): boolean {
  return /^(так|ок|okay|ok|yes|y|погоджуюсь|давай|підтверджую|\+)(\s|[.,!)]|$)/i.test(answer.trim());
}

/** Початкова задача — те, з чого почався run. Показується в шапці трейсу. */
function taskOf(run: Run): string {
  const first = run.messages[0];
  if (!first) return "";
  return typeof first.content === "string"
    ? first.content
    : first.content.map((b) => ("text" in b ? b.text : "")).join(" ");
}

/** Фінальна відповідь — останнє, що написала модель. */
function answerOf(run: Run): string {
  for (let i = run.messages.length - 1; i >= 0; i--) {
    const message = run.messages[i];
    if (!message || message.role !== "assistant") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((b) => ("text" in b ? b.text : "")).join("");
    if (text.trim()) return text;
  }
  return "";
}

function renderText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
