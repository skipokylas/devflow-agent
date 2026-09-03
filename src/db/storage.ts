import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runSchema, type Run } from "../agent/types";

export class RunNotFound extends Error {
  constructor(id: string) {
    super(`Run ${id} не знайдено`);
  }
}

export class RunAlreadyExists extends Error {
  constructor(id: string) {
    super(`Run ${id} вже існує`);
  }
}

export class VersionConflict extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Run ${id}: очікували version ${expected}, у сховищі ${actual}`);
  }
}

/** Контракт сховища. Ядро агента знає тільки його, не знаючи про файли чи SQLite. */
export interface Storage {
  create(run: Run): Promise<Run>;
  load(id: string): Promise<Run>;
  save(run: Run): Promise<Run>;
}

export class FileStorage implements Storage {
  constructor(private readonly dir = ".runs") {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async create(run: Run): Promise<Run> {
    await fs.mkdir(this.dir, { recursive: true });
    if (await this.exists(run.id)) throw new RunAlreadyExists(run.id);

    const created: Run = { ...run, version: 1 };
    await this.write(created);
    return created;
  }

  async load(id: string): Promise<Run> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new RunNotFound(id);
      throw err;
    }
    return runSchema.parse(JSON.parse(raw));
  }

  /** Записує, тільки якщо у сховищі та сама версія. Повертає run із піднятою версією. */
  async save(run: Run): Promise<Run> {
    const stored = await this.load(run.id);
    if (stored.version !== run.version) {
      throw new VersionConflict(run.id, run.version, stored.version);
    }

    const next: Run = { ...run, version: run.version + 1 };
    await this.write(next);
    return next;
  }

  private async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Пишемо в тимчасовий файл і перейменовуємо: rename атомарний, часткового файлу не буде. */
  private async write(run: Run): Promise<void> {
    const target = this.file(run.id);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
    await fs.rename(tmp, target);
  }
}
