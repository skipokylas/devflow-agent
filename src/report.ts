import type Anthropic from "@anthropic-ai/sdk";
import type { Run } from "./agent/types";
import { summary } from "./trace/render";
import { priceOf, type Span } from "./trace/types";

/**
 * Звіт будується з історії повідомлень, а не з подій виконання: тоді він
 * переживає перезапуск і правильно показує кілька ітерацій — задача, робота,
 * уточнення людини, доопрацювання.
 */

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean };

const blocksOf = (content: Anthropic.MessageParam["content"]): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]);

const textOf = (blocks: Block[]): string =>
  blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();

const STATUS: Record<Run["status"], string> = {
  queued: "у черзі",
  running: "виконується",
  waiting_human: "чекає на відповідь",
  done: "готово",
  failed: "зупинився",
};

const quote = (text: string): string =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .map((l) => `> ${l}`)
    .join("\n")
    .replace(/(^(> \n)+|(> \n)+$)/g, "");

/** 1 виклик, 2 виклики, 5 викликів. */
const plural = (n: number, one: string, few: string, many: string): string => {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
};

const short = (input: unknown): string => {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return (text ?? "").replace(/\s+/g, " ").slice(0, 70);
};

export function renderReport(run: Run, spans: Span[]): string {
  const s = spans.length ? summary(spans) : null;
  const out: string[] = [`<!-- devflow report:${run.id} -->`, `### devflow · \`${run.id}\` · ${STATUS[run.status]}`, ""];

  let iteration = 0;
  let pendingTools: string[] = [];

  const flushTools = (): void => {
    if (pendingTools.length === 0) return;
    out.push(`<details><summary>${plural(pendingTools.length, "виклик інструмента", "виклики інструментів", "викликів інструментів")}</summary>`, "");
    out.push(...pendingTools.map((t) => `- ${t}`), "", "</details>", "");
    pendingTools = [];
  };

  for (const [i, message] of run.messages.entries()) {
    const blocks = blocksOf(message.content);

    if (message.role === "user") {
      const results = blocks.filter((b) => b.type === "tool_result");
      const text = textOf(blocks);

      // Відповідь людини приходить як tool_result на ask_human — його треба показати.
      const human = results.find((b) => typeof b.content === "string" && !b.is_error && b.content.length < 400);

      if (i === 0 && text) {
        out.push("**Задача**", "", quote(text.replace(/<\/?untrusted[^>]*>/g, "").trim()), "");
      } else if (text) {
        iteration++;
        flushTools();
        out.push("", `**Уточнення від тебе**`, "", quote(text), "");
      } else if (human && run.pending === null) {
        flushTools();
        out.push("", `**Твоя відповідь**`, "", quote(String(human.content)), "");
      }
      continue;
    }

    for (const block of blocks) {
      if (block.type === "tool_use" && block.name === "ask_human") {
        const input = block.input as { question?: string; options?: string[] };
        flushTools();
        out.push("", `**Питання:** ${input.question ?? ""}`, "");
        for (const [n, option] of (input.options ?? []).entries()) out.push(`${n + 1}. ${option}`);
        out.push("");
      } else if (block.type === "tool_use") {
        pendingTools.push(`\`${block.name}\` ${short(block.input)}`);
      } else if (block.type === "text" && block.text?.trim()) {
        flushTools();
        out.push("", block.text.trim(), "");
      }
    }
  }
  flushTools();

  if (run.error) out.push("", `**Помилка:** ${run.error}`, "");

  if (s) {
    const seconds = (s.durationMs / 1000).toFixed(1);
    out.push(
      "",
      "---",
      `${s.llmCalls} звернень до моделі · ${s.toolCalls} викликів інструментів · ` +
        `${s.inputTokens}→${s.outputTokens} токенів · $${s.cost.toFixed(4)} · ${seconds}s` +
        (iteration ? ` · ітерацій: ${iteration + 1}` : ""),
      "",
      `<sub>деталі: \`devflow trace ${run.id}\`</sub>`,
    );
  }

  return out.join("\n");
}

export { priceOf };
