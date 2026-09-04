import type { Api } from "../board/github/http";
import { GitHub } from "../board/github/http";
import type { Forge } from "./forge";

export class GitHubForge implements Forge {
  private readonly api: Api;

  constructor(
    private readonly scope: string,
    private readonly token: string,
    api?: Api,
  ) {
    this.api = api ?? new GitHub(token);
  }

  /**
   * Токен підставляється в URL лише на час пушу й не осідає в `.git/config`:
   * `git remote set-url` записав би його туди назавжди.
   */
  async pushBranch(input: { cwd: string; branch: string; remote: string }): Promise<void> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const authed = input.remote.replace(/^https:\/\//, `https://x-access-token:${this.token}@`);

    await promisify(execFile)("git", ["push", "-q", "-u", authed, `HEAD:${input.branch}`], {
      cwd: input.cwd,
    });
  }

  async openPullRequest(input: { branch: string; title: string; body: string; base: string }) {
    const pull = await this.api.post<{ html_url: string; number: number }>(
      `/repos/${this.scope}/pulls`,
      { title: input.title, body: input.body, head: input.branch, base: input.base },
    );
    return { url: pull.html_url, number: pull.number };
  }
}
