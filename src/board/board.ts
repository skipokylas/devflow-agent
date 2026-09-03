import type { BoardComment, Ticket, TicketRef, TicketStatus } from "./types";

/**
 * Порт до системи задач. Реалізації: GitHubBoard, GitLabBoard, TrelloBoard.
 * Ядро знає тільки цей інтерфейс і власний TicketStatus.
 */
export interface Board {
  /** Квитки, готові до роботи. Опитується планувальником. */
  ready(): Promise<Ticket[]>;

  get(ref: TicketRef): Promise<Ticket>;

  setStatus(ref: TicketRef, status: TicketStatus): Promise<void>;

  /** Канал спілкування: агент питає й звітує коментарем під квитком. */
  comment(ref: TicketRef, body: string): Promise<void>;

  /**
   * Коментарі після заданого моменту — так ловляться відповіді людини.
   * Свої власні позначені mine, щоб полінг не зациклився.
   */
  commentsSince(ref: TicketRef, since: string): Promise<BoardComment[]>;
}

/**
 * Маркер ідемпотентності в тілі коментаря: повторний прогін бачить свій слід
 * і не дублює дію. Пишеться до того, як результат піде в модель.
 */
export function marker(runId: string, step: string): string {
  return `<!-- devflow run:${runId} step:${step} -->`;
}

export function hasMarker(body: string, runId: string, step: string): boolean {
  return body.includes(marker(runId, step));
}
