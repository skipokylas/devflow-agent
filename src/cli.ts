import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { advance, resume, retry, NotRetryable, NotWaiting, type Deps } from "./agent/loop";
import { buildDeps } from "./deps";
import { stateDir } from "./repo";
import { InMemoryBoard } from "./board/memory";
import { GitHubBoard } from "./board/github/board";
import type { Board } from "./board/board";
import { loadConfig } from "./config";
import { watch } from "./scheduler";
import { RunNotFound } from "./db/storage";
import { summary, toHtml, toText } from "./trace/render";
import type { Run } from "./agent/types";

const deps = buildDeps();
const { storage, trace, repo } = deps;
const traceDir = path.join(stateDir(repo), "traces");

function usage(): void {
  console.log(`Використання:
  agent run "<задача>"              створити run і працювати до паузи
  agent reply <runId> "<відповідь>" продовжити run, що чекає на людину
  agent retry <runId>               повторити перерваний run (failed або обірваний)
  agent board                       перевірити звʼязок із дошкою: готові квитки
  agent watch                       планувальник: бере задачі з дошки й веде їх
  agent list                        усі runs цього репозиторію
  agent trace <runId>               дерево кроків: що робив і скільки коштувало
  agent show <runId>                показати стан run

Змінні оточення:
  AGENT_LLM=demo   офлайн-модель без мережі й витрат
  AGENT_PROMPT=v1  варіант системного промпта (типово v4)
  AGENT_REPO=path  репозиторій, з яким працюємо (типово поточна тека)
  AGENT_BOARD=memory  дошка в памʼяті замість GitHub (для перевірок)
  GITHUB_TOKEN     токен зі scope repo і project
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
    ticket: null,
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

async function buildBoard(): Promise<Board> {
  const config = await loadConfig(repo.root);
  const token = process.env["GITHUB_TOKEN"];

  if (!config.board) throw new Error("немає .devflow/config.json з секцією board");
  if (!token) throw new Error("немає GITHUB_TOKEN у .env");

  return new GitHubBoard({
    token,
    scope: config.board.scope,
    owner: config.board.owner,
    ownerType: config.board.ownerType,
    projectNumber: config.board.projectNumber,
    statuses: config.board.statuses,
  });
}

async function cmdWatch(): Promise<void> {
  const board = process.env["AGENT_BOARD"] === "memory" ? new InMemoryBoard() : await buildBoard();
  const interval = Number(process.env["WATCH_INTERVAL"] ?? 30) * 1000;

  console.log(`${repo.id}  опитування раз на ${interval / 1000}с, Ctrl+C щоб зупинити\n`);
  await watch(deps, board, { intervalMs: interval });
}

async function cmdBoard(): Promise<void> {
  const board = await buildBoard();
  const tickets = await board.ready();

  console.log(`готових квитків: ${tickets.length}\n`);
  for (const t of tickets) {
    console.log(`#${t.ref.externalId}  ${t.title}`);
    console.log(`${" ".repeat(4)}${t.ref.url}`);
  }
}

async function cmdList(): Promise<void> {
  const runs = await storage.list();
  console.log(`${repo.id}\n`);
  if (runs.length === 0) {
    console.log("немає жодного run");
    return;
  }

  for (const run of runs) {
    const first = run.messages[0];
    const task =
      typeof first?.content === "string"
        ? first.content
        : (first?.content ?? []).map((b) => ("text" in b ? b.text : "")).join(" ");
    console.log(
      `${run.id}  ${run.status.padEnd(13)} ${String(run.messages.length).padStart(3)} повід.  ` +
        `${task.replace(/\s+/g, " ").slice(0, 46)}`,
    );
    if (run.pending) console.log(`${" ".repeat(14)}чекає: ${run.pending.question.slice(0, 60)}`);
  }
}

async function cmdTrace(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("потрібен id: agent trace <runId>");

  const spans = await trace.read(id);
  if (spans.length === 0) throw new Error(`для ${id} немає трейсу`);

  const s = summary(spans);
  console.log(
    `${id}  ${s.llmCalls} звернень · ${s.toolCalls} інструментів · ${s.errors} помилок · ` +
      `${s.inputTokens}→${s.outputTokens} токенів · $${s.cost.toFixed(4)}\n`,
  );
  console.log(toText(spans));

  const file = path.join(traceDir, `${id}.html`);
  await fs.writeFile(file, toHtml(id, spans), "utf8");
  console.log(`\nводоспад: open ${file}`);
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
    case "board":
      await cmdBoard();
      break;
    case "watch":
      await cmdWatch();
      break;
    case "list":
      await cmdList();
      break;
    case "trace":
      await cmdTrace(rest);
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
