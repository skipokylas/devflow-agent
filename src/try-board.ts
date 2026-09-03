import { hasMarker, marker } from "./board/board";
import { InMemoryBoard } from "./board/memory";
import type { Ticket, TicketRef } from "./board/types";
import { ticketRefSchema } from "./board/types";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const ref: TicketRef = {
  provider: "github",
  scope: "skipokylas/devflow-agent",
  externalId: "142",
  url: "https://github.com/skipokylas/devflow-agent/issues/142",
};

const ticket: Ticket = {
  ref,
  title: "додати passwordless-авторизацію",
  body: "через email magic links",
  status: "todo",
  labels: ["feature"],
  updatedAt: new Date(0).toISOString(),
};

const board = new InMemoryBoard([ticket]);

// 1. планувальник бачить лише готові
check("ready віддає квитки зі статусом todo", (await board.ready()).length === 1);
await board.setStatus(ref, "in_progress");
check("після setStatus квиток зникає з ready", (await board.ready()).length === 0);
check("статус збережений", (await board.get(ref)).status === "in_progress");

// 2. канал: агент питає, людина відповідає
const start = new Date(0).toISOString();
await board.comment(ref, "Який провайдер пошти?");
board.reply(ref, "resend");

const thread = await board.commentsSince(ref, start);
check("у треді два коментарі", thread.length === 2, `${thread.length}`);
check("свій коментар позначений mine", thread[0]?.mine === true);
check("відповідь людини не mine", thread[1]?.mine === false);
check("відповідь людини знайдена", thread.find((c) => !c.mine)?.body === "resend");

// 3. ідемпотентність за маркером
const body = `створено issue\n${marker("run_1", "task:4")}`;
check("маркер знаходиться в тілі", hasMarker(body, "run_1", "task:4"));
check("чужий маркер не збігається", !hasMarker(body, "run_2", "task:4"));

// 4. схема відкидає криве посилання
const bad = ticketRefSchema.safeParse({ ...ref, provider: "jira" });
check("невідомий провайдер → помилка схеми", !bad.success);
const noUrl = ticketRefSchema.safeParse({ ...ref, url: "не-url" });
check("невалідний url → помилка схеми", !noUrl.success);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
