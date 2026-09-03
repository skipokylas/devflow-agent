import type { Channel, Question } from "../agent/channel";
import type { Run } from "../agent/types";

/** Змінні, задані для цього запуску, треба повторити в підказці — інакше reply піде іншим шляхом. */
/** Змінні поточного запуску повторюються в підказці — інакше reply піде іншим шляхом. */
function envArgs(): string {
  const keep = ["AGENT_LLM", "MODEL", "MAX_STEPS"];
  const set = keep.flatMap((name) => {
    const value = process.env[name];
    return value ? [`${name}=${value}`] : [];
  });
  return set.length ? ` ${set.join(" ")}` : "";
}

export class CliChannel implements Channel {
  async ask(run: Run, q: Question): Promise<void> {
    console.log(`\n${q.question}`);
    q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
    console.log(`\nвідповісти:  devflow reply ${run.id} "<відповідь>"${envArgs()}`);
  }

  async notify(_run: Run, text: string): Promise<void> {
    console.log(text);
  }
}
