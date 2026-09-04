import { advance, resume, type Deps } from "./agent/loop";
import { newRun } from "./agent/run";
import { toolsWithBoard } from "./agent/tools-board";
import { codingTools } from "./agent/tools";
import {
  baseBranch,
  changedFiles,
  commitAll,
  createWorkspace,
  removeIfClean,
  type Workspace,
} from "./workspace";
import { stateDir, type RepoRef } from "./repo";
import { untrusted } from "./agent/tools";
import type { Run } from "./agent/types";
import type { Board } from "./board/board";
import type { Forge } from "./forge/forge";
import type { Ticket, TicketRef, TicketStatus } from "./board/types";
import { BoardChannel } from "./channel/board";
import fs from "node:fs/promises";
import path from "node:path";
import { renderReport } from "./report";
import { TicketGone } from "./board/board";
import { LiveChannel } from "./channel/live";
import { bindingOf } from "./guard";

/** Куди переводити картку після успішного завершення. */
export type SchedulerOptions = { finishStatus?: "in_review" | "done" };

export type WatchOptions = {
  intervalMs: number;
  /** Один оберт замість нескінченного циклу — для сценаріїв перевірки. */
  once?: boolean;
  log?: (line: string) => void;
};

const same = (a: TicketRef, b: TicketRef): boolean =>
  a.provider === b.provider && a.scope === b.scope && a.externalId === b.externalId;

const active = (run: Run): boolean => run.status !== "done" && run.status !== "failed";

/**
 * Один агент, одна активна робота. Але «чекає на людину» — не робота: щойно run
 * стає waiting_human, планувальник вільний і бере наступний квиток.
 */
/** Дошка й forge разом: дві різні системи, які планувальник використовує поруч. */
export type Services = { board: Board; forge?: Forge };

/**
 * Усе, що потрібно оберту. Раніше це були шість-вісім параметрів, які
 * протягувались крізь пʼять функцій — сигнатури такої довжини означають
 * сутність, якій не дали назви.
 */
export type Ctx = {
  deps: Deps;
  board: Board;
  forge?: Forge;
  repo?: RepoRef;
  log: (line: string) => void;
  finishStatus: TicketStatus;
};

export async function tick(ctx: Ctx): Promise<void> {
  await intake(ctx);
  await collectAnswers(ctx);
  await advanceQueue(ctx);
}

