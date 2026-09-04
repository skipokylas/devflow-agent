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
    .object({
      model: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      /** Запис у кеш дорожчий за звичайний вхід, читання — на порядок дешевше. */
      cacheWriteTokens: z.number().default(0),
      cacheReadTokens: z.number().default(0),
    })
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

/** Множники Anthropic: запис у кеш 1.25× від ціни входу, читання 0.1×. */
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

export function priceOf(cost: Span["cost"]): number {
  if (!cost) return 0;
  const p = PRICES[cost.model];
  if (!p) return 0;

  const input =
    cost.inputTokens * p.in +
    cost.cacheWriteTokens * p.in * CACHE_WRITE +
    cost.cacheReadTokens * p.in * CACHE_READ;

  return (input + cost.outputTokens * p.out) / 1_000_000;
}

/** Скільки вхідних токенів прийшло з кешу — головний показник, що воно працює. */
export function cacheHitRate(spans: Span[]): number {
  const read = spans.reduce((n, s) => n + (s.cost?.cacheReadTokens ?? 0), 0);
  const fresh = spans.reduce((n, s) => n + (s.cost?.inputTokens ?? 0) + (s.cost?.cacheWriteTokens ?? 0), 0);
  return read + fresh === 0 ? 0 : read / (read + fresh);
}
