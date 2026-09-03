import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { TicketRef } from "../board/types";
import type { Run } from "./types";

/**
 * Єдине місце створення Run. Раніше літерал дублювався в шести файлах, і кожне
 * нове поле в схемі ламало всі шість.
 */
export function newRun(input: {
  id?: string;
  task?: string;
  messages?: Anthropic.MessageParam[];
  status?: Run["status"];
  ticket?: TicketRef | null;
  repo?: Run["repo"];
}): Run {
  return {
    id: input.id ?? `run_${randomUUID().slice(0, 8)}`,
    status: input.status ?? "running",
    messages: input.messages ?? (input.task ? [{ role: "user", content: input.task }] : []),
    pending: null,
    error: null,
    ticket: input.ticket ?? null,
    repo: input.repo ?? null,
    report: null,
    lastCommentAt: null,
    version: 0,
  };
}
