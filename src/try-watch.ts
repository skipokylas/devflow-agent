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
check("квиток переведений у done", (await board.get(ref("1"))).status === "done");

const thread = await board.commentsSince(ref("1"), new Date(0).toISOString());
check("агент писав у квиток", thread.some((c) => c.mine && c.body.includes("Потрібна відповідь")));
check("звіт у квитку", thread.some((c) => c.mine && c.body.startsWith("### devflow")));

// 3a. звіт: один коментар, який редагується, а не низка нових
const reportRun = await storage.load(first?.id ?? "");
check("звіт створений і привʼязаний до run", reportRun.report !== null);

const mine = (await board.commentsSince(ref("1"), new Date(0).toISOString())).filter((c) => c.mine);
check("звіт один, не низка коментарів", mine.filter((c) => c.body.startsWith("### devflow")).length === 1,
  `${mine.length} своїх коментарів`);

const body = mine.find((c) => c.body.startsWith("### devflow"))?.body ?? "";
check("у звіті є задача", body.includes("**Задача**"));
check("у звіті є питання агента", body.includes("**Питання:**"));
check("у звіті є відповідь людини", body.includes("resend"));
check("у звіті є підсумок статусу", body.includes("готово"));

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
check("у звіті зʼявилось уточнення", updated.includes("Уточнення від тебе"));
check("у звіті видно текст уточнення", updated.includes("застарілі токени"));

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
