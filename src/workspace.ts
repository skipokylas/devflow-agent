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
  return { path: dir, branch };
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

export async function changedFiles(workspace: Workspace): Promise<string[]> {
  const out = await git(["status", "--porcelain"], workspace.path);
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim());
}
