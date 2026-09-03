import { NotApproved, UnknownTool, defaultTools, defineTool } from "./agent/tools";
import type { ToolContext } from "./agent/tools";
import { z } from "zod";
import { ToolRegistry } from "./agent/tools";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const ctx: ToolContext = { runId: "run_test", root: process.cwd(), approvedActions: new Set() };

// 1. Що бачить модель
const defs = defaultTools.definitions();
console.log("\nоголошення, які підуть у запит:");
console.log(JSON.stringify(defs, null, 2).slice(0, 700), "…\n");
check("два інструменти в реєстрі", defs.length === 2);
check("у схеми є required", Array.isArray(defs[1]?.input_schema["required"]));

// 2. Реальний виклик
const content = await defaultTools.execute("read_file", { path: "package.json" }, ctx);
check("read_file повернув вміст", content.includes("devflow-agent"));

// 3. Модель надіслала кривий аргумент
let zodErr = false;
try {
  await defaultTools.execute("read_file", { path: 42 }, ctx);
} catch {
  zodErr = true;
}
check("невалідний input → помилка від zod", zodErr);

// 4. Спроба вийти за межі проєкту
let escaped = false;
try {
  await defaultTools.execute("read_file", { path: "../../.ssh/id_rsa" }, ctx);
} catch {
  escaped = true;
}
check("шлях за межі кореня → відмова", escaped);

// 5. Неіснуючий інструмент
let unknown = false;
try {
  await defaultTools.execute("delete_everything", {}, ctx);
} catch (e) {
  unknown = e instanceof UnknownTool;
}
check("невідомий інструмент → UnknownTool", unknown);

// 6. ask_human реєстр не виконує
let askGuard = false;
try {
  await defaultTools.execute("ask_human", { question: "?" }, ctx);
} catch {
  askGuard = true;
}
check("ask_human реєстром не виконується", askGuard);

// 7. write-інструмент без дозволу
const createIssue = defineTool({
  name: "create_issue",
  description: "Створити issue",
  access: "write",
  input: z.object({ title: z.string() }),
  execute: async () => "створено",
});
const withWrite = new ToolRegistry([createIssue]);

let blocked = false;
try {
  await withWrite.execute("create_issue", { title: "тест" }, ctx);
} catch (e) {
  blocked = e instanceof NotApproved;
}
check("write без дозволу → NotApproved", blocked);

const approved = await withWrite.execute("create_issue", { title: "тест" }, {
  ...ctx,
  approvedActions: new Set(["create_issue"]),
});
check("write з дозволом → виконується", approved === "створено");

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
