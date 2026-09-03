import type { Channel, Question } from "../agent/channel";
import type { Run } from "../agent/types";
import { marker } from "../board/board";
import type { Board } from "../board/board";
import type { TicketRef } from "../board/types";

/**
 * Канал через коментарі під квитком. Питання й фінальний звіт стають
 * коментарями; проміжні кроки — ні, інакше квиток перетвориться на лог.
 */
export class BoardChannel implements Channel {
  constructor(
    private readonly board: Board,
    private readonly ref: TicketRef,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  async ask(run: Run, q: Question): Promise<void> {
    this.log(`  ? ${q.question}`);
    const options = q.options.length
      ? `\n\n${q.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`
      : "";
    await this.board.comment(
      this.ref,
      `**Потрібна відповідь.** ${q.question}${options}\n\n${marker(run.id, "ask")}`,
    );
  }

  /** У квиток іде розмова, у термінал — покрокові дії. Інакше квиток стане логом. */
  async notify(_run: Run, text: string): Promise<void> {
    this.log(text);
  }
}
