import { configPaths, configSchema, loadConfig } from "./config";
import { listProjects } from "./board/github/projects";
import type { Api } from "./board/github/http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

// 1. порядок пошуку конфігу: репозиторій виграє над домівкою
const tmp = path.join(os.tmpdir(), `devflow-init-${Date.now()}`);
await fs.mkdir(path.join(tmp, ".devflow"), { recursive: true });

const base = {
  board: { provider: "github", scope: "org/repo", owner: "org", projectNumber: 1 },
};

check("порожня тека → конфіг без дошки", (await loadConfig(tmp, "slug")).board === undefined);

await fs.writeFile(
  path.join(tmp, ".devflow", "config.json"),
  JSON.stringify({ ...base, board: { ...base.board, projectNumber: 7 } }),
);
check("конфіг із репозиторію читається", (await loadConfig(tmp, "slug")).board?.projectNumber === 7);

const paths = configPaths(tmp, "slug");
check("шлях у репо всередині проєкту", paths.inRepo.startsWith(tmp));
check("шлях у домівці поза проєктом", paths.inHome.includes(".devflow/repos/slug.json"));

// 2. типові колонки підставляються, якщо їх не задано
const parsed = configSchema.parse(base);
check("типова колонка для todo", parsed.board?.statuses.todo === "Ready");
check("типова колонка для in_review", parsed.board?.statuses.in_review === "In review");
check("типовий remote", parsed.git.remote === "origin");

// 3. невалідний scope відкидається
check("scope без слеша → помилка", !configSchema.safeParse({ board: { ...base.board, scope: "repo" } }).success);
check("projectNumber нуль → помилка", !configSchema.safeParse({ board: { ...base.board, projectNumber: 0 } }).success);

// 4. перелік проєктів розбирається для user і для organization
const api: Api = {
  async get<T>(): Promise<T> {
    return {} as T;
  },
  async post<T>(): Promise<T> {
    return {} as T;
  },
  async patch<T>(): Promise<T> {
    return {} as T;
  },
  async graphql<T>(query: string): Promise<T> {
    const nodes = [{ number: 3, title: "devflow" }];
    return (query.includes("organization(login:") ? { organization: { projectsV2: { nodes } } } : { user: { projectsV2: { nodes } } }) as T;
  },
};

check("проєкти користувача", (await listProjects(api, "org", "user"))[0]?.number === 3);
check("проєкти організації", (await listProjects(api, "org", "organization"))[0]?.title === "devflow");

await fs.rm(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
