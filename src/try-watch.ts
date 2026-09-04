import fs from "node:fs/promises";
import type { Channel } from "./agent/channel";
import { demoLlm, fakeText, fakeToolUse, scriptedLlm } from "./agent/llm";
import type { Deps } from "./agent/loop";
import { defaultTools } from "./agent/tools";
import { InMemoryBoard } from "./board/memory";
import type { Ticket, TicketRef } from "./board/types";
import { FileStorage } from "./db/storage";
import { recover, tick, type Ctx } from "./scheduler";
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

/** Один конструктор контексту на всі сценарії: інакше кожен збирав би свій. */
const ctxFor = (over: Partial<Ctx> & { board: Ctx["board"] }): Ctx => ({
  deps,
  repo: undefined,
  log,
  finishStatus: "in_review",
  ...over,
});

// 1. перший оберт: обидва квитки взяті, працює тільки один
await tick(ctxFor({ board: board, deps: deps }));
let runs = await storage.list();
check("створено run на кожен квиток", runs.length === 2, `${runs.length}`);
check("перший квиток узятий у роботу", (await board.get(ref("1"))).status !== "todo");
check("обидва пішли з Ready", (await board.ready()).length === 0);
check("один оберт розбирає всю чергу", runs.filter((r) => r.status === "waiting_human").length === 2,
  runs.map((r) => r.status).join(", "));
check("у черзі нічого не лишилось", runs.filter((r) => r.status === "queued").length === 0);

// 2. повторний оберт нічого не змінює
await tick(ctxFor({ board: board, deps: deps }));
runs = await storage.list();
check("нових runs не зʼявилось", runs.length === 2, `${runs.length}`);

// 3. людина відповідає коментарем під квитком
const first = runs.find((r) => r.ticket?.externalId === "1");
board.reply(ref("1"), "resend");
await tick(ctxFor({ board: board, deps: deps }));

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
await tick(ctxFor({ board: board, deps: deps }));

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
  await tick(ctxFor({ board: board2, deps: deps2, finishStatus: "done" }));
  const run9 = (await storage2.list())[0];
  if (run9) await storage2.save({ ...run9, status: "waiting_human" });
  board2.reply(ref("9"), "так");
  await tick(ctxFor({ board: board2, deps: deps2, finishStatus: "done" }));
  check("з finishStatus done картка їде в done", (await board2.get(ref("9"))).status === "done");
}

// 3d. давній коментар, що існував до роботи агента, не запускає доопрацювання
{
  const board3 = new InMemoryBoard([ticket("7", "задача з історією")]);
  board3.reply(ref("7"), "коментар, написаний до того, як агент узявся за квиток");

  const storage3 = new FileStorage(`${dir}/runs3`);
  const deps3 = { ...deps, storage: storage3 };

  await tick(ctxFor({ board: board3, deps: deps3 }));           // взяв і дійшов до паузи
  const parked = (await storage3.list())[0];
  if (parked) await storage3.save({ ...parked, status: "done", pending: null });

  const before = (await storage3.load(parked?.id ?? "")).messages.length;
  await tick(ctxFor({ board: board3, deps: deps3 }));           // не має нічого переробляти
  const after = (await storage3.load(parked?.id ?? "")).messages.length;

  check("давній коментар не запускає доопрацювання", after === before, `${before} → ${after}`);
}

// 3e. наскрізний план: ворота зупиняють, згода створює підзадачі
{
  const planBoard = new InMemoryBoard([ticket("42", "зробити passwordless-авторизацію")]);
  const storage4 = new FileStorage(`${dir}/runs4`);

  const plan = {
    tasks: [
      { title: "додати таблицю magic_links", body: "зберігає одноразові токени з терміном дії" },
      { title: "додати POST /auth/request", body: "видає токен і шле лист; перевірка — тест на 202" },
    ],
  };

  const llm = scriptedLlm([
    fakeToolUse("create_issues", plan, "t_plan"),
    fakeText("Створив дві підзадачі."),
  ]);
  const deps4: Deps = { ...deps, storage: storage4, llm };

  await tick(ctxFor({ board: planBoard, deps: deps4 }));
  const planned = (await storage4.list())[0];
  check("план зупинився на воротах", planned?.status === "waiting_human");
  check("підзадач ще немає", (await planBoard.ready()).length === 0, `${(await planBoard.ready()).length}`);
  check("питання показує дію", planned?.pending?.approval?.tool === "create_issues");

  planBoard.reply(ref("42"), "так");
  await tick(ctxFor({ board: planBoard, deps: deps4 }));
  check("після згоди підзадачі створені", (await planBoard.findByMarker("task:2")) !== null);
  check("підзадачі не потрапили в чергу", (await planBoard.ready()).length === 0);
}

