import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ticketStatusSchema } from "./board/types";

/**
 * Конфіг репозиторію: `.devflow/config.json`, комітиться разом із кодом.
 * JSON, а не YAML, бо в Node немає вбудованого парсера, а полів вісім.
 */
export const configSchema = z.object({
  git: z
    .object({
      /** Репо з кількома remote мусить назвати свій явно. */
      remote: z.string().default("origin"),
    })
    .default({ remote: "origin" }),
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
      /**
       * Куди їде картка, коли агент завершив. Типово in_review: «готово» —
       * рішення людини, і поки картка на очах, її легко відправити на
       * доопрацювання коментарем.
       */
      finishStatus: z.enum(["in_review", "done"]).default("in_review"),
      /** Назви колонок поля Status у Projects v2. */
      statuses: z.record(ticketStatusSchema, z.string()).default({
        backlog: "Backlog",
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

/** У репозиторії — комітиться й бачить команда. У домівці — коли чужий репо не чіпаємо. */
export function configPaths(root: string, repoId: string): { inRepo: string; inHome: string } {
  return {
    inRepo: path.join(root, ".devflow", "config.json"),
    inHome: path.join(os.homedir(), ".devflow", "repos", `${repoId}.json`),
  };
}

async function readIfExists(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Порядок пошуку: конфіг у репозиторії виграє над локальним. */
export async function loadConfig(root: string, repoId = ""): Promise<Config> {
  const paths = configPaths(root, repoId);
  const raw = (await readIfExists(paths.inRepo)) ?? (repoId ? await readIfExists(paths.inHome) : null);
  return configSchema.parse(raw ?? {});
}
