import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Workspace = {
  /** Тека з робочою копією. Саме сюди пишуть інструменти. */
  path: string;
  branch: string;
};

export class GitError extends Error {}

/**
 * Повертає вивід як є. Обрізати не можна: у `git status --porcelain` перші два
 * символи рядка — це статус, і провідний пробіл значущий.
 */
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitError(`git ${args.slice(0, 2).join(" ")}: ${message.split("\n")[1] ?? message}`);
  }
}

/**
 * Окрема робоча копія на задачу через `git worktree`: спільна історія, окремі
 * файли. Твоя тека лишається недоторканою, поки агент редагує свою.
 */
export async function createWorkspace(
  repoRoot: string,
  runId: string,
  baseDir: string,
): Promise<Workspace> {
  const branch = `devflow/${runId}`;
  const dir = path.join(baseDir, runId);

  // Повторний запуск після обриву має підхопити наявне дерево, а не впасти.
  const existing = await fs.stat(dir).then(() => true, () => false);
  if (existing) return { path: dir, branch };

  await fs.mkdir(baseDir, { recursive: true });
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim();
  await git(["worktree", "add", "-b", branch, dir, base], repoRoot);
  await linkDependencies(repoRoot, dir);
  return { path: dir, branch };
}

/**
 * `git worktree` переносить лише відстежувані файли, а `node_modules` у
 * .gitignore. Без цього `tsc` не знаходить @types/node і падає з TS2688 ще до
 * перевірки будь-якого коду — тобто ворота якості провалювались би завжди,
 * незалежно від змін. Симлінк дешевший за `npm ci` у кожній копії.
 */
async function linkDependencies(repoRoot: string, dir: string): Promise<void> {
  const source = path.join(repoRoot, "node_modules");
  if (!(await fs.stat(source).then(() => true, () => false))) return;

  await fs.symlink(source, path.join(dir, "node_modules"), "dir").catch(() => {});

  // Виключаємо локально, а не через .gitignore проєкту: інакше в репозиторії,
  // де node_modules не ігнорується, симлінк робив би копію завжди «брудною» —
  // і потрапив би в коміт.
  const exclude = (await git(["rev-parse", "--git-path", "info/exclude"], dir)).trim();
  const file = path.isAbsolute(exclude) ? exclude : path.join(dir, exclude);
  await fs.mkdir(path.dirname(file), { recursive: true });

  const current = await fs.readFile(file, "utf8").catch(() => "");
  if (!current.includes("/node_modules")) await fs.appendFile(file, "/node_modules\n");
}

/** Прибирає дерево, якщо в ньому нічого не змінилось: сміття не накопичується. */
export async function removeIfClean(repoRoot: string, workspace: Workspace): Promise<boolean> {
  const dirty = (await git(["status", "--porcelain"], workspace.path)).trim();
  const commits = (
    await git(["rev-list", "--count", `HEAD...${workspace.branch}`], workspace.path).catch(() => "0")
  ).trim();
  if (dirty || commits !== "0") return false;

  await git(["worktree", "remove", "--force", workspace.path], repoRoot);
  await git(["branch", "-D", workspace.branch], repoRoot).catch(() => "");
  return true;
}

export async function commitAll(workspace: Workspace, message: string): Promise<boolean> {
  if ((await git(["status", "--porcelain"], workspace.path)).trim() === "") return false;
  await git(["add", "-A"], workspace.path);
  await git(["commit", "-q", "-m", message], workspace.path);
  return true;
}

export async function baseBranch(repoRoot: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).trim();
}

export async function changedFiles(workspace: Workspace): Promise<string[]> {
  const out = await git(["status", "--porcelain"], workspace.path);
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim());
}
