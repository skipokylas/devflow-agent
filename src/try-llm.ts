import { fakeText, fakeToolUse, scriptedLlm } from "./agent/llm";
import type { LlmParams } from "./agent/llm";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const params: LlmParams = {
  model: "claude-opus-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "додай magic links" }],
};

const llm = scriptedLlm([
  fakeToolUse("ask_human", { question: "Який провайдер пошти?" }, "toolu_1"),
  fakeText("План готовий."),
]);

// 1. перша відповідь — запит на інструмент
const first = await llm(params);
check("виклик 1 → stop_reason tool_use", first.stop_reason === "tool_use");
const block = first.content[0];
check("виклик 1 → блок tool_use з id", block?.type === "tool_use" && block.id === "toolu_1");
check(
  "виклик 1 → input дійшов",
  block?.type === "tool_use" &&
    (block.input as { question?: string }).question === "Який провайдер пошти?",
);

// 2. друга — текст, цикл завершується
const second = await llm(params);
check("виклик 2 → stop_reason end_turn", second.stop_reason === "end_turn");
check("виклик 2 → текстовий блок", second.content[0]?.type === "text");

// 3. скрипт вичерпано — гучна помилка, а не тиха undefined
let threw = false;
try {
  await llm(params);
} catch {
  threw = true;
}
check("виклик 3 → скрипт вичерпано, кидає помилку", threw);

// 4. мережі не було: жодного токена
check("токени не витрачені", first.usage.input_tokens === 0 && first.usage.output_tokens === 0);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
