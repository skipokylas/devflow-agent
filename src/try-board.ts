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
await board.comment(ref, "Який провайдер пошти?\n\n<!-- devflow run:r1 step:ask -->");
board.reply(ref, "resend");

const thread = await board.commentsSince(ref, start);
check("у треді два коментарі", thread.length === 2, `${thread.length}`);
check("свій коментар пізнається за маркером у тілі", thread[0]?.mine === true);
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

// 5. створення підзадач: маркер робить повторний прогін безпечним
{
  const { createIssuesTool } = await import("./agent/tools-board");
  const { ToolRegistry } = await import("./agent/tools");

  const fresh = new InMemoryBoard();
  const registry = new ToolRegistry([createIssuesTool(fresh, "run_plan")]);
  const ctx = { runId: "run_plan", root: process.cwd(), approvedActions: new Set(["create_issues"]) };

  const plan = {
    tasks: [
      { title: "додати таблицю magic_links", body: "потрібна для зберігання одноразових токенів" },
      { title: "додати POST /auth/request", body: "видає токен і шле лист; перевірка — тест на 202" },
    ],
  };

  const first = await registry.execute("create_issues", plan, ctx);
  check("створено дві підзадачі", (await fresh.ready()).length === 2, first.replace(/\n/g, " | "));
  check("у відповіді номери issues", /#\d+ створено/.test(first));

  const again = await registry.execute("create_issues", plan, ctx);
  check("повторний виклик не дублює", (await fresh.ready()).length === 2);
  check("повторний виклик каже «вже існує»", again.includes("вже існує"));

  // 6. схема плану відкидає халтуру ще до створення
  const bad = [
    { tasks: [] },
    { tasks: [{ title: "коротко", body: "теж коротко" }] },
    { tasks: [{ title: "нормальний заголовок задачі", body: "мало" }] },
  ];
  let rejected = 0;
  for (const input of bad) {
    try {
      await registry.execute("create_issues", input, ctx);
    } catch {
      rejected++;
    }
  }
  check("порожній план і халтурні задачі відкидаються", rejected === 3, `${rejected} з 3`);
  check("нічого зайвого не створено", (await fresh.ready()).length === 2);
}

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
