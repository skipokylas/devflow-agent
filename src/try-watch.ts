import fs from "node:fs/promises";
import type { Channel } from "./agent/channel";
import { demoLlm } from "./agent/llm";
import type { Deps } from "./agent/loop";
import { defaultTools } from "./agent/tools";
import { InMemoryBoard } from "./board/memory";
import type { Ticket, TicketRef } from "./board/types";
import { FileStorage } from "./db/storage";
import { recover, tick } from "./scheduler";
import { FileSink } from "./trace/sink";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const dir = ".runs/try-watch";
await fs.rm(dir, { recursive: true, force: true });

class Silent implements Channel {
  async ask(): Promise<void> {}
  async notify(): Promise<void> {}
}

const storage = new FileStorage(`${dir}/runs`);
const deps: Deps = {
  llm: demoLlm(),
  storage,
  trace: new FileSink(`${dir}/traces`),
  tools: defaultTools,
  channel: new Silent(),
  model: "fake",
  maxSteps: 8,
  root: process.cwd(),
};

const ref = (id: string): TicketRef => ({
  provider: "github",
  scope: "org/repo",
  externalId: id,
  url: `https://github.com/org/repo/issues/${id}`,
});

const ticket = (id: string, title: string): Ticket => ({
  ref: ref(id),
  title,
  body: "деталі задачі",
  status: "todo",
  labels: [],
  updatedAt: new Date(0).toISOString(),
});

const board = new InMemoryBoard([ticket("1", "додай magic links"), ticket("2", "додай rate limiting")]);
const log = (): void => {};

// 1. перший оберт: обидва квитки взяті, працює тільки один
await tick(deps, board, log);
let runs = await storage.list();
check("створено run на кожен квиток", runs.length === 2, `${runs.length}`);
check("квитки переведені з todo", (await board.ready()).length === 0);
check("один дійшов до паузи", runs.filter((r) => r.status === "waiting_human").length === 1);
check("другий чекає в черзі", runs.filter((r) => r.status === "queued").length === 1);

// 2. другий оберт: пауза не блокує — береться наступна задача
await tick(deps, board, log);
runs = await storage.list();
check("пауза не блокує чергу", runs.filter((r) => r.status === "waiting_human").length === 2);
check("нових runs не зʼявилось", runs.length === 2, `${runs.length}`);

// 3. людина відповідає коментарем під квитком
const first = runs.find((r) => r.ticket?.externalId === "1");
board.reply(ref("1"), "resend");
await tick(deps, board, log);

const afterAnswer = await storage.load(first?.id ?? "");
check("відповідь із коментаря продовжила run", afterAnswer.status === "done");
check("квиток переведений у in_review, не done", (await board.get(ref("1"))).status === "in_review");

const thread = await board.commentsSince(ref("1"), new Date(0).toISOString());
check("агент писав у квиток", thread.some((c) => c.mine && c.body.includes("Потрібна відповідь")));
check("звіт у квитку", thread.some((c) => c.mine && c.body.includes("### devflow")));

// 3a. звіт: один коментар, який редагується, а не низка нових
const reportRun = await storage.load(first?.id ?? "");
check("звіт створений і привʼязаний до run", reportRun.report !== null);

const mine = (await board.commentsSince(ref("1"), new Date(0).toISOString())).filter((c) => c.mine);
check("звіт один, не низка коментарів", mine.filter((c) => c.body.includes("### devflow")).length === 1,
  `${mine.length} своїх коментарів`);

const body = mine.find((c) => c.body.includes("### devflow"))?.body ?? "";
check("у звіті є текст задачі", body.includes("> Задача з квитка 1: додай magic links"));
check("у звіті є питання агента", body.includes("**Питання:**"));
check("у звіті є відповідь людини", body.includes("resend"));
check("у звіті є статус", body.includes("✅ готово"));

// 3b. доопрацювання завершеної задачі продовжує ту саму історію
const beforeRework = reportRun.messages.length;
board.reply(ref("1"), "додай ще перевірку на застарілі токени");
await tick(deps, board, log);

const reworked = await storage.load(first?.id ?? "");
check("доопрацювання додало повідомлення в ту саму історію", reworked.messages.length > beforeRework,
  `${beforeRework} → ${reworked.messages.length}`);
check("run не задвоївся", (await storage.list()).length === 2);
check("той самий коментар-звіт", reworked.report?.commentId === reportRun.report?.commentId);

const updated = (await board.commentsSince(ref("1"), new Date(0).toISOString()))
  .find((c) => c.id === reworked.report?.commentId)?.body ?? "";
check("у звіті зʼявилось уточнення", updated.includes("**Уточнення**"));
check("у звіті видно текст уточнення", updated.includes("застарілі токени"));

// 3c. finishStatus налаштовується
{
  const board2 = new InMemoryBoard([ticket("9", "інша задача")]);
  const storage2 = new FileStorage(`${dir}/runs2`);
  const deps2 = { ...deps, storage: storage2 };
  await tick(deps2, board2, log, undefined, "done");
  const run9 = (await storage2.list())[0];
  if (run9) await storage2.save({ ...run9, status: "waiting_human" });
  board2.reply(ref("9"), "так");
  await tick(deps2, board2, log, undefined, "done");
  check("з finishStatus done картка їде в done", (await board2.get(ref("9"))).status === "done");
}

// 3d. давній коментар, що існував до роботи агента, не запускає доопрацювання
{
  const board3 = new InMemoryBoard([ticket("7", "задача з історією")]);
  board3.reply(ref("7"), "коментар, написаний до того, як агент узявся за квиток");

  const storage3 = new FileStorage(`${dir}/runs3`);
  const deps3 = { ...deps, storage: storage3 };

  await tick(deps3, board3, log);           // взяв і дійшов до паузи
  const parked = (await storage3.list())[0];
  if (parked) await storage3.save({ ...parked, status: "done", pending: null });

  const before = (await storage3.load(parked?.id ?? "")).messages.length;
  await tick(deps3, board3, log);           // не має нічого переробляти
  const after = (await storage3.load(parked?.id ?? "")).messages.length;

  check("давній коментар не запускає доопрацювання", after === before, `${before} → ${after}`);
}

// 4. відновлення після простою
const second = (await storage.list()).find((r) => r.status === "waiting_human");
await storage.save({ ...(second as NonNullable<typeof second>), status: "running" });
await recover(deps, log);
const recovered = await storage.load(second?.id ?? "");
check("обірваний running повернувся в чергу", recovered.status === "queued");

// 5. повторний оберт не дублює квитки
const before = (await storage.list()).length;
await tick(deps, board, log);
check("дублів не створено", (await storage.list()).length === before, `${before}`);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
