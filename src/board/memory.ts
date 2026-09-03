import type { Board } from "./board";
import type { BoardComment, Ticket, TicketRef, TicketStatus } from "./types";

/** Дошка в памʼяті: планувальник і сценарії перевірок працюють без мережі. */
export class InMemoryBoard implements Board {
  private readonly tickets = new Map<string, Ticket>();
  private readonly threads = new Map<string, BoardComment[]>();
  private seq = 0;

  constructor(tickets: Ticket[] = []) {
    for (const ticket of tickets) this.tickets.set(key(ticket.ref), ticket);
  }

  async ready(): Promise<Ticket[]> {
    return [...this.tickets.values()].filter((t) => t.status === "todo");
  }

  async get(ref: TicketRef): Promise<Ticket> {
    const ticket = this.tickets.get(key(ref));
    if (!ticket) throw new Error(`квитка ${key(ref)} немає`);
    return ticket;
  }

  async setStatus(ref: TicketRef, status: TicketStatus): Promise<void> {
    this.tickets.set(key(ref), { ...(await this.get(ref)), status, updatedAt: new Date().toISOString() });
  }

  async comment(ref: TicketRef, body: string): Promise<void> {
    this.push(ref, { author: "devflow", mine: true, body });
  }

  /** Для сценаріїв: імітує відповідь людини. */
  reply(ref: TicketRef, body: string, author = "human"): void {
    this.push(ref, { author, mine: false, body });
  }

  async commentsSince(ref: TicketRef, since: string): Promise<BoardComment[]> {
    return (this.threads.get(key(ref)) ?? []).filter((c) => c.createdAt > since);
  }

  private push(ref: TicketRef, c: Omit<BoardComment, "id" | "createdAt">): void {
    const thread = this.threads.get(key(ref)) ?? [];
    thread.push({ ...c, id: `c${++this.seq}`, createdAt: new Date().toISOString() });
    this.threads.set(key(ref), thread);
  }
}

const key = (ref: TicketRef): string => `${ref.provider}:${ref.scope}#${ref.externalId}`;
