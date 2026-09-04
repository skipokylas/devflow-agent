import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { codingTools } from "./agent/tools";
import { changedFiles, createWorkspace, removeIfClean } from "./workspace";

const run = promisify(execFile);
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

// Справжній git-репозиторій у тимчасовій теці: worktree на підробці не перевіриш.
const base = await fs.mkdtemp(path.join(os.tmpdir(), "devflow-ws-"));
const repo = path.join(base, "repo");
await fs.mkdir(repo, { recursive: true });
await run("git", ["init", "-b", "main", "-q"], { cwd: repo });
await run("git", ["config", "user.email", "t@t"], { cwd: repo });
await run("git", ["config", "user.name", "t"], { cwd: repo });
await fs.writeFile(path.join(repo, "a.txt"), "перший рядок\nдругий рядок\n");
await run("git", ["add", "-A"], { cwd: repo });
await run("git", ["commit", "-qm", "init"], { cwd: repo });

// 1. окрема копія, спільна історія
const ws = await createWorkspace(repo, "run_ws", path.join(base, "wt"));
check("робоча копія створена", await fs.stat(ws.path).then(() => true, () => false));
check("гілка названа за run", ws.branch === "devflow/run_ws");
check("файли на місці", (await fs.readFile(path.join(ws.path, "a.txt"), "utf8")).includes("перший"));

// 1a. залежності доступні в копії: без них ворота якості падали б завжди
await fs.mkdir(path.join(repo, "node_modules", "@types"), { recursive: true });
await fs.writeFile(path.join(repo, "node_modules", "marker.txt"), "залежність");
const ws2 = await createWorkspace(repo, "run_deps", path.join(base, "wt"));
check(
  "node_modules видно з робочої копії",
  await fs.readFile(path.join(ws2.path, "node_modules", "marker.txt"), "utf8").then(
    (t) => t === "залежність",
    () => false,
  ),
);

// 2. повторний виклик не падає, а підхоплює наявне
const again = await createWorkspace(repo, "run_ws", path.join(base, "wt"));
check("повторний виклик підхоплює наявне дерево", again.path === ws.path);

// 3. правки не торкаються основної теки
const ctx = { runId: "run_ws", root: ws.path, approvedActions: new Set(["write_file", "edit_file", "run_command"]) };
await codingTools.execute("write_file", { path: "src/new.ts", content: "export const x = 1;\n" }, ctx);
await codingTools.execute("edit_file", { path: "a.txt", old: "другий рядок", new: "змінений рядок" }, ctx);

check("новий файл у робочій копії", await fs.stat(path.join(ws.path, "src/new.ts")).then(() => true, () => false));
check("основна тека не зачеплена", !(await fs.stat(path.join(repo, "src/new.ts")).then(() => true, () => false)));
check("основний a.txt не змінено", (await fs.readFile(path.join(repo, "a.txt"), "utf8")).includes("другий рядок"));
check("зміни видно через git", (await changedFiles(ws)).length === 2, (await changedFiles(ws)).join(", "));

// 4. неоднозначна правка відхиляється, а не робить навмання
await fs.writeFile(path.join(ws.path, "dup.txt"), "повтор\nповтор\n");
let ambiguous = "";
try {
  await codingTools.execute("edit_file", { path: "dup.txt", old: "повтор", new: "інше" }, ctx);
} catch (e) {
  ambiguous = (e as Error).message;
}
check("неоднозначний фрагмент відхилено", ambiguous.includes("2 рази"), ambiguous);

let missing = "";
try {
  await codingTools.execute("edit_file", { path: "a.txt", old: "нема такого", new: "x" }, ctx);
} catch (e) {
  missing = (e as Error).message;
}
check("відсутній фрагмент → зрозуміла помилка", missing.includes("не знайдено"));

// 5. довільні команди не приймаються
let rejected = false;
try {
  await codingTools.execute("run_command", { command: "rm -rf /" }, ctx);
} catch {
  rejected = true;
}
check("команда поза переліком відхилена", rejected);

// 6. прибирання
check("дерево зі змінами не прибирається", (await removeIfClean(repo, ws)) === false);

const clean = await createWorkspace(repo, "run_clean", path.join(base, "wt"));
check("чисте дерево прибирається", (await removeIfClean(repo, clean)) === true);
check("тека справді зникла", !(await fs.stat(clean.path).then(() => true, () => false)));

await fs.rm(base, { recursive: true, force: true });
console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