export async function watch(ctx: Ctx, opts: WatchOptions): Promise<void> {
  await recover(ctx.deps, ctx.log);

  for (;;) {
    await tick(ctx);
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/**
 * Відповідь із термінала. Раніше CLI викликав resume напряму, повз execute —
 * тобто без робочої копії, воріт і доставки: правки лягали в теку користувача,
 * а PR не створювався.
 */
export async function replyTo(ctx: Ctx, runId: string, answer: string): Promise<void> {
  const run = await ctx.deps.storage.load(runId);

  if (run.status === "waiting_human") {
    await execute(ctx, run, (runDeps) => resume(runId, answer, runDeps));
    return;
  }

  // done або failed — продовження тією ж історією, як коментар під квитком.
  const reopened = await ctx.deps.storage.save({
    ...run,
    status: "running",
    messages: [...run.messages, { role: "user", content: answer }],
  });
  await execute(ctx, reopened, (runDeps) => advance(reopened, runDeps));
}

/** Після простою: run у статусі running означає, що процес помер посеред роботи. */
export async function recover(deps: Deps, log: (l: string) => void): Promise<void> {
  for (const run of await deps.storage.list()) {
    if (run.status !== "running") continue;
    await deps.storage.save({ ...run, status: "queued" });
    log(`відновлено ${run.id}: обірваний running → queued`);
  }
}

/** Нові квитки зі списку готових стають runs. Дублі відсікаються за ticket ref. */
async function intake({ deps, board, log, repo }: Ctx): Promise<void> {
  const runs = await deps.storage.list();

  for (const ticket of await board.ready()) {
    const known = runs.some((r) => r.ticket && same(r.ticket, ticket.ref) && active(r));
    if (known) continue;

    // Колонку не чіпаємо: картка лишається в Ready, поки робота справді не почалась.
    // Інакше квиток у черзі виглядає так, ніби над ним працюють.
    await deps.storage.create(runFor(ticket, repo));
    log(`у черзі ${ticket.ref.externalId}: ${ticket.title}`);
  }
}

/**
 * Один прохід по коментарях покриває два випадки: відповідь на питання агента
 * і доопрацювання вже завершеної задачі. Різниця лише в тому, як текст лягає
 * в історію: як tool_result чи як нове user-повідомлення.
 */
async function collectAnswers(ctx: Ctx): Promise<void> {
  const { deps, board, log } = ctx;
  for (const run of await deps.storage.list()) {
    if (!run.ticket) continue;
    // failed теж продовжується коментарем: найчастіша його причина — вичерпаний
    // ліміт кроків, і тоді робота зроблена, а не втрачена. Інакше єдиним виходом
    // був би новий квиток і читання того самого коду заново.
    if (!["waiting_human", "done", "failed"].includes(run.status)) continue;

    const ticket = run.ticket;

    await isolate(deps, run, log, async () => {
      // Порожній since взагалі неприпустимий: він означає «уся історія».
      const since = run.lastCommentAt ?? run.pending?.askedAt ?? null;
      if (!since) return;

      const answer = (await board.commentsSince(ticket, since)).find((c) => !c.mine);
      if (!answer) return;

      const seen = await deps.storage.save({ ...run, lastCommentAt: answer.createdAt });
      await board.setStatus(ticket, "in_progress");

      if (seen.status === "waiting_human") {
        log(`відповідь на ${seen.id}: ${answer.body.slice(0, 60)}`);
        await execute(ctx, seen, (runDeps) =>
          resume(seen.id, answer.body, runDeps),
        );
        return;
      }

      // Доопрацювання або продовження після ліміту: та сама історія плюс нове
      // прохання — модель памʼятає, що вже зробила.
      log(`${seen.status === "failed" ? "продовження" : "доопрацювання"} ${seen.id}: ${answer.body.slice(0, 60)}`);
      const reopened = await deps.storage.save({
        ...seen,
        status: "queued",
        messages: [...seen.messages, { role: "user", content: answer.body }],
      });
      await execute(ctx, reopened, (runDeps) =>
        advance(reopened, runDeps),
      );
    });
  }
}

/**
 * Ворота якості: якщо агент щось змінив, зміни мусять хоча б компілюватись.
 * Провал не завершує роботу мовчки — вивід повертається в модель, і вона має
 * одну спробу виправитись. Друга спроба означала б цикл із невідомою ціною.
 */
async function gate(run: Run, workspace: Workspace, deps: Deps, log: (l: string) => void): Promise<Run> {
  // deps тут — саме runDeps із робочою копією в root, а не загальні.
  if (run.status !== "done") return run;

  const changed = await changedFiles(workspace);
  if (changed.length === 0) return run;

  // Ворота мають сенс лише там, де є що запускати: у чужому репо без package.json
  // або без скрипта typecheck це був би гарантований провал ні за що.
  const script = await hasScript(workspace.path, "typecheck");
  if (!script) {
    log(`${run.id}: ${changed.length} змінених файлів, скрипта typecheck немає — ворота пропущено`);
    return run;
  }

  log(`${run.id}: перевіряю ${changed.length} змінених файлів`);
  const output = await deps.tools.execute(
    "run_command",
    { command: "typecheck" },
    { runId: run.id, root: workspace.path, approvedActions: new Set(["run_command"]) },
  );

  if (!output.includes("помилкою")) return run;

  log(`${run.id}: ворота не пройдено, віддаю моделі на виправлення`);
  const retry = await deps.storage.save({
    ...run,
    status: "running",
    messages: [
      ...run.messages,
      {
        role: "user",
        content: `Перевірка typecheck не пройшла. Виправ і перевір ще раз.\n\n${output}`,
      },
    ],
  });
  return advance(retry, deps);
}

async function hasScript(dir: string, name: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    return Boolean((JSON.parse(raw) as { scripts?: Record<string, string> }).scripts?.[name]);
  } catch {
    return false;
  }
}

/**
 * Зміни, що пройшли ворота, стають PR. Коміт і пуш робить код, а не модель:
 * інструмент `git push` дав би їй право пушити куди завгодно.
 */
async function deliver(ctx: Ctx, run: Run, workspace: Workspace, repo: RepoRef): Promise<Run> {
  const { deps, forge, log } = ctx;
  if (run.status !== "done" || !run.ticket || !forge) return run;

  const changed = await changedFiles(workspace);
  if (changed.length === 0) return run;

  if (!repo.remote) {
    log(`${run.id}: зміни є, але в репозиторії немає remote — гілка лишається локальною`);
    return run;
  }

  const title = `${run.ticket.externalId}: ${firstLine(run)}`;
  await commitAll(workspace, `${title}\n\nvia devflow ${run.id}`);
  await forge.pushBranch({ cwd: workspace.path, branch: workspace.branch, remote: repo.remote });

  const pull = await forge.openPullRequest({
    branch: workspace.branch,
    title,
    base: await baseBranch(repo.root),
    body: `Closes #${run.ticket.externalId}\n\nЗмінено файлів: ${changed.length}\n\nvia devflow \`${run.id}\``,
  });

  log(`${run.id}: PR ${pull.url}`);
  return deps.storage.save({
    ...run,
    messages: [...run.messages, { role: "user", content: `PR відкрито: ${pull.url}` }],
  });
}

function firstLine(run: Run): string {
  const first = run.messages[0];
  const text = typeof first?.content === "string" ? first.content : "";
  return (text.split("\n")[0] ?? "задача").replace(/^Задача з квитка \d+:\s*/, "").slice(0, 60);
}

/**
 * Один зіпсований прогін не має зупиняти чергу. Видалений квиток — остаточно:
 * позначаємо failed. Решта помилок вважаються тимчасовими: наступний оберт
 * спробує знову.
 */
async function isolate(
  deps: Deps,
  run: Run,
  log: (l: string) => void,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof TicketGone) {
      await deps.storage.save({ ...(await deps.storage.load(run.id)), status: "failed", error: err.message });
      log(`${run.id}: ${err.message}`);
      return;
    }
    log(`${run.id}: ${err instanceof Error ? err.message : String(err)} — спробую наступного оберту`);
  }
}

