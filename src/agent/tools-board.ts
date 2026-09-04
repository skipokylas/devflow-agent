import { z } from "zod";
import { marker, type Board } from "../board/board";
import { defineTool, ToolRegistry, type Tool } from "./tools";

/**
 * План як структура, а не як текст: zod відкидає порожні заголовки й задачі без
 * пояснення ще до того, як щось буде створено.
 */
const taskSchema = z.object({
  title: z.string().min(8).max(120).describe("Що зробити, одним рядком"),
  body: z
    .string()
    .min(20)
    .describe("Чому це потрібно і як зрозуміти, що зроблено. Посилайся на файли."),
});

/**
 * Створення підзадач однією дією: людина підтверджує весь план, а не кожен
 * issue окремо. Маркер у тілі робить повторний прогін безпечним.
 */
export function createIssuesTool(board: Board, runId: string): Tool {
  return defineTool({
    name: "create_issues",
    description:
      "Створити підзадачі на дошці. Викликай один раз із повним планом, а не по одній задачі. " +
      "Кожна задача має бути самодостатньою: зрозуміло, що зробити і як перевірити.",
    access: "write",
    input: z.object({
      tasks: z.array(taskSchema).min(1).max(12).describe("Підзадачі в порядку виконання"),
    }),
    execute: async ({ tasks }) => {
      const lines: string[] = [];

      for (const [i, task] of tasks.entries()) {
        const mark = marker(runId, `task:${i + 1}`);

        // Повторний прогін після обриву не має дублювати вже створене.
        const existing = await board.findByMarker(mark);
        if (existing) {
          lines.push(`#${existing.externalId} вже існує — ${task.title}`);
          continue;
        }

        const ref = await board.createTicket({
          title: task.title,
          body: `${task.body}\n\n${mark}`,
        });
        lines.push(`#${ref.externalId} створено — ${task.title}`);
      }

      return lines.join("\n");
    },
  });
}

/** Реєстр із дошкою: у режимі планувальника агент уміє більше, ніж у ручному. */
export function toolsWithBoard(base: ToolRegistry, board: Board, runId: string): ToolRegistry {
  return new ToolRegistry([...base.all(), createIssuesTool(board, runId)]);
}
