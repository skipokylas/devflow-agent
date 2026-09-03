import fs from "node:fs/promises";
import { ZodError } from "zod";
import { FileStorage, RunAlreadyExists, RunNotFound, VersionConflict } from "./db/storage";
import type { Run } from "./agent/types";

const dir = ".runs/try";
await fs.rm(dir, { recursive: true, force: true });
const storage = new FileStorage(dir);

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function expectError<T>(fn: () => Promise<unknown>, ctor: new (...a: never[]) => T) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof ctor ? err : Promise.reject(err);
  }
}

const draft: Run = {
  id: "run_demo",
  status: "running",
  messages: [{ role: "user", content: "додай passwordless-авторизацію" }],
  pending: null,
  error: null,
  ticket: null,
  version: 0,
};

// 1. create
let run = await storage.create(draft);
const file = `${dir}/run_demo.json`;
check("create → version 1", run.version === 1);
check("create → файл на диску", await fs.stat(file).then(() => true, () => false));

// 2. save піднімає версію
run.messages.push({ role: "assistant", content: "Який провайдер пошти?" });
run.status = "waiting_human";
run = await storage.save(run);
check("save → version 2", run.version === 2);

// 3. load — імітація іншого процесу
const reloaded = await storage.load("run_demo");
check("load → історія збережена", reloaded.messages.length === 2, `${reloaded.messages.length} повідомлення`);
check("load → статус збережений", reloaded.status === "waiting_human");

// 4. запис зі старою версією
const stale: Run = { ...reloaded, version: 1 };
check(
  "save зі старою версією → VersionConflict",
  (await expectError(() => storage.save(stale), VersionConflict)) !== null,
);
check("після конфлікту файл не змінився", (await storage.load("run_demo")).version === 2);

// 5. неіснуючий run
check(
  "load неіснуючого → RunNotFound",
  (await expectError(() => storage.load("run_нема"), RunNotFound)) !== null,
);

// 6. повторний create
check(
  "create того самого id → RunAlreadyExists",
  (await expectError(() => storage.create(draft), RunAlreadyExists)) !== null,
);

// 7. list бачить усі runs
await storage.create({ ...draft, id: "run_second", version: 0 });
const all = await storage.list();
check("list повертає обидва runs", all.length === 2, `${all.length}`);
check("list парсить кожен через схему", all.every((r) => typeof r.status === "string"));

// 8. зіпсований файл ловиться схемою, а не десь далі
const broken = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
broken["status"] = "зламано";
await fs.writeFile(file, JSON.stringify(broken));
check(
  "невалідний status → ZodError на load",
  (await expectError(() => storage.load("run_demo"), ZodError)) !== null,
);

// 9. один зіпсований файл не ховає решту від list
const afterBreak = await storage.list();
check("list переживає зіпсований файл", afterBreak.length === 1, `${afterBreak.length} з 2`);

// 10. у теці не лишилось .tmp-файлів
const left = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
check("тимчасові файли прибрані", left.length === 0, `${left.length} .tmp`);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
