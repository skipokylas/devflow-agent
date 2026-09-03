import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** Єдиний інструмент, який виконує не реєстр, а цикл: він означає паузу. */
export const ASK_HUMAN = "ask_human";

export type ToolAccess = "read" | "write";

export type ToolContext = {
  runId: string;
  /** Корінь, за межі якого файлові інструменти не виходять. */
  root: string;
  /** Дозволи на write-дії. Порожній набір = агент нічого не змінює. */
  approvedActions: Set<string>;
};

export type Tool = {
  name: string;
  description: string;
  access: ToolAccess;
  input: z.ZodType;
  execute: (input: unknown, ctx: ToolContext) => Promise<string>;
};

export class UnknownTool extends Error {
  constructor(name: string) {
    super(`Інструмента ${name} не існує`);
  }
}

export class NotApproved extends Error {
  constructor(name: string) {
    super(`${name} змінює стан і потребує підтвердження`);
  }
}

/** Схема одночасно описує аргументи для моделі і валідує те, що вона надіслала. */
export function defineTool<S extends z.ZodType>(t: {
  name: string;
  description: string;
  access: ToolAccess;
  input: S;
  execute: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}): Tool {
  return {
    name: t.name,
    description: t.description,
    access: t.access,
    input: t.input,
    execute: (raw, ctx) => t.execute(t.input.parse(raw), ctx),
  };
}

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) this.byName.set(tool.name, tool);
  }

  /** Те, що йде в кожен запит до моделі: назва, опис, JSON-схема аргументів. */
  definitions(): Anthropic.Tool[] {
    return [...this.byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.input) as Anthropic.Tool.InputSchema,
    }));
  }

  async execute(name: string, input: unknown, ctx: ToolContext): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) throw new UnknownTool(name);
    if (name === ASK_HUMAN) throw new Error(`${ASK_HUMAN} обробляє цикл, не реєстр`);
    if (tool.access === "write" && !ctx.approvedActions.has(name)) throw new NotApproved(name);
    return tool.execute(input, ctx);
  }
}

// ─────────────────────────── самі інструменти ───────────────────────────

/** Не дає файловим інструментам вийти за межі проєкту. Сам корінь дозволений. */
function resolveInRoot(ctx: ToolContext, rel: string): string {
  const root = path.resolve(ctx.root);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`шлях за межами проєкту: ${rel}`);
  }
  return target;
}

/**
 * Чужий текст у контексті моделі має бути явно позначений як дані.
 * Будь-хто, хто може відредагувати файл або відкрити issue, інакше може написати
 * туди «ignore previous instructions».
 */
export function untrusted(source: string, text: string): string {
  const safe = text.replace(/<\/untrusted/gi, "<\\/untrusted");
  return `<untrusted source="${source}">\n${safe}\n</untrusted>`;
}

/** Теки, які роздують контекст і нічого не пояснюють про проєкт. */
const IGNORED = new Set([
  "node_modules", ".git", ".runs", "dist", "build", "coverage", ".next", ".turbo",
  ".idea", ".vscode", ".DS_Store",
]);

export const askHuman = defineTool({
  name: ASK_HUMAN,
  description:
    "Поставити питання людині, коли бракує інформації або потрібне підтвердження плану. " +
    "Використовуй замість того, щоб вигадувати відповідь. Виконання зупиниться до відповіді.",
  access: "read",
  input: z.object({
    question: z.string().describe("Одне конкретне питання"),
    options: z.array(z.string()).default([]).describe("Варіанти відповіді, якщо доречні"),
  }),
  execute: async () => {
    throw new Error("недосяжно: ask_human обробляє цикл");
  },
});

export const readFile = defineTool({
  name: "read_file",
  description: "Прочитати текстовий файл проєкту. Шлях відносно кореня репозиторію.",
  access: "read",
  input: z.object({
    path: z.string().describe("Наприклад: src/agent/loop.ts"),
  }),
  execute: async ({ path: rel }, ctx) => {
    const text = await fs.readFile(resolveInRoot(ctx, rel), "utf8");
    const limit = 20_000;
    const body = text.length > limit ? `${text.slice(0, limit)}\n…(обрізано)` : text;
    return untrusted(`file:${rel}`, body);
  },
});

export const listFiles = defineTool({
  name: "list_files",
  description:
    "Перелічити вміст теки деревом. Службові теки (node_modules, .git, dist) пропускаються. " +
    "Використовуй, щоб зорієнтуватись у структурі, перш ніж читати файли.",
  access: "read",
  input: z.object({
    path: z.string().default(".").describe("Тека відносно кореня; типово корінь проєкту"),
    depth: z.number().int().min(1).max(5).default(3).describe("Глибина вкладеності"),
  }),
  execute: async ({ path: rel, depth }, ctx) => {
    const root = resolveInRoot(ctx, rel);
    const lines: string[] = [];
    const limit = 400;

    async function walk(dir: string, prefix: string, left: number): Promise<void> {
      if (left === 0 || lines.length >= limit) return;
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => !IGNORED.has(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (lines.length >= limit) {
          lines.push(`${prefix}…(обрізано на ${limit} записах)`);
          return;
        }
        lines.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}  `, left - 1);
      }
    }

    await walk(root, "", depth);
    return lines.length ? lines.join("\n") : "(порожня тека)";
  },
});

export const defaultTools = new ToolRegistry([askHuman, listFiles, readFile]);
