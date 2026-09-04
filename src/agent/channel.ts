import type { Run } from "./types";

export type Question = { question: string; options: string[] };

/** Подія кроку для живого показу. Необовʼязкова: канал може її ігнорувати. */
export type Progress =
  | {
      kind: "llm";
      step: number;
      model: string;
      stopReason: string | null;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
    }
  | { kind: "tool"; name: string; input: unknown; ok: boolean; ms: number }
  | { kind: "start"; task: string }
  | { kind: "end"; status: string };

/** Порт спілкування з людиною. Ядро не знає, це термінал, Telegram чи Slack. */
export interface Channel {
  ask(run: Run, q: Question): Promise<void>;
  notify(run: Run, text: string): Promise<void>;
  /** Живий показ; хто не вміє — не реалізує. */
  progress?(run: Run, event: Progress): Promise<void>;
}
