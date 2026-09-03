import { loadEnv } from "../env";

import { randomUUID } from "node:crypto";
import type { Channel } from "../agent/channel";
import { advance } from "../agent/loop";
import { promptOf } from "../agent/prompt";
import { newRun } from "../agent/run";
import type { Run } from "../agent/types";
import { buildDeps } from "../deps";
import { summary } from "../trace/render";

loadEnv();

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

const args = process.argv.slice(2);
const repeatFlag = args.indexOf("--repeat");
const repeats = repeatFlag === -1 ? 1 : Number(args[repeatFlag + 1] ?? 1);
const variants = repeatFlag === -1 ? args : args.slice(0, repeatFlag);
if (variants.length < 2) throw new Error("вкажи два варіанти: npm run ab -- v1 v3 --repeat 3");

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
   for (let attempt = 1; attempt <= repeats; attempt++) {
    const draft = newRun({
      id: `ab_${variant}_${randomUUID().slice(0, 6)}`,
      task: question,
    });

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
}

console.log(`\n\n${repeats} прогін(ів) на питання, ${QUESTIONS.length} питань, ${variants.length} варіанти\n`);
console.log("варіант  питання                                    посилання  читань  $/прогін");
for (const variant of variants) {
  for (const question of QUESTIONS) {
    const own = rows.filter((r) => r.variant === variant && r.question === question);
    const cited = own.filter((r) => r.cited).length;
    console.log(
      `${variant.padEnd(8)} ${question.slice(0, 42).padEnd(42)} ` +
        `${`${cited}/${own.length}`.padStart(9)} ${avg(own.map((r) => r.reads)).padStart(7)} ` +
        `  ${avg(own.map((r) => r.cost), 4).padStart(7)}`,
    );
  }
}

console.log("\nпідсумок:");
for (const variant of variants) {
  const own = rows.filter((r) => r.variant === variant);
  console.log(
    `  ${variant}: ${own.filter((r) => r.cited).length}/${own.length} із посиланням, ` +
      `${own.filter((r) => r.reads === 0).length} без жодного читання, ` +
      `$${own.reduce((n, r) => n + r.cost, 0).toFixed(4)} за все`,
  );
}

function avg(values: number[], digits = 1): string {
  if (values.length === 0) return "—";
  return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(digits);
}
