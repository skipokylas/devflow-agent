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

  /** Повертає id, щоб коментар-звіт можна було редагувати замість плодити нові. */
  comment(ref: TicketRef, body: string): Promise<string>;

  editComment(ref: TicketRef, commentId: string, body: string): Promise<void>;

  /** Створює квиток і одразу кладе його на дошку в колонку todo. */
  createTicket(input: { title: string; body: string; labels?: string[] }): Promise<TicketRef>;

  /** Пошук за маркером ідемпотентності: чи ми вже створювали це. */
  findByMarker(marker: string): Promise<TicketRef | null>;

  /**
   * Коментарі після заданого моменту — так ловляться відповіді людини.
   * Свої власні позначені mine, щоб полінг не зациклився.
   */
  commentsSince(ref: TicketRef, since: string): Promise<BoardComment[]>;
}

/**
 * Ознака власного коментаря. За автором розрізняти не можна: коли агент працює
 * під особистим токеном, його логін збігається з логіном людини, і відповіді
 * людини вважалися б своїми.
 */
/** Квиток видалено або доступ втрачено: це остаточно, повторювати нема сенсу. */
export class TicketGone extends Error {
  constructor(id: string) {
    super(`квиток ${id} недоступний: видалений або немає прав`);
  }
}

export const SELF_MARK = "<!-- devflow";

export const isMine = (body: string): boolean => body.includes(SELF_MARK);

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
