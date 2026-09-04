import type { Forge } from "./forge";

/** Forge у памʼяті: наскрізні сценарії проходять шлях до PR без мережі. */
export class InMemoryForge implements Forge {
  readonly pushed: { branch: string; cwd: string }[] = [];
  readonly pulls: { branch: string; title: string; base: string }[] = [];

  async pushBranch(input: { cwd: string; branch: string; remote: string }): Promise<void> {
    this.pushed.push({ branch: input.branch, cwd: input.cwd });
  }

  async openPullRequest(input: { branch: string; title: string; body: string; base: string }) {
    this.pulls.push({ branch: input.branch, title: input.title, base: input.base });
    return { url: `https://github.com/org/repo/pull/${this.pulls.length}`, number: this.pulls.length };
  }
}
