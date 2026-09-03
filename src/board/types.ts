import { z } from "zod";

export const providerSchema = z.enum(["github", "gitlab", "trello"]);
export type Provider = z.infer<typeof providerSchema>;

/**
 * Посилання на квиток у провайдера. externalId — рядок навмисно:
 * у GitHub це число, у Trello — shortLink, у GitLab — iid у межах проєкту.
 */
export const ticketRefSchema = z.object({
  provider: providerSchema,
  /** Проєкт, якому належить квиток: "org/repo" у GitHub, повний шлях у GitLab. */
  scope: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url(),
});
export type TicketRef = z.infer<typeof ticketRefSchema>;

/**
 * Власний статус. У провайдерів він влаштований по-різному — поле Projects,
 * мітка, список, — тому відповідність задається конфігом репозиторію, не кодом.
 */
export const ticketStatusSchema = z.enum(["todo", "in_progress", "in_review", "blocked", "done"]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export type Ticket = {
  ref: TicketRef;
  title: string;
  /** Чужий текст: у контекст іде тільки загорнутим у <untrusted>. */
  body: string;
  status: TicketStatus;
  labels: string[];
  updatedAt: string;
};

export type BoardComment = {
  id: string;
  author: string;
  /** Наш власний коментар — щоб агент не відповідав сам собі в полінгу. */
  mine: boolean;
  body: string;
  createdAt: string;
};

/** Відповідність наших статусів колонкам провайдера. Живе в .devflow/config.yml. */
export type StatusMapping = Record<TicketStatus, string>;
