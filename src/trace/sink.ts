import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spanSchema, type Span, type SpanType } from "./types";

export type OpenSpan = { id: string; startedAt: number };

/** Порт: куди лягають спани. Append-only, тому один JSONL на прогін. */
export interface TraceSink {
  write(span: Span): Promise<void>;
  read(runId: string): Promise<Span[]>;
}

export class FileSink implements TraceSink {
  constructor(private readonly dir = ".runs/traces") {}

  private file(runId: string): string {
    return path.join(this.dir, `${runId}.jsonl`);
  }

  async write(span: Span): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.file(span.runId), `${JSON.stringify(span)}\n`, "utf8");
  }

  async read(runId: string): Promise<Span[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(runId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => spanSchema.parse(JSON.parse(line)));
  }
}

/** Спан пишеться одним рядком у момент завершення — тому JSONL лишається append-only. */
export class Tracer {
  constructor(
    private readonly sink: TraceSink,
    private readonly runId: string,
  ) {}

  start(): OpenSpan {
    return { id: `sp_${randomUUID().slice(0, 8)}`, startedAt: Date.now() };
  }

  async finish(
    open: OpenSpan,
    fields: {
      parentId: string | null;
      type: SpanType;
      name: string;
      input?: unknown;
      output?: unknown;
      error?: string | null;
      cost?: Span["cost"];
    },
  ): Promise<void> {
    await this.sink.write({
      id: open.id,
      runId: this.runId,
      parentId: fields.parentId,
      type: fields.type,
      name: fields.name,
      startedAt: open.startedAt,
      endedAt: Date.now(),
      input: fields.input ?? null,
      output: fields.output ?? null,
      error: fields.error ?? null,
      cost: fields.cost ?? null,
    });
  }
}