/**
 * Розбирає чергу до кінця: послідовно, по одній задачі, але без пауз між ними.
 * Стеля — кількість завдань на початок оберту: якщо робота породжує нові
 * задачі, вони почекають наступного разу, і цикл не піде вразнос.
 */
async function advanceQueue(ctx: Ctx): Promise<void> {
  const { deps, board, log } = ctx;
  const initial = (await deps.storage.list()).filter((r) => r.status === "queued").length;

  for (let done = 0; done < initial; done++) {
    const runs = await deps.storage.list();
    if (runs.some((r) => r.status === "running")) return;

    // FIFO за часом створення: id випадковий, сортування за ним давало довільний порядок.
    const next = runs
      .filter((r) => r.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!next) return;

    log(`працюю над ${next.id}`);
    await isolate(deps, next, log, async () => {
      if (next.ticket) await board.setStatus(next.ticket, "in_progress");
      const started = await deps.storage.save({ ...next, status: "running" });
      await execute(ctx, started, (runDeps) =>
        advance(started, runDeps),
      );
    });
  }
}

/**
 * Спільна обгортка для першого запуску й для продовження після паузи. Раніше
 * продовження йшло без робочої копії, і правки після дозволу лягали в теку
 * користувача.
 */
async function execute(ctx: Ctx, run: Run, work: (runDeps: Deps) => Promise<Run>): Promise<void> {
  const { deps, board, forge, repo, log, finishStatus } = ctx;
  const workspace = await workspaceFor(deps, run, repo, log);
  const runDeps = forRun(deps, board, run, workspace);

  let done = await work(runDeps);

  if (workspace && repo) {
    done = await gate(done, workspace, runDeps, log);
    done = await deliver(ctx, done, workspace, repo);
  }

  await finish(deps, board, done, log, finishStatus);

  if (workspace && repo && (await removeIfClean(repo.root, workspace))) {
    log(`${run.id}: змін немає, копію прибрано`);
  }
}

async function finish(
  deps: Deps,
  board: Board,
  run: Run,
  log: (l: string) => void,
  finishStatus: TicketStatus = "in_review",
): Promise<void> {
  if (!run.ticket) return;

  const column: Partial<Record<Run["status"], TicketStatus>> = {
    done: finishStatus,
    failed: "blocked",
    waiting_human: "blocked",
  };
  const next = column[run.status];
  if (next) await board.setStatus(run.ticket, next);

  // Мітка «зараз»: доопрацюванням вважаються лише коментарі ПІСЛЯ звіту.
  // Без неї since=="" означало б «уся історія», і будь-який давній коментар —
  // хоч від людини, хоч від іншого бота — запускав би роботу заново.
  const stamped = await deps.storage.save({ ...run, lastCommentAt: new Date().toISOString() });
  await publishReport(deps, board, stamped);
  log(`${run.id} → ${run.status}`);
}

/** Один коментар на run: створюється при першому звіті, далі редагується. */
async function publishReport(deps: Deps, board: Board, run: Run): Promise<Run> {
  if (!run.ticket) return run;

  const body = renderReport(run, await deps.trace.read(run.id));

  if (run.report) {
    await board.editComment(run.ticket, run.report.commentId, body);
    return run;
  }

  const commentId = await board.comment(run.ticket, body);
  return deps.storage.save({ ...run, report: { commentId } });
}

/**
 * У режимі планувальника агент має дошку й окрему робочу копію: звідси канал,
 * уміння створювати підзадачі й право правити код.
 */
function forRun(deps: Deps, board: Board, run: Run, workspace: Workspace | null): Deps {
  if (!run.ticket) return deps;
  return {
    ...deps,
    channel: new LiveChannel(new BoardChannel(board, run.ticket)),
    tools: toolsWithBoard(codingTools, board, run.id),
    ...(workspace ? { root: workspace.path } : {}),
  };
}

/**
 * Робоча копія на кожен прогін планувальника. Створюється завжди, а не за
 * потреби: інакше читання йшло б із однієї теки, а правки — в іншу, і модель
 * бачила б не той стан, який змінює.
 */
async function workspaceFor(deps: Deps, run: Run, repo: RepoRef | undefined, log: (l: string) => void) {
  if (!repo) return null;
  try {
    return await createWorkspace(repo.root, run.id, path.join(stateDir(repo), "wt"));
  } catch (err) {
    log(`${run.id}: робочу копію створити не вдалось (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

function runFor(ticket: Ticket, repo?: RepoRef): Run {
  return newRun({
    status: "queued",
    task: `Задача з квитка ${ticket.ref.externalId}: ${ticket.title}

${untrusted(
      `ticket:${ticket.ref.provider}:${ticket.ref.externalId}`,
      ticket.body,
    )}`,
    ticket: ticket.ref,
    repo: repo ? bindingOf(repo) : null,
  });
}
