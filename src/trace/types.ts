import { z } from "zod";

export const spanSchema = z.object({
  id: z.string(),
  runId: z.string(),
  /** null — корінь. Дає дерево: tool_call висить на llm_call, який його попросив. */
  parentId: z.string().nullable(),
  type: z.enum(["run", "llm_call", "tool_call", "question", "answer", "gate"]),
  name: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable().default(null),
  cost: z
    .object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number() })
    .nullable()
    .default(null),
});

export type Span = z.infer<typeof spanSchema>;
export type SpanType = Span["type"];

/** $ за 1M токенів. Оновлювати разом із появою нових моделей у проєкті. */
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
};

export function priceOf(cost: Span["cost"]): number {
  if (!cost) return 0;
  const p = PRICES[cost.model];
  if (!p) return 0;
  return (cost.inputTokens * p.in + cost.outputTokens * p.out) / 1_000_000;
}
