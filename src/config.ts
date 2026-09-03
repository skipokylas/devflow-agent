import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ticketStatusSchema } from "./board/types";

/**
 * Конфіг репозиторію: `.devflow/config.json`, комітиться разом із кодом.
 * JSON, а не YAML, бо в Node немає вбудованого парсера, а полів вісім.
 */
export const configSchema = z.object({
  board: z
    .object({
      provider: z.literal("github"),
      /** "org/repo" — звідки беруться issues. */
      scope: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "очікую org/repo"),
      /** Номер проєкту з URL github.com/users/<owner>/projects/<number>. */
      projectNumber: z.number().int().positive(),
      /** Кому належить проєкт і чи це організація. */
      owner: z.string().min(1),
      ownerType: z.enum(["user", "organization"]).default("user"),
      /** Назви колонок поля Status у Projects v2. */
      statuses: z.record(ticketStatusSchema, z.string()).default({
        todo: "Ready",
        in_progress: "In progress",
        in_review: "In review",
        blocked: "Blocked",
        done: "Done",
      }),
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(root: string): Promise<Config> {
  const file = path.join(root, ".devflow", "config.json");
  try {
    return configSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
    throw err;
  }
}
