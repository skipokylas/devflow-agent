import { randomUUID } from "node:crypto";
import { CliChannel } from "./channel/cli";
import { advance, resume, retry, NotRetryable, NotWaiting, type Deps } from "./agent/loop";
import { demoLlm, realLlm } from "./agent/llm";
import { defaultTools } from "./agent/tools";
import { FileStorage, RunNotFound } from "./db/storage";
import type { Run } from "./agent/types";

// Composition root: єдине місце, де обираються конкретні реалізації портів.
const storage = new FileStorage();

const deps: Deps = {
  llm: process.env["AGENT_LLM"] === "demo" ? demoLlm() : realLlm(),
  storage,
  tools: defaultTools,
  channel: new CliChannel(),
  model: process.env["MODEL"] ?? "claude-opus-5",
  maxSteps: Number(process.env["MAX_STEPS"] ?? 8),
  root: process.cwd(),
  system:
    "Ти — менеджер розробки. Працюєш з репозиторієм користувача. " +
    "Перш ніж щось стверджувати про код, читай файли інструментом read_file. " +
    "Якщо бракує інформації або потрібне підтвердження — питай через ask_human, не вигадуй.",
};

function usage(): void {
  console.log(`Використання:
  agent run "<задача>"              створити run і працювати до паузи
  agent reply <runId> "<відповідь>" продовжити run, що чекає на людину
  agent retry <runId>               повторити перерваний run (failed або обірваний)
  agent show <runId>                показати стан run

Змінні оточення:
  AGENT_LLM=demo   офлайн-модель без мережі й витрат
  MODEL=...        модель (типово claude-opus-5)
  MAX_STEPS=...    ліміт кроків циклу (типово 8)`);
}

function newRun(task: string): Run {
  return {
    id: `run_${randomUUID().slice(0, 8)}`,
    status: "running",
    messages: [{ role: "user", content: task }],
    pending: null,
    error: null,
    version: 0,
  };
}

async function cmdRun(args: string[]): Promise<void> {
  const task = args[0];
  if (!task) throw new Error(`потрібна задача: agent run "<задача>"`);

  const created = await storage.create(newRun(task));
  console.log(`${created.id} створено\n`);

  const finished = await advance(created, deps);
  console.log(`\n${finished.id} → ${finished.status}`);
}

async function cmdReply(args: string[]): Promise<void> {
  const [id, answer] = args;
  if (!id || !answer) throw new Error(`потрібні id і відповідь: agent reply <runId> "<відповідь>"`);

  const finished = await resume(id, answer, deps);
  console.log(`\n${finished.id} → ${finished.status}`);
}

async function cmdRetry(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("потрібен id: agent retry <runId>");

  const finished = await retry(id, deps);
  console.log(`\n${finished.id} → ${finished.status}`);
}

async function cmdShow(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("потрібен id: agent show <runId>");

  const run = await storage.load(id);
  console.log(`${run.id}  статус ${run.status}  version ${run.version}`);
  console.log(`повідомлень: ${run.messages.length}`);
  if (run.pending) console.log(`чекає на: ${run.pending.question}`);
  if (run.error) console.log(`причина падіння: ${run.error}`);

  for (const [i, m] of run.messages.entries()) {
    const body =
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => ("text" in b ? b.text : `[${b.type}]`)).join(" ");
    console.log(`  [${i}] ${m.role.padEnd(9)} ${body.replace(/\s+/g, " ").slice(0, 70)}`);
  }
}

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "run":
      await cmdRun(rest);
      break;
    case "reply":
      await cmdReply(rest);
      break;
    case "retry":
      await cmdRetry(rest);
      break;
    case "show":
      await cmdShow(rest);
      break;
    default:
      usage();
      process.exit(1);
  }
} catch (err) {
  if (err instanceof RunNotFound || err instanceof NotWaiting || err instanceof NotRetryable) console.error(`помилка: ${err.message}`);
  else if (err instanceof Error) console.error(`помилка: ${err.message}`);
  else throw err;
  process.exit(1);
}
