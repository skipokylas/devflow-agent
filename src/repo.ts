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
    const parsed = normalizeRemote(remote);
    if (parsed) return `${parsed.host}--${parsed.path.split("/").join("--")}`;
  }
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `local--${path.basename(root)}--${hash}`;
}

export function resolveRepo(dir: string = process.cwd(), remoteName = "origin"): RepoRef {
  const root = git(["rev-parse", "--show-toplevel"], dir) ?? path.resolve(dir);
  const remote = git(["remote", "get-url", remoteName], root);
  return { id: slugOf(remote, root), root, remote };
}

/** Репо з кількома remote — привід спитати людину, а не мовчки взяти origin. */
export function listRemotes(root: string): { name: string; url: string }[] {
  const raw = git(["remote", "-v"], root);
  if (!raw) return [];

  const seen = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (name && url && !seen.has(name)) seen.set(name, url);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/** Хост і шлях із будь-якої форми URL: github.com/org/repo */
export function normalizeRemote(url: string): { host: string; path: string } | null {
  // Порядок важливий: спершу протокол, потім user@, інакше в ssh://git@host
  // хостом стане "git@host".
  const cleaned = url
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^/@]+@/, "")
    .replace(/\.git$/, "")
    .replace(":", "/");
  const [host, ...rest] = cleaned.split("/").filter(Boolean);
  if (!host || rest.length < 2) return null;
  return { host, path: rest.join("/") };
}

/** Стан агента живе поза цільовим репозиторієм: воно не має засмічувати чужий git. */
export function stateDir(repo: RepoRef): string {
  const base = process.env["AGENT_STATE_DIR"] ?? path.join(os.homedir(), ".devflow");
  return path.join(base, repo.id);
}
