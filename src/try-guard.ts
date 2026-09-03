import { assertBoardMatchesRemote, assertRunBelongs, RepoMismatch } from "./guard";
import { configSchema } from "./config";
import { normalizeRemote, type RepoRef } from "./repo";
import type { Run } from "./agent/types";
import { newRun } from "./agent/run";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

function refuses(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof RepoMismatch ? e.message : null;
  }
}

const config = configSchema.parse({
  board: { provider: "github", scope: "org/repo", owner: "org", projectNumber: 3 },
});

const repo = (remote: string | null, id = "github.com--org--repo"): RepoRef => ({
  id,
  root: "/tmp/repo",
  remote,
});

// 1. форми URL зводяться до одного вигляду
for (const url of [
  "https://github.com/org/repo.git",
  "git@github.com:org/repo.git",
  "ssh://git@github.com/org/repo",
]) {
  const n = normalizeRemote(url);
  check(`${url.slice(0, 34)} → github.com/org/repo`, n?.host === "github.com" && n?.path === "org/repo");
}

// 2. збіг проходить
check("дошка і remote збігаються → без помилки",
  refuses(() => assertBoardMatchesRemote(config, repo("git@github.com:org/repo.git"))) === null);

// 3. інший хост відбивається — найнебезпечніший випадок
const otherHost = refuses(() => assertBoardMatchesRemote(config, repo("git@gitlab.com:org/repo.git")));
check("дошка github при remote gitlab → відмова", otherHost !== null);
check("повідомлення називає обидва боки", otherHost?.includes("gitlab.com") === true, otherHost ?? "");

// 4. той самий хост, але інший проєкт
check("інший шлях у тому ж хості → відмова",
  refuses(() => assertBoardMatchesRemote(config, repo("git@github.com:org/other.git"))) !== null);

// 5. немає remote взагалі
check("немає remote → відмова",
  refuses(() => assertBoardMatchesRemote(config, repo(null))) !== null);

// 6. run з іншого репо не продовжується тут
const run = (repoId: string | null): Run => ({
  ...newRun({ id: "run_1", status: "waiting_human" }),
  repo: repoId === null ? null : { id: repoId, remote: null },
});

check("run цього репо → без помилки",
  refuses(() => assertRunBelongs(run("github.com--org--repo"), repo("git@github.com:org/repo.git"))) === null);
check("run чужого репо → відмова",
  refuses(() => assertRunBelongs(run("github.com--org--shop"), repo("git@github.com:org/repo.git"))) !== null);
check("старий run без привʼязки проходить",
  refuses(() => assertRunBelongs(run(null), repo("git@github.com:org/repo.git"))) === null);

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
