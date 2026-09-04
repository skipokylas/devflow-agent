import type Anthropic from "@anthropic-ai/sdk";
import type { Run } from "./agent/types";
import { summary } from "./trace/render";
import { priceOf, type Span } from "./trace/types";

/**
 * Звіт будується з історії повідомлень, а не з подій виконання: тоді він
 * переживає перезапуск і правильно показує кілька ітерацій — задача, робота,
 * уточнення людини, доопрацювання.
 */

type Block = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
};

const blocksOf = (content: Anthropic.MessageParam["content"]): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]);

const textOf = (blocks: Block[]): string =>
  blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();

const STATUS: Record<Run["status"], string> = {
  queued: "⏳ у черзі",
  running: "⏳ виконується",
  waiting_human: "⏸ чекає на відповідь",
  done: "✅ готово",
  failed: "⚠️ зупинився",
};

const quote = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .map((l) => `> ${l}`)
    .join("\n")
    .replace(/(^(> \n)+|(> \n)+$)/g, "");

/** 1 звернення, 2 звернення, 5 звернень. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** Заголовки моделі опускаємо на рівень нижче, щоб вони не перебивали наш. */
const demote = (text: string): string => text.replace(/^(#{1,4}) /gm, "#$1 ");

/** Виклик як команда, а не як JSON: `read_file src/agent/loop.ts`. */
function call(block: Block): string {
  const input = block.input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const path = record["path"];
    if (typeof path === "string") {
      const depth = record["depth"];
      return `\`${block.name} ${path}${typeof depth === "number" ? ` -d${depth}` : ""}\``;
    }
    const pairs = Object.entries(record)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? `${v.length} шт.` : String(v).slice(0, 24)}`)
      .join(" ");
    return `\`${block.name}${pairs ? ` ${pairs}` : ""}\``;
  }
  return `\`${block.name}\``;
}

export function renderReport(run: Run, spans: Span[]): string {
  const s = spans.length ? summary(spans) : null;
  const out: string[] = [
    `<!-- devflow report:${run.id} -->`,
    `### devflow · ${STATUS[run.status]}`,
    "",
  ];

  let iteration = 1;

  for (const [i, message] of run.messages.entries()) {
    const blocks = blocksOf(message.content);

    if (message.role === "user") {
      const text = textOf(blocks);
      const answer = blocks.find(
        (b) => b.type === "tool_result" && !b.is_error && typeof b.content === "string" && b.content.length < 400,
      );

      if (i === 0 && text) {
        out.push(quote(text.replace(/<\/?untrusted[^>]*>/g, "").trim()), "");
      } else if (text) {
        iteration++;
        out.push("", "---", "", "**Уточнення**", "", quote(text), "");
      } else if (answer && run.pending === null) {
        out.push(`**Відповідь:** ${String(answer.content).replace(/\s+/g, " ").trim()}`, "");
      }
      continue;
    }

    // Виклики однієї відповіді — одним рядком одразу під фразою агента.
    const narration = textOf(blocks);
    const asks = blocks.filter((b) => b.type === "tool_use" && b.name === "ask_human");
    const tools = blocks.filter((b) => b.type === "tool_use" && b.name !== "ask_human");

    if (narration) out.push(demote(narration), "");
    if (tools.length > 0) out.push(`<sub>${tools.map(call).join(" · ")}</sub>`, "");

    for (const ask of asks) {
      const input = ask.input as { question?: string; options?: string[] };
      out.push(`**Питання:** ${input.question ?? ""}`, "");
      for (const [n, option] of (input.options ?? []).entries()) out.push(`${n + 1}. ${option}`);
      if ((input.options ?? []).length > 0) out.push("");
    }
  }

  if (run.error) out.push("", `**Помилка:** \`${run.error}\``, "");

  if (s) {
    const seconds = (s.durationMs / 1000).toFixed(1);
    const tokens = `${s.inputTokens.toLocaleString("uk")}→${s.outputTokens.toLocaleString("uk")}`;
    out.push(
      "",
      "---",
      `<sub>${plural(s.llmCalls, "звернення", "звернення", "звернень")} · ` +
        `${plural(s.toolCalls, "виклик", "виклики", "викликів")} інструментів · ${tokens} токенів · ` +
        `<b>$${s.cost.toFixed(4)}</b> · ${seconds}s` +
        (iteration > 1 ? ` · ${plural(iteration, "ітерація", "ітерації", "ітерацій")}` : "") +
        ` · <code>devflow trace ${run.id}</code></sub>`,
    );
  }

  return out.join("\n");
}

export { priceOf };
