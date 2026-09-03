import { randomUUID } from "node:crypto";
import { advance, resume, type Deps } from "./agent/loop";
import { untrusted } from "./agent/tools";
import type { Run } from "./agent/types";
import type { Board } from "./board/board";
import type { Ticket, TicketRef } from "./board/types";
import { BoardChannel } from "./channel/board";

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
export async function tick(deps: Deps, board: Board, log: (l: string) => void): Promise<void> {
  await intake(deps, board, log);
  await collectAnswers(deps, board, log);
  await advanceNext(deps, board, log);
}

export async function watch(deps: Deps, board: Board, opts: WatchOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l));
  await recover(deps, log);

  for (;;) {
    await tick(deps, board, log);
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
async function intake(deps: Deps, board: Board, log: (l: string) => void): Promise<void> {
  const runs = await deps.storage.list();

  for (const ticket of await board.ready()) {
    const known = runs.some((r) => r.ticket && same(r.ticket, ticket.ref) && active(r));
    if (known) continue;

    await deps.storage.create(runFor(ticket));
    await board.setStatus(ticket.ref, "in_progress");
    log(`взято ${ticket.ref.externalId}: ${ticket.title}`);
  }
}

/** Відповідь людини — перший чужий коментар після моменту питання. */
async function collectAnswers(deps: Deps, board: Board, log: (l: string) => void): Promise<void> {
  for (const run of await deps.storage.list()) {
    if (run.status !== "waiting_human" || !run.pending || !run.ticket) continue;

    const comments = await board.commentsSince(run.ticket, run.pending.askedAt);
    const answer = comments.find((c) => !c.mine);
    if (!answer) continue;

    log(`відповідь на ${run.id}: ${answer.body.slice(0, 60)}`);
    await board.setStatus(run.ticket, "in_progress");
    await finish(deps, board, await resume(run.id, answer.body, withChannel(deps, board, run)), log);
  }
}

/** Одна активна робота: якщо щось уже крутиться — цей оберт нічого не починає. */
async function advanceNext(deps: Deps, board: Board, log: (l: string) => void): Promise<void> {
  const runs = await deps.storage.list();
  if (runs.some((r) => r.status === "running")) return;

  const next = runs.filter((r) => r.status === "queued").sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!next) return;

  log(`працюю над ${next.id}`);
  const started = await deps.storage.save({ ...next, status: "running" });
  await finish(deps, board, await advance(started, withChannel(deps, board, next)), log);
}

async function finish(deps: Deps, board: Board, run: Run, log: (l: string) => void): Promise<void> {
  if (!run.ticket) return;

  if (run.status === "done") {
    await board.setStatus(run.ticket, "done");
    await board.comment(run.ticket, `Готово. Трейс: \`devflow trace ${run.id}\``);
  } else if (run.status === "failed") {
    await board.setStatus(run.ticket, "blocked");
    await board.comment(run.ticket, `Зупинився: ${run.error ?? "невідома причина"}`);
  } else if (run.status === "waiting_human") {
    await board.setStatus(run.ticket, "blocked");
  }
  log(`${run.id} → ${run.status}`);
}

function withChannel(deps: Deps, board: Board, run: Run): Deps {
  return run.ticket ? { ...deps, channel: new BoardChannel(board, run.ticket) } : deps;
}

function runFor(ticket: Ticket): Run {
  return {
    id: `run_${randomUUID().slice(0, 8)}`,
    status: "queued",
    messages: [
      {
        role: "user",
        content: `Задача з квитка ${ticket.ref.externalId}: ${ticket.title}\n\n${untrusted(
          `ticket:${ticket.ref.provider}:${ticket.ref.externalId}`,
          ticket.body,
        )}`,
      },
    ],
    pending: null,
    error: null,
    ticket: ticket.ref,
    version: 0,
  };
}
