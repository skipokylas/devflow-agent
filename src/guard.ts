import type { Run } from "./agent/types";
import type { Config } from "./config";
import { normalizeRemote, type RepoRef } from "./repo";

export class RepoMismatch extends Error {}

/**
 * Найнебезпечніший сценарій: конфіг вказує на дошку одного хоста, а git remote
 * веде на інший. Тоді агент читає задачі звідти, а зміни пише туди. Fail closed:
 * відмова з поясненням, а не спроба вгадати.
 */
export function assertBoardMatchesRemote(config: Config, repo: RepoRef): void {
  if (!config.board) return;
  if (!repo.remote) {
    throw new RepoMismatch(
      `конфіг вказує на ${config.board.scope}, але в репозиторії немає remote "${config.git.remote}"`,
    );
  }

  const remote = normalizeRemote(repo.remote);
  if (!remote) throw new RepoMismatch(`не розібрав remote: ${repo.remote}`);

  const expectedHost = { github: "github.com", gitlab: "gitlab.com", trello: "" }[config.board.provider];
  if (expectedHost && remote.host !== expectedHost) {
    throw new RepoMismatch(
      `дошка ${config.board.provider} (${config.board.scope}), а remote веде на ${remote.host} — ` +
        `перевір .devflow/config.json і git remote ${config.git.remote}`,
    );
  }

  if (remote.path.toLowerCase() !== config.board.scope.toLowerCase()) {
    throw new RepoMismatch(
      `дошка налаштована на ${config.board.scope}, а remote — ${remote.path}`,
    );
  }
}

/**
 * Run, створений в іншому репозиторії, не можна продовжувати тут. Поки стан
 * лежить у теці на кожне репо, це майже неможливо; після спільної бази — легко.
 */
export function assertRunBelongs(run: Run, repo: RepoRef): void {
  if (!run.repo) return; // Старі runs без привʼязки лежать у теці свого репо.
  if (run.repo.id === repo.id) return;

  throw new RepoMismatch(
    `${run.id} належить репозиторію ${run.repo.id}, а ти в ${repo.id}`,
  );
}

export function bindingOf(repo: RepoRef): Run["repo"] {
  return { id: repo.id, remote: repo.remote };
}
