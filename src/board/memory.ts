import { isMine, type Board } from "./board";
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

  async comment(ref: TicketRef, body: string): Promise<string> {
    return this.push(ref, { author: "devflow", mine: isMine(body), body });
  }

  async editComment(ref: TicketRef, commentId: string, body: string): Promise<void> {
    const thread = this.threads.get(key(ref)) ?? [];
    const found = thread.find((c) => c.id === commentId);
    if (!found) throw new Error(`коментаря ${commentId} немає`);
    found.body = body;
  }

  /** Для сценаріїв: імітує відповідь людини. */
  reply(ref: TicketRef, body: string, author = "human"): string {
    return this.push(ref, { author, mine: false, body });
  }

  async commentsSince(ref: TicketRef, since: string): Promise<BoardComment[]> {
    return (this.threads.get(key(ref)) ?? []).filter((c) => c.createdAt > since);
  }

  async createTicket(input: { title: string; body: string; labels?: string[] }): Promise<TicketRef> {
    const externalId = String(++this.seq + 1000);
    const ref: TicketRef = {
      provider: "github",
      scope: "org/repo",
      externalId,
      url: `https://github.com/org/repo/issues/${externalId}`,
    };
    this.tickets.set(key(ref), {
      ref,
      title: input.title,
      body: input.body,
      status: "backlog",
      labels: input.labels ?? [],
      updatedAt: new Date().toISOString(),
    });
    return ref;
  }

  async statuses(): Promise<Map<string, TicketStatus>> {
    return new Map([...this.tickets.values()].map((t) => [t.ref.externalId, t.status]));
  }

  async findByMarker(marker: string): Promise<TicketRef | null> {
    return [...this.tickets.values()].find((t) => t.body.includes(marker))?.ref ?? null;
  }

  private push(ref: TicketRef, c: Omit<BoardComment, "id" | "createdAt">): string {
    const thread = this.threads.get(key(ref)) ?? [];
    const id = `c${++this.seq}`;
    thread.push({ ...c, id, createdAt: new Date().toISOString() });
    this.threads.set(key(ref), thread);
    return id;
  }
}

const key = (ref: TicketRef): string => `${ref.provider}:${ref.scope}#${ref.externalId}`;
