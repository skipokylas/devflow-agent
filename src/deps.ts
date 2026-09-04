import { CliChannel } from "./channel/cli";
import { demoLlm, realLlm } from "./agent/llm";
import type { Deps } from "./agent/loop";
import { promptOf } from "./agent/prompt";
import { defaultTools } from "./agent/tools";
import path from "node:path";
import { FileStorage } from "./db/storage";
import { resolveRepo, stateDir, type RepoRef } from "./repo";
import { FileSink } from "./trace/sink";

/** Composition root. Єдине місце, де обираються конкретні реалізації портів. */
export function buildDeps(overrides: Partial<Deps> = {}, remoteName = "origin"): Deps & { repo: RepoRef } {
  const repo = resolveRepo(process.env["AGENT_REPO"] ?? process.cwd(), remoteName);
  const state = stateDir(repo);

  return {
    repo,
    llm: process.env["AGENT_LLM"] === "demo" ? demoLlm() : realLlm(),
    storage: new FileStorage(path.join(state, "runs")),
    trace: new FileSink(path.join(state, "traces")),
    tools: defaultTools,
    channel: new CliChannel(),
    model: process.env["MODEL"] ?? "claude-opus-5",
    // Задача з написанням коду — це десятки дрібних правок і перевірок.
    // Вісім кроків вистачало на аналіз і планування, але не на роботу.
    maxSteps: Number(process.env["MAX_STEPS"] ?? 25),
    root: repo.root,
    system: promptOf(process.env["AGENT_PROMPT"] ?? "v6"),
    ...overrides,
  };
}
