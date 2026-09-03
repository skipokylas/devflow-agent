import { GitHubBoard } from "./board/github/board";
import type { Api } from "./board/github/http";
import type { TicketRef } from "./board/types";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Підроблений GitHub: перевіряємо мапінг статусів і розбір відповідей без мережі. */
const calls: string[] = [];
const issues: Record<number, unknown> = {
  7: {
    number: 7,
    node_id: "I_kw7",
    title: "додай magic links",
    body: "деталі",
    html_url: "https://github.com/org/repo/issues/7",
    updated_at: "2026-09-03T10:00:00Z",
    labels: [{ name: "feature" }],
  },
};
let statusOfItem = "Ready";

const api: Api = {
  async get<T>(path: string): Promise<T> {
    calls.push(`GET ${path}`);
    if (path === "/user") return { login: "devflow-bot" } as T;
    if (path.includes("/comments"))
      return [
        {
          id: 1,
          body: "**Потрібна відповідь.** Який провайдер?\n\n<!-- devflow run:r1 step:ask -->",
          created_at: "2026-09-03T10:05:00Z",
          user: { login: "skipokylas" },
        },
        { id: 2, body: "resend", created_at: "2026-09-03T10:07:00Z", user: { login: "skipokylas" } },
      ] as T;
    const n = Number(path.split("/").pop());
    return issues[n] as T;
  },
  async post<T>(path: string, body: unknown): Promise<T> {
    calls.push(`POST ${path} ${JSON.stringify(body)}`);
    return {} as T;
  },
  async patch<T>(): Promise<T> {
    return {} as T;
  },
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (query.includes("projectV2(number")) {
      return {
        user: {
          projectV2: {
            id: "PVT_1",
            field: {
              id: "PVTSSF_1",
              options: [
                { id: "opt_ready", name: "Ready" },
                { id: "opt_prog", name: "In progress" },
                { id: "opt_block", name: "Blocked" },
                { id: "opt_done", name: "Done" },
              ],
            },
          },
        },
      } as T;
    }
    if (query.includes("items(first")) {
      return {
        node: {
          items: {
            pageInfo: { hasNextPage: false, endCursor: "" },
            nodes: [{ id: "PVTI_1", fieldValueByName: { name: statusOfItem }, content: { number: 7 } }],
          },
        },
      } as T;
    }
    calls.push(`MUTATION ${JSON.stringify(variables)}`);
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } as T;
  },
};

const board = new GitHubBoard(
  {
    token: "test",
    scope: "org/repo",
    owner: "org",
    ownerType: "user",
    projectNumber: 3,
    statuses: { todo: "Ready", in_progress: "In progress", in_review: "In review", blocked: "Blocked", done: "Done" },
  },
  api,
);

const ref: TicketRef = {
  provider: "github",
  scope: "org/repo",
  externalId: "7",
  url: "https://github.com/org/repo/issues/7",
};

// 1. ready бере лише колонку, яка мапиться на todo
const ready = await board.ready();
check("ready знайшов квиток у колонці Ready", ready.length === 1);
check("issue розібраний у Ticket", ready[0]?.title === "додай magic links");
check(
  "посилання й мітки на місці",
  ready[0]?.ref.url.endsWith("/issues/7") === true && ready[0]?.labels[0] === "feature",
);

statusOfItem = "In progress";
check("картка в іншій колонці не потрапляє в ready", (await board.ready()).length === 0);
check("get мапить колонку назад у наш статус", (await board.get(ref)).status === "in_progress");

// 2. зміна статусу йде мутацією з правильним optionId
calls.length = 0;
await board.setStatus(ref, "blocked");
const mutation = calls.find((c) => c.startsWith("MUTATION"));
check("мутація містить optionId колонки Blocked", mutation?.includes("opt_block") === true, mutation ?? "немає");

// 3. свої коментарі відрізняються від чужих
const thread = await board.commentsSince(ref, "2026-09-03T10:00:00Z");
// Той самий логін в обох коментарях: під особистим токеном інакше й буває.
check("свій коментар пізнається за маркером", thread.find((c) => c.body.includes("Потрібна"))?.mine === true);
check("відповідь людини з тим самим логіном — не mine", thread.find((c) => c.body === "resend")?.mine === false);

// 4. невідома колонка падає зрозуміло, а не тихо
let clear = false;
try {
  await board.setStatus(ref, "in_review");
} catch (e) {
  clear = (e as Error).message.includes("немає колонки");
}
check("відсутня колонка → зрозуміла помилка", clear);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
