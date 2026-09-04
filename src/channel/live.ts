import type { Channel, Progress, Question } from "../agent/channel";
import type { Run } from "../agent/types";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const OFF = "\x1b[0m";
const CLEAR_LINE = "\r\x1b[2K";

/**
 * Живий показ у терміналі: готові кроки друкуються один раз назавжди, крутиться
 * лише останній рядок. Перемальовування цілого блоку тут було б крихким —
 * перенесення довгого рядка чи сторонній друк збивають лічильник, і замість
 * оновлення екран заповнюється копіями.
 */
export class LiveChannel implements Channel {
  private spinner: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = 0;
  private tokens = { input: 0, output: 0 };
  private cost = 0;

  constructor(
    private readonly inner: Channel,
    private readonly tty = process.stdout.isTTY === true,
  ) {}

  async ask(run: Run, q: Question): Promise<void> {
    this.stop();
    await this.inner.ask(run, q);
  }

  async notify(run: Run, text: string): Promise<void> {
    this.stop();
    await this.inner.notify(run, text);
  }

  async progress(run: Run, event: Progress): Promise<void> {
    this.stop();

    if (event.kind === "start") {
      this.startedAt = Date.now();
      this.tokens = { input: 0, output: 0 };
      this.cost = 0;
      this.line(`${DIM}${run.id}${OFF}  ${event.task.replace(/\s+/g, " ").slice(0, 60)}`);
      this.spin("думає");
      return;
    }

    if (event.kind === "llm") {
      this.tokens.input += event.inputTokens;
      this.tokens.output += event.outputTokens;
      this.cost += event.costUsd;
      this.line(
        `  ${DIM}крок ${event.step}${OFF}  ${event.model}  ` +
          `${DIM}${event.inputTokens}→${event.outputTokens} · $${event.costUsd.toFixed(4)}${OFF}`,
      );
      this.spin(event.stopReason === "tool_use" ? "виконує" : "думає");
      return;
    }

    if (event.kind === "tool") {
      const mark = event.ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
      const arg = JSON.stringify(event.input).slice(0, 46);
      this.line(`    ${mark} ${event.name} ${DIM}${arg}  ${event.ms}ms${OFF}`);
      this.spin("думає");
      return;
    }

    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.line(
      `  ${event.status === "done" ? GREEN : RED}${event.status}${OFF}  ` +
        `${DIM}${seconds}s · ${this.tokens.input}→${this.tokens.output} токенів · ` +
        `$${this.cost.toFixed(4)}${OFF}`,
    );
  }

  private line(text: string): void {
    process.stdout.write(`${this.tty ? CLEAR_LINE : ""}${this.tty ? text : strip(text)}\n`);
  }

  /** Один рядок, що оновлюється через \r. Без TTY не показуємо взагалі. */
  private spin(label: string): void {
    if (!this.tty) return;
    this.spinner = setInterval(() => {
      const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(0);
      this.frame = (this.frame + 1) % FRAMES.length;
      process.stdout.write(`${CLEAR_LINE}${DIM}  ${FRAMES[this.frame]} ${label}… ${seconds}s${OFF}`);
    }, 90);
    this.spinner.unref();
  }

  private stop(): void {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = null;
    if (this.tty) process.stdout.write(CLEAR_LINE);
  }
}

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
