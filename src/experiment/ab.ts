import { randomUUID } from "node:crypto";
import type { Channel } from "../agent/channel";
import { advance } from "../agent/loop";
import { promptOf } from "../agent/prompt";
import type { Run } from "../agent/types";
import { buildDeps } from "../deps";
import { summary } from "../trace/render";

/**
 * A/B системних промптів на однакових питаннях. Витрачає реальні токени.
 * npm run ab -- v1 v2
 */

class QuietChannel implements Channel {
  async ask(): Promise<void> {}
  async notify(): Promise<void> {}
}

const QUESTIONS = [
  "що робить ask_human і чому він особливий?",
  "як зберігається стан агента між запусками?",
  "які інструменти доступні агенту?",
];

const variants = process.argv.slice(2);
if (variants.length < 2) throw new Error("вкажи два варіанти: npm run ab -- v1 v2");

type Row = {
  variant: string; question: string; llm: number; tools: number;
  reads: number; cited: boolean; cost: number;
};

/** Ближчий до якості проксі, ніж кількість читань: чи послалась відповідь на файл. */
function citesFile(run: Run): boolean {
  const last = run.messages[run.messages.length - 1];
  if (!last || typeof last.content === "string") return /src\/[\w./-]+\.ts/.test(String(last?.content ?? ""));
  const text = last.content.map((b) => ("text" in b ? b.text : "")).join(" ");
  return /src\/[\w./-]+\.ts/.test(text);
}
const rows: Row[] = [];

for (const variant of variants) {
  const deps = buildDeps({
    channel: new QuietChannel(),
    system: promptOf(variant),
    model: process.env["MODEL"] ?? "claude-haiku-4-5",
    maxSteps: Number(process.env["MAX_STEPS"] ?? 6),
  });

  for (const question of QUESTIONS) {
    const draft: Run = {
      id: `ab_${variant}_${randomUUID().slice(0, 6)}`,
      status: "running",
      messages: [{ role: "user", content: question }],
      pending: null,
      error: null,
      version: 0,
    };

    const run = await advance(await deps.storage.create(draft), deps);
    const spans = await deps.trace.read(run.id);
    const s = summary(spans);
    rows.push({
      variant,
      question,
      llm: s.llmCalls,
      tools: s.toolCalls,
      reads: spans.filter((x) => x.type === "tool_call" && x.name === "read_file").length,
      cited: citesFile(run),
      cost: s.cost,
    });
    process.stdout.write(".");
  }
}

console.log("\n");
console.log("варіант  llm  інстр  read_file  посилання       $   питання");
for (const r of rows) {
  console.log(
    `${r.variant.padEnd(8)} ${String(r.llm).padStart(3)} ${String(r.tools).padStart(6)} ` +
      `${String(r.reads).padStart(10)} ${(r.cited ? "так" : "—").padStart(10)}  ` +
      `${r.cost.toFixed(4)}  ${r.question.slice(0, 42)}`,
  );
}

console.log("\nпідсумок:");
for (const variant of variants) {
  const own = rows.filter((r) => r.variant === variant);
  const noRead = own.filter((r) => r.reads === 0).length;
  console.log(
    `  ${variant}: ${own.filter((r) => r.cited).length}/${own.length} відповідей із посиланням, ` +
      `${own.reduce((n, r) => n + r.reads, 0)} читань, ${noRead} без жодного читання, ` +
      `$${own.reduce((n, r) => n + r.cost, 0).toFixed(4)}`,
  );
}
