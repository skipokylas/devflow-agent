import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export type RepoRef = {
  /** Ідентичність за remote URL, не за шляхом: той самий проєкт у двох теках — один агент. */
  id: string;
  root: string;
  remote: string | null;
};

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** github.com--org--repo із будь-якої форми URL; для репо без remote — шлях плюс хеш. */
function slugOf(remote: string | null, root: string): string {
  if (remote) {
    const cleaned = remote
      .replace(/^git@/, "")
      .replace(/^https?:\/\//, "")
      .replace(/\.git$/, "")
      .replace(":", "/");
    return cleaned.split("/").filter(Boolean).join("--");
  }
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `local--${path.basename(root)}--${hash}`;
}

export function resolveRepo(dir: string = process.cwd()): RepoRef {
  const root = git(["rev-parse", "--show-toplevel"], dir) ?? path.resolve(dir);
  const remote = git(["remote", "get-url", "origin"], root);
  return { id: slugOf(remote, root), root, remote };
}

/** Стан агента живе поза цільовим репозиторієм: воно не має засмічувати чужий git. */
export function stateDir(repo: RepoRef): string {
  const base = process.env["AGENT_STATE_DIR"] ?? path.join(os.homedir(), ".devflow");
  return path.join(base, repo.id);
}
