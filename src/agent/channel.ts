import type { Run } from "./types";

export type Question = { question: string; options: string[] };

/** Порт спілкування з людиною. Ядро не знає, це термінал, Telegram чи Slack. */
export interface Channel {
  ask(run: Run, q: Question): Promise<void>;
  notify(run: Run, text: string): Promise<void>;
}
