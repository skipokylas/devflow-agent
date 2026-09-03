import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { GitHub } from "./board/github/http";
import { listProjects, Projects } from "./board/github/projects";
import { ticketStatusSchema, type TicketStatus } from "./board/types";
import { configPaths, configSchema, type Config } from "./config";
import { listRemotes, normalizeRemote, type RepoRef } from "./repo";

const PROVIDER_BY_HOST: Record<string, "github" | "gitlab"> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
};

const DEFAULT_COLUMNS: Record<TicketStatus, string> = {
  todo: "Ready",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
};

/**
 * Налаштовує репозиторій: обирає remote, знаходить проєкт і — головне — звіряє
 * назви колонок із реальною дошкою. Розбіжність, знайдена зараз, дешевша за ту,
 * що вилізе посеред роботи через тиждень.
 */
export async function init(repo: RepoRef, token: string | undefined): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, fallback = ""): Promise<string> =>
    (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim() || fallback;

  try {
    const remotes = listRemotes(repo.root);
    if (remotes.length === 0) throw new Error("у репозиторії немає жодного remote");

    let chosen = remotes[0]!;
    if (remotes.length > 1) {
      console.log("\nу репозиторії кілька remote:");
      remotes.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} → ${r.url}`));
      const pick = Number(await ask("\nяким користується агент", "1"));
      chosen = remotes[pick - 1] ?? chosen;
    }

    const parsed = normalizeRemote(chosen.url);
    if (!parsed) throw new Error(`не розібрав remote: ${chosen.url}`);

    const provider = PROVIDER_BY_HOST[parsed.host];
    if (provider !== "github") {
      throw new Error(`${parsed.host} поки не підтримується; є лише github.com`);
    }

    const owner = parsed.path.split("/")[0] ?? "";
    console.log(`\nрепозиторій: ${parsed.path}   remote: ${chosen.name}\n`);

    if (!token) throw new Error("немає GITHUB_TOKEN — спершу devflow auth");
    const api = new GitHub(token);

    const ownerType = ((await ask("це користувач чи організація (user/organization)", "user")) ===
    "organization"
      ? "organization"
      : "user") as "user" | "organization";

    const projects = await listProjects(api, owner, ownerType);
    if (projects.length === 0) throw new Error(`у ${owner} немає жодного проєкту Projects v2`);

    console.log("\nпроєкти:");
    for (const p of projects) console.log(`  ${p.number}. ${p.title}`);
    const projectNumber = Number(await ask("\nномер проєкту", String(projects[0]?.number ?? 1)));

    // Звірка колонок — заради цього init і потрібен.
    const board = new Projects(api, owner, ownerType, projectNumber, DEFAULT_COLUMNS);
    const columns = await board.statusOptions();
    console.log(`\nколонки на дошці: ${columns.join(", ")}\n`);

    const statuses: Record<string, string> = {};
    let missing = 0;
    for (const status of ticketStatusSchema.options) {
      const wanted = DEFAULT_COLUMNS[status];
      const exact = columns.find((c) => c.toLowerCase() === wanted.toLowerCase());
      if (exact) {
        statuses[status] = exact;
        console.log(`  ${status.padEnd(12)} → ${exact}`);
        continue;
      }
      missing++;
      const answer = await ask(`  ${status.padEnd(12)} → колонки "${wanted}" немає, яку взяти`, "");
      if (!answer) throw new Error(`для статусу ${status} не обрано колонку`);
      if (!columns.includes(answer)) throw new Error(`на дошці немає колонки "${answer}"`);
      statuses[status] = answer;
    }

    const config: Config = configSchema.parse({
      git: { remote: chosen.name },
      board: { provider, scope: parsed.path, owner, ownerType, projectNumber, statuses },
    });

    const paths = configPaths(repo.root, repo.id);
    const where = await ask("\nзберегти в репозиторії (комітиться) чи локально (r/l)", "r");
    const file = where === "l" ? paths.inHome : paths.inRepo;

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    console.log(`\nзаписано ${file}`);
    if (missing) console.log(`${missing} колонок довелося зіставити вручну`);
    console.log("перевір звʼязок: devflow board");
  } finally {
    rl.close();
  }
}
