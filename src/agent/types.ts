import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ticketRefSchema } from "../board/types";

/** Блоки SDK не описуємо — пропускаємо як є, їх валідує сам API. */
const messageParam = z.custom<Anthropic.MessageParam>(
  (v) => typeof v === "object" && v !== null && "role" in v,
  { message: "не схоже на MessageParam" },
);

const toolResultParam = z.custom<Anthropic.ToolResultBlockParam>(
  (v) => typeof v === "object" && v !== null && (v as { type?: string }).type === "tool_result",
);

export const pendingSchema = z.object({
  toolUseId: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string()),
  /** Мітка часу питання: коментарі після неї вважаються відповіддю. */
  askedAt: z.string().default(""),
  /**
   * Якщо пауза виникла через ворота дозволу — намір, який виконається після
   * згоди. Порожньо, коли це звичайне питання від моделі.
   */
  approval: z
    .object({ tool: z.string(), input: z.unknown() })
    .nullable()
    .default(null),
  partialResults: z.array(toolResultParam),
});

export const runSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["queued", "running", "waiting_human", "done", "failed"]),
  messages: z.array(messageParam),
  pending: pendingSchema.nullable(),
  /** Причина падіння. default(null) — щоб файли, записані до появи поля, читались далі. */
  error: z.string().nullable().default(null),
  /** Квиток, з якого виросла задача. Історія по квитку — це всі runs із цим ref. */
  ticket: ticketRefSchema.nullable().default(null),
  /**
   * Репозиторій, у якому створено run. Поки стан лежить у теці на кожне репо,
   * розділення тримається на структурі файлів; після переходу на спільну базу
   * ця гарантія зникне, тому привʼязка потрібна раніше за базу.
   */
  repo: z.object({ id: z.string(), remote: z.string().nullable() }).nullable().default(null),
  /** Коментар-звіт під квитком: один на run, редагується по ходу роботи. */
  report: z.object({ commentId: z.string() }).nullable().default(null),
  /** Момент останнього врахованого коментаря — щоб не обробити той самий двічі. */
  lastCommentAt: z.string().nullable().default(null),
  /** Інструменти, на які людина дала дозвіл у межах цього run. */
  approved: z.array(z.string()).default([]),
  /** Момент створення: черга має бути FIFO, а id випадковий і для сортування не годиться. */
  createdAt: z.string().default(""),
  version: z.number().int().nonnegative(),
});

export type RunStatus = Run["status"];
export type Pending = z.infer<typeof pendingSchema>;
export type Run = z.infer<typeof runSchema>;