// 3f. видалений квиток не блокує чергу
{
  const { TicketGone } = await import("./board/board");
  const storage5 = new FileStorage(`${dir}/runs5`);

  const broken = new InMemoryBoard([ticket("50", "квиток, який зникне"), ticket("51", "живий квиток")]);
  const original = broken.commentsSince.bind(broken);
  broken.commentsSince = async (r, since) => {
    if (r.externalId === "50") throw new TicketGone("50");
    return original(r, since);
  };

  const deps5: Deps = { ...deps, storage: storage5 };
  await tick(ctxFor({ board: broken, deps: deps5 }));                       // взяв обидва, попрацював над першим
  const gone = (await storage5.list()).find((r) => r.ticket?.externalId === "50");
  if (gone) await storage5.save({ ...gone, status: "waiting_human", lastCommentAt: new Date(0).toISOString() });

  await tick(ctxFor({ board: broken, deps: deps5 }));
  const after = await storage5.load(gone?.id ?? "");
  check("зниклий квиток → run позначено failed", after.status === "failed", after.status);
  check("причина записана", after.error?.includes("недоступний") === true, after.error ?? "");
  check("другий квиток усе одно опрацьовано", (await storage5.list()).some((r) => r.ticket?.externalId === "51" && r.status !== "queued"));
}

