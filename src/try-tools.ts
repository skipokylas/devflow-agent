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
check("три інструменти в реєстрі", defs.length === 3);
check("у схеми є required", Array.isArray(defs[2]?.input_schema["required"]));

// 2. Реальний виклик
const content = await defaultTools.execute("read_file", { path: "package.json" }, ctx);
check("read_file повернув вміст", content.includes("devflow-agent"));

// 2a. list_files бачить структуру і пропускає службові теки
const tree = await defaultTools.execute("list_files", { path: "src", depth: 2 }, ctx);
check("list_files знайшов agent/", tree.includes("agent/"));
check("list_files знайшов вкладений файл", tree.includes("loop.ts"));
const root = await defaultTools.execute("list_files", {}, ctx);
check("list_files пропускає node_modules", !root.includes("node_modules"));
check("list_files працює з кореня без аргументів", root.includes("package.json"));

let outside = false;
try {
  await defaultTools.execute("list_files", { path: "../.." }, ctx);
} catch {
  outside = true;
}
check("list_files за межі кореня → відмова", outside);

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

// 8. усі варіанти промпта валідні й типовий існує
{
  const { PROMPTS, promptOf } = await import("./agent/prompt");
  check("варіантів промпта більше одного", Object.keys(PROMPTS).length >= 2);
  check("типовий варіант існує", promptOf("v6").length > 0);

  let unknown = false;
  try {
    promptOf("v999");
  } catch {
    unknown = true;
  }
  check("невідомий варіант → помилка з переліком", unknown);

  const v6 = promptOf("v6");
  check("v6 вчить перевіряти зміни", v6.includes("run_command typecheck"));
  check("v6 забороняє git-команди для PR", v6.includes("Гілку, коміт і PR робить не ти"));
  check("v6 задає мову відповіді", v6.includes("українською"));
}

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
