import { CliChannel } from "./channel/cli";
import { demoLlm, realLlm } from "./agent/llm";
import type { Deps } from "./agent/loop";
import { promptOf } from "./agent/prompt";
import { defaultTools } from "./agent/tools";
import { FileStorage } from "./db/storage";
import { FileSink } from "./trace/sink";

/** Composition root. Єдине місце, де обираються конкретні реалізації портів. */
export function buildDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    llm: process.env["AGENT_LLM"] === "demo" ? demoLlm() : realLlm(),
    storage: new FileStorage(),
    trace: new FileSink(),
    tools: defaultTools,
    channel: new CliChannel(),
    model: process.env["MODEL"] ?? "claude-opus-5",
    maxSteps: Number(process.env["MAX_STEPS"] ?? 8),
    root: process.cwd(),
    system: promptOf(process.env["AGENT_PROMPT"] ?? "v3"),
    ...overrides,
  };
}
