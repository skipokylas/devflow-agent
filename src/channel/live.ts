import type { Channel, Progress, Question } from "../agent/channel";
import type { Run } from "../agent/types";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const OFF = "\x1b[0m";

type Line = { text: string; done: boolean };

/**
 * Живий показ у терміналі: дерево кроків дописується по ходу, останній рядок
 * крутиться, поки чекаємо модель. Обгортає інший канал — питання й звіти
 * лишаються на ньому, ми лише малюємо.
 *
 * Не TTY (пайп, файл, CI) — друкуємо звичайні рядки без перемальовування.
 */
export class LiveChannel implements Channel {
  private lines: Line[] = [];
  private painted = 0;
  private spinner: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = 0;
  private tokens = { input: 0, output: 0 };
  private cost = 0;

  constructor(
    private readonly inner: Channel,
    private readonly tty = process.stdout.isTTY === true,
  ) {}

  /** Питання друкує внутрішній канал: він знає, як саме на нього відповідати. */
  async ask(run: Run, q: Question): Promise<void> {
    this.flush();
    await this.inner.ask(run, q);
  }

  async notify(run: Run, text: string): Promise<void> {
    await this.inner.notify(run, text);
  }

  async progress(run: Run, event: Progress): Promise<void> {
    if (event.kind === "start") {
      this.startedAt = Date.now();
      this.lines = [];
      this.painted = 0;
      this.tokens = { input: 0, output: 0 };
      this.cost = 0;
      this.push(`${DIM}${run.id}${OFF}  ${event.task.slice(0, 60)}`, true);
      this.startSpinner("думає");
      return;
    }

    if (event.kind === "llm") {
      this.tokens.input += event.inputTokens;
      this.tokens.output += event.outputTokens;
      this.cost += event.costUsd;
      this.stopSpinner();
      this.push(
        `  ${DIM}крок ${event.step}${OFF}  ${event.model}  ` +
          `${DIM}${event.inputTokens}→${event.outputTokens} · $${event.costUsd.toFixed(4)}${OFF}`,
        true,
      );
      if (event.stopReason === "tool_use") this.startSpinner("виконує інструменти");
      return;
    }

    if (event.kind === "tool") {
      this.stopSpinner();
      const mark = event.ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
      const arg = JSON.stringify(event.input).slice(0, 46);
      this.push(`    ${mark} ${event.name} ${DIM}${arg}  ${event.ms}ms${OFF}`, true);
      this.startSpinner("думає");
      return;
    }

    this.stopSpinner();
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.push(
      `  ${event.status === "done" ? GREEN : RED}${event.status}${OFF}  ` +
        `${DIM}${seconds}s · ${this.tokens.input}→${this.tokens.output} токенів · ` +
        `$${this.cost.toFixed(4)}${OFF}`,
      true,
    );
    this.flush();
  }

  private push(text: string, done: boolean): void {
    this.lines.push({ text, done });
    this.paint();
  }

  private startSpinner(label: string): void {
    if (!this.tty) return;
    this.lines.push({ text: "", done: false });
    this.spinner = setInterval(() => {
      const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(0);
      this.frame = (this.frame + 1) % FRAMES.length;
      this.lines[this.lines.length - 1] = {
        text: `  ${DIM}${FRAMES[this.frame]} ${label}… ${seconds}s${OFF}`,
        done: false,
      };
      this.paint();
    }, 90);
    this.spinner.unref();
  }

  private stopSpinner(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = null;
      if (this.lines[this.lines.length - 1]?.done === false) this.lines.pop();
    }
  }

  /** Перемальовуємо тільки те, що змінилось: підіймаємо курсор на N рядків. */
  private paint(): void {
    if (!this.tty) {
      for (let i = this.painted; i < this.lines.length; i++) {
        const line = this.lines[i];
        if (line?.done) console.log(stripAnsi(line.text));
      }
      this.painted = this.lines.length;
      return;
    }

    if (this.painted > 0) process.stdout.write(`\x1b[${this.painted}A`);
    for (const line of this.lines) process.stdout.write(`\x1b[2K${line.text}\n`);
    this.painted = this.lines.length;
  }

  /** Після flush подальші кроки малюються з нового місця; у не-TTY нічого не перемальовуємо. */
  private flush(): void {
    this.stopSpinner();
    this.paint();
    if (!this.tty) return;
    // Намальоване лишається на екрані як є; наступні кроки починають новий блок.
    this.lines = [];
    this.painted = 0;
  }
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
