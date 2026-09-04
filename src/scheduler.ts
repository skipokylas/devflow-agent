import { advance, resume, type Deps } from "./agent/loop";
import { newRun } from "./agent/run";
import { toolsWithBoard } from "./agent/tools-board";
import { untrusted } from "./agent/tools";
import type { Run } from "./agent/types";
import type { Board } from "./board/board";
import type { Ticket, TicketRef, TicketStatus } from "./board/types";
import { BoardChannel } from "./channel/board";
import { renderReport } from "./report";
import { LiveChannel } from "./channel/live";
import type { RepoRef } from "./repo";
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
export async function tick(
  deps: Deps,
  board: Board,
  log: (l: string) => void,
  repo?: RepoRef,
  finishStatus: TicketStatus = "in_review",
): Promise<void> {
  await intake(deps, board, log, repo);
  await collectAnswers(deps, board, log, finishStatus);
  await advanceNext(deps, board, log, finishStatus);
}

export async function watch(
  deps: Deps,
  board: Board,
  opts: WatchOptions & { repo?: RepoRef; finishStatus?: TicketStatus },
): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l));
  await recover(deps, log);

  for (;;) {
    await tick(deps, board, log, opts.repo, opts.finishStatus);
    if (opts.once) return;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
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
async function intake(deps: Deps, board: Board, log: (l: string) => void, repo?: RepoRef): Promise<void> {
  const runs = await deps.storage.list();

  for (const ticket of await board.ready()) {
    const known = runs.some((r) => r.ticket && same(r.ticket, ticket.ref) && active(r));
    if (known) continue;

    await deps.storage.create(runFor(ticket, repo));
    await board.setStatus(ticket.ref, "in_progress");
    log(`взято ${ticket.ref.externalId}: ${ticket.title}`);
  }
}

/**
 * Один прохід по коментарях покриває два випадки: відповідь на питання агента
 * і доопрацювання вже завершеної задачі. Різниця лише в тому, як текст лягає
 * в історію: як tool_result чи як нове user-повідомлення.
 */
async function collectAnswers(
  deps: Deps,
  board: Board,
  log: (l: string) => void,
  finishStatus: TicketStatus,
): Promise<void> {
  for (const run of await deps.storage.list()) {
    if (!run.ticket) continue;
    if (run.status !== "waiting_human" && run.status !== "done") continue;

    // Порожній since взагалі неприпустимий: він означає «уся історія».
    const since = run.lastCommentAt ?? run.pending?.askedAt ?? null;
    if (!since) continue;
    const answer = (await board.commentsSince(run.ticket, since)).find((c) => !c.mine);
    if (!answer) continue;

    const seen = await deps.storage.save({ ...run, lastCommentAt: answer.createdAt });
    await board.setStatus(run.ticket, "in_progress");

    if (seen.status === "waiting_human") {
      log(`відповідь на ${seen.id}: ${answer.body.slice(0, 60)}`);
      await finish(deps, board, await resume(seen.id, answer.body, withChannel(deps, board, seen)), log, finishStatus);
      continue;
    }

    // Доопрацювання: та сама історія плюс нове прохання — модель памʼятає, що вже зробила.
    log(`доопрацювання ${seen.id}: ${answer.body.slice(0, 60)}`);
    const reopened = await deps.storage.save({
      ...seen,
      status: "queued",
      messages: [...seen.messages, { role: "user", content: answer.body }],
    });
    await finish(deps, board, await advance(reopened, withChannel(deps, board, reopened)), log, finishStatus);
  }
}

/** Одна активна робота: якщо щось уже крутиться — цей оберт нічого не починає. */
async function advanceNext(
  deps: Deps,
  board: Board,
  log: (l: string) => void,
  finishStatus: TicketStatus,
): Promise<void> {
  const runs = await deps.storage.list();
  if (runs.some((r) => r.status === "running")) return;

  const next = runs.filter((r) => r.status === "queued").sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!next) return;

  log(`працюю над ${next.id}`);
  const started = await deps.storage.save({ ...next, status: "running" });
  await finish(deps, board, await advance(started, withChannel(deps, board, next)), log, finishStatus);
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

/** У режимі планувальника агент має дошку: звідси і канал, і вміння створювати підзадачі. */
function withChannel(deps: Deps, board: Board, run: Run): Deps {
  if (!run.ticket) return deps;
  return {
    ...deps,
    channel: new LiveChannel(new BoardChannel(board, run.ticket)),
    tools: toolsWithBoard(deps.tools, board, run.id),
  };
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
