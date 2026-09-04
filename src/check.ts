import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";

/**
 * Одна команда перед комітом. Перевіряє три різні речі, які ламаються по-різному:
 * код (типи й сценарії), гігієну репозиторію (секрети, сміття) і документи
 * (лічильники, що розходяться з кодом).
 */

let failed = 0;
const say = (ok: boolean, name: string, detail = ""): void => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// ── 1. код ────────────────────────────────────────────────────────────────
const typecheck = spawnSync("npm", ["run", "typecheck"], { encoding: "utf8" });
say(typecheck.status === 0, "типи", typecheck.status === 0 ? "" : "tsc не пройшов");

const pkg = JSON.parse(await fs.readFile("package.json", "utf8")) as { scripts: Record<string, string> };
const suites = Object.keys(pkg.scripts).filter((s) => s.startsWith("try-") && s !== "try-wire");

const counts = new Map<string, number>();
for (const suite of suites) {
  const run = spawnSync("npm", ["run", suite], { encoding: "utf8" });
  const passed = (run.stdout.match(/^✓/gm) ?? []).length;
  counts.set(suite.replace("try-", ""), passed);
  say(run.status === 0, `${suite}`, `${passed} перевірок`);
}
console.log(`  разом ${[...counts.values()].reduce((a, b) => a + b, 0)}\n`);

// ── 2. гігієна репозиторію ────────────────────────────────────────────────
const status = git(["status", "--porcelain"])
  .split("\n")
  .map((l) => l.slice(3).trim())
  .filter(Boolean);

const junk = status.filter(
  (f) => /^src\/_/.test(f) || f.endsWith(".tmp") || f.startsWith(".runs/") || f === ".env",
);
say(junk.length === 0, "немає тимчасових файлів у змінах", junk.join(", "));

const tracked = git(["ls-files"]).split("\n").filter(Boolean);
const shouldNotBeTracked = tracked.filter((f) => f === ".env" || f.startsWith(".runs/") || f === ".devflow/config.json");
say(shouldNotBeTracked.length === 0, "стан і секрети не під git", shouldNotBeTracked.join(", "));

const SECRET = /(sk-ant-[\w-]{20,}|ghp_[\w]{30,}|github_pat_[\w]{30,}|glpat-[\w-]{20,})/;
const leaks: string[] = [];
for (const file of tracked) {
  if (file.endsWith(".example.json") || file === "package-lock.json") continue;
  const body = await fs.readFile(file, "utf8").catch(() => "");
  if (SECRET.test(body)) leaks.push(file);
}
say(leaks.length === 0, "у відстежуваних файлах немає токенів", leaks.join(", "));

// ── 3. архітектура ────────────────────────────────────────────────────────
// Правило «стрілки залежностей ідуть тільки вниз» перевіряється машиною, бо
// інакше воно тримається на памʼяті й ламається тихо.

const CORE = ["src/agent/loop.ts", "src/agent/tools.ts", "src/agent/types.ts", "src/scheduler.ts"];
const CONCRETE = /FileStorage|GitHubBoard|GitHubForge|FileSink|CliChannel|InMemory/;

/** Значущі імпорти: `import type` стирається при компіляції й звʼязку не створює. */
function valueImports(body: string): { from: string; what: string }[] {
  return [...body.matchAll(/^import\s+(?!type\s)(.+?)\s+from\s+"([^"]+)"/gm)].map((m) => ({
    what: m[1] ?? "",
    from: m[2] ?? "",
  }));
}

const coreLeaks: string[] = [];
for (const file of CORE) {
  const body = await fs.readFile(file, "utf8").catch(() => "");
  for (const imported of valueImports(body)) {
    if (CONCRETE.test(imported.what)) coreLeaks.push(`${file} → ${imported.what.trim()}`);
  }
}
say(coreLeaks.length === 0, "ядро не тягне конкретні реалізації", coreLeaks.join("; "));

const PORTS = ["src/board/board.ts", "src/forge/forge.ts", "src/agent/channel.ts", "src/db/storage.ts", "src/trace/sink.ts"];
const portLeaks: string[] = [];
for (const file of PORTS) {
  const body = await fs.readFile(file, "utf8").catch(() => "");
  const imports = [...body.matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? "");
  const bad = imports.filter((i) => /github|gitlab|trello/i.test(i));
  if (bad.length) portLeaks.push(`${file} → ${bad.join(", ")}`);
}
say(portLeaks.length === 0, "порти не залежать від постачальників", portLeaks.join("; "));

// ── 4. документи ──────────────────────────────────────────────────────────
const docs = await Promise.all(
  ["CLAUDE.md", "CHECKLIST.md"].map(async (f) => [f, await fs.readFile(f, "utf8")] as const),
);

const drift: string[] = [];
for (const [name, body] of docs) {
  for (const [suite, actual] of counts) {
    const re = new RegExp(`try-${suite}\`?[^\\n]*?(\\d+)\\s+перевір`, "g");
    for (const m of body.matchAll(re)) {
      if (Number(m[1]) !== actual) drift.push(`${name}: try-${suite} каже ${m[1]}, реально ${actual}`);
    }
  }
}
say(drift.length === 0, "лічильники в документах збігаються з кодом", drift.join("; "));

// Роадмапа не має мовчки відставати: правило про актуалізацію діяло, але за
// ROADMAP.md ніхто не стежив, і вона розійшлася з кодом на десяток комітів.
const sinceRoadmap = git([
  "log",
  "--oneline",
  `${git(["log", "-1", "--format=%H", "--", "ROADMAP.md"]).trim()}..HEAD`,
  "--",
  "src/",
])
  .split("\n")
  .filter(Boolean);

// Правка, що чекає в цьому ж коміті, теж рахується свіжою — інакше перевірка
// падала б саме тоді, коли роадмапу щойно оновили.
const roadmapPending = status.includes("ROADMAP.md");

say(
  roadmapPending || sinceRoadmap.length <= 3,
  "роадмапа не відстала від коду",
  !roadmapPending && sinceRoadmap.length > 3
    ? `${sinceRoadmap.length} комітів у src/ після останньої правки ROADMAP.md`
    : "",
);

// Типові значення в коді й у підказці розходяться тихо: я змінив MAX_STEPS на 25
// у deps.ts і лишив «типово 8» в usage.
const depsBody = await fs.readFile("src/deps.ts", "utf8");
const cliBody = await fs.readFile("src/cli.ts", "utf8");

const drifted: string[] = [];
for (const m of depsBody.matchAll(/process\.env\["(\w+)"\]\s*\?\?\s*(\d+)/g)) {
  const [, name, value] = m;
  const hint = new RegExp(`${name}=[^\\n]*типово (\\d+)`).exec(cliBody);
  if (hint && hint[1] !== value) drifted.push(`${name}: код ${value}, підказка ${hint[1]}`);
}
say(drifted.length === 0, "типові значення збігаються з підказкою", drifted.join("; "));

const claude = docs[0]?.[1] ?? "";
const commands = ["run", "reply", "retry", "board", "watch", "list", "trace", "show", "auth", "init"];
const undocumented = commands.filter((c) => !claude.includes(`devflow ${c}`));
say(undocumented.length === 0, "усі команди згадані в CLAUDE.md", undocumented.join(", "));

console.log(failed === 0 ? "\nможна комітити" : `\nне комітити: ${failed} проблем`);
process.exit(failed === 0 ? 0 : 1);