// 3g. виконання: правки в робочій копії → ворота → PR
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const exec = promisify(execFile);

  const sandbox = await fs.mkdtemp(nodePath.join(os.tmpdir(), "devflow-exec-"));
  const repoDir = nodePath.join(sandbox, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  await exec("git", ["init", "-b", "main", "-q"], { cwd: repoDir });
  await exec("git", ["config", "user.email", "t@t"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "t"], { cwd: repoDir });
  await fs.writeFile(nodePath.join(repoDir, "readme.md"), "початок\n");
  await exec("git", ["add", "-A"], { cwd: repoDir });
  await exec("git", ["commit", "-qm", "init"], { cwd: repoDir });

  // Тека стану задається тут, а не ззовні: перевірка не має залежати від оточення.
  const previousStateDir = process.env["AGENT_STATE_DIR"];
  process.env["AGENT_STATE_DIR"] = sandbox;

  const { InMemoryForge } = await import("./forge/memory");
  const forge = new InMemoryForge();
  const execBoard = new InMemoryBoard([ticket("77", "додати файл")]);
  const storage6 = new FileStorage(`${dir}/runs6`);

  // Модель пише файл, дозвіл уже дано, потім звітує.
  const llm = scriptedLlm([
    fakeToolUse("write_file", { path: "added.ts", content: "export const a = 1;\n" }, "t_w"),
    fakeText("Файл додано."),
  ]);

  const deps6: Deps = { ...deps, storage: storage6, llm, root: repoDir };
  const repoRef = { id: "test", root: repoDir, remote: null };

  await tick(ctxFor({ board: execBoard, forge, deps: deps6, repo: repoRef }));
  const gated = (await storage6.list())[0];
  check("write_file зупинився на воротах", gated?.status === "waiting_human");

  execBoard.reply(ref("77"), "так");
  await tick(ctxFor({ board: execBoard, forge, deps: deps6, repo: repoRef }));

  const wt = nodePath.join(process.env["AGENT_STATE_DIR"] ?? "", "");
  const done6 = await storage6.load(gated?.id ?? "");
  check("робота завершилась", done6.status === "done" || done6.status === "waiting_human", done6.status);
  check("основна тека не змінена", !(await fs.stat(nodePath.join(repoDir, "added.ts")).then(() => true, () => false)));
  check("без токена PR не створюється", forge.pulls.length === 0);

  // правки лишились у робочій копії, а не зникли
  const wtDir = nodePath.join(sandbox, "test", "wt", gated?.id ?? "");
  const inWorkspace = await fs
    .readFile(nodePath.join(wtDir, "added.ts"), "utf8")
    .then((t) => t.includes("export const a"), () => false);
  check("правка збережена в робочій копії", inWorkspace, wtDir);

  // 3i. ворота: провалений typecheck повертається в модель
  {
    // Окремий репозиторій: поламаний typecheck не має псувати сусідні сценарії.
    const gateRepo = nodePath.join(sandbox, "gate-repo");
    await fs.mkdir(gateRepo, { recursive: true });
    await exec("git", ["init", "-b", "main", "-q"], { cwd: gateRepo });
    await exec("git", ["config", "user.email", "t@t"], { cwd: gateRepo });
    await exec("git", ["config", "user.name", "t"], { cwd: gateRepo });
    await fs.writeFile(
      nodePath.join(gateRepo, "package.json"),
      JSON.stringify({ name: "t", scripts: { typecheck: "node -e \"process.exit(1)\"" } }),
    );
    await exec("git", ["add", "-A"], { cwd: gateRepo });
    await exec("git", ["commit", "-qm", "init"], { cwd: gateRepo });

    const board3 = new InMemoryBoard([ticket("79", "правка з поламаною перевіркою")]);
    const storage8 = new FileStorage(`${dir}/runs8`);

    let seenFailure = "";
    const llm3: Deps["llm"] = async ({ messages }) => {
      const last = messages[messages.length - 1];
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("typecheck не пройшла")) {
        seenFailure = text;
        return fakeText("Виправив.");
      }
      return messages.length <= 1
        ? fakeToolUse("write_file", { path: "third.ts", content: "export const c = 3;\n" }, "t_w3")
        : fakeText("Готово.");
    };

    const deps8: Deps = { ...deps, storage: storage8, llm: llm3, root: gateRepo };
    const repo8 = { id: "gate", root: gateRepo, remote: null };

    await tick(ctxFor({ board: board3, deps: deps8, repo: repo8 }));
    board3.reply(ref("79"), "так");
    await tick(ctxFor({ board: board3, deps: deps8, repo: repo8 }));

    check("провал воріт повернувся в модель", seenFailure.includes("typecheck не пройшла"), seenFailure.slice(0, 40));
    check("модель отримала вивід команди", seenFailure.includes("помилкою"));
  }

  // 3h. з remote і forge зміни доїжджають до PR
  {
    await exec("git", ["remote", "add", "origin", "https://example.invalid/org/repo.git"], { cwd: repoDir });
    const withRemote = { id: "test", root: repoDir, remote: "https://example.invalid/org/repo.git" };

    const board2 = new InMemoryBoard([ticket("78", "ще одна правка")]);
    const forge2 = new InMemoryForge();
    const storage7 = new FileStorage(`${dir}/runs7`);
    const llm2 = scriptedLlm([
      fakeToolUse("write_file", { path: "second.ts", content: "export const b = 2;\n" }, "t_w2"),
      fakeText("Готово."),
    ]);

    const deps7: Deps = { ...deps, storage: storage7, llm: llm2, root: repoDir };
    await tick(ctxFor({ board: board2, forge: forge2, deps: deps7, repo: withRemote }));
    const paused = (await storage7.list())[0];
    board2.reply(ref("78"), "так");
    await tick(ctxFor({ board: board2, forge: forge2, deps: deps7, repo: withRemote }));

    check("гілка запушена", forge2.pushed.length === 1, `${forge2.pushed.length}`);
    check("PR відкрито", forge2.pulls.length === 1, `${forge2.pulls.length}`);
    check("PR із гілки прогону", forge2.pulls[0]?.branch === `devflow/${paused?.id}`, forge2.pulls[0]?.branch ?? "");
    check("PR у базову гілку", forge2.pulls[0]?.base === "main");
  }

  if (previousStateDir === undefined) delete process.env["AGENT_STATE_DIR"];
  else process.env["AGENT_STATE_DIR"] = previousStateDir;

  await fs.rm(sandbox, { recursive: true, force: true });
}

// 4. відновлення після простою
const second = (await storage.list()).find((r) => r.status === "waiting_human");
await storage.save({ ...(second as NonNullable<typeof second>), status: "running" });
await recover(deps, log);
const recovered = await storage.load(second?.id ?? "");
check("обірваний running повернувся в чергу", recovered.status === "queued");

// 5. повторний оберт не дублює квитки
const before = (await storage.list()).length;
await tick(ctxFor({ board: board, deps: deps }));
check("дублів не створено", (await storage.list()).length === before, `${before}`);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
