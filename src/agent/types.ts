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
  version: z.number().int().nonnegative(),
});

export type RunStatus = Run["status"];
export type Pending = z.infer<typeof pendingSchema>;
export type Run = z.infer<typeof runSchema>;
