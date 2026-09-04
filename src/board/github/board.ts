import { isMine, type Board } from "../board";
import type { BoardComment, Ticket, TicketRef, TicketStatus } from "../types";
import { GitHub, type Api } from "./http";
import { Projects } from "./projects";

type Issue = {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  labels: { name: string }[];
};

type Comment = {
  id: number;
  body: string;
  created_at: string;
  user: { login: string } | null;
};

export type GitHubBoardConfig = {
  token: string;
  /** "org/repo" */
  scope: string;
  owner: string;
  ownerType: "user" | "organization";
  projectNumber: number;
  statuses: Partial<Record<TicketStatus, string>>;
  /** Логін, від імені якого пише агент — щоб відрізняти свої коментарі. */
  self?: string;
};

/**
 * Issues і коментарі — REST, дошка — GraphQL. Статус живе в проєкті, а не в
 * issue, тому кожен виклик звіряє два джерела.
 */
export class GitHubBoard implements Board {
  private readonly api: Api;
  private readonly projects: Projects;

  constructor(
    private readonly cfg: GitHubBoardConfig,
    api?: Api,
  ) {
    this.api = api ?? new GitHub(cfg.token);
    this.projects = new Projects(this.api, cfg.owner, cfg.ownerType, cfg.projectNumber, cfg.statuses);
  }

  async ready(): Promise<Ticket[]> {
    const column = this.projects.columnFor("todo");
    const items = (await this.projects.items()).filter((i) => i.status === column);

    return Promise.all(items.map((i) => this.ticket(i.issueNumber, "todo")));
  }

  async get(ref: TicketRef): Promise<Ticket> {
    const status = await this.statusOf(Number(ref.externalId));
    return this.ticket(Number(ref.externalId), status);
  }

  async setStatus(ref: TicketRef, status: TicketStatus): Promise<void> {
    const number = Number(ref.externalId);
    const items = await this.projects.items();
    const item = items.find((i) => i.issueNumber === number);

    if (item) {
      await this.projects.setStatus(item.itemId, status);
      return;
    }

    // Issue ще не на дошці — додаємо, потім ставимо статус.
    const issue = await this.api.get<Issue>(`/repos/${this.cfg.scope}/issues/${number}`);
    const itemId = await this.projects.add(issue.node_id);
    await this.projects.setStatus(itemId, status);
  }

  async createTicket(input: { title: string; body: string; labels?: string[] }): Promise<TicketRef> {
    const issue = await this.api.post<Issue>(`/repos/${this.cfg.scope}/issues`, {
      title: input.title,
      body: input.body,
      ...(input.labels?.length ? { labels: input.labels } : {}),
    });

    const ref: TicketRef = {
      provider: "github",
      scope: this.cfg.scope,
      externalId: String(issue.number),
      url: issue.html_url,
    };

    // Створений issue сам на дошці не зʼявиться — додаємо і кладемо в backlog:
    // агент пропонує роботу, а запускає її людина, перетягуючи в Ready.
    const itemId = await this.projects.add(issue.node_id);
    await this.projects.setStatus(itemId, "backlog");
    return ref;
  }

  /** Обмеження: дивимось сотню найсвіжіших issues. Для повторного прогону цього досить. */
  async findByMarker(marker: string): Promise<TicketRef | null> {
    const issues = await this.api.get<Issue[]>(
      `/repos/${this.cfg.scope}/issues?state=all&per_page=100`,
    );
    const found = issues.find((i) => (i.body ?? "").includes(marker));
    if (!found) return null;

    return {
      provider: "github",
      scope: this.cfg.scope,
      externalId: String(found.number),
      url: found.html_url,
    };
  }

  async comment(ref: TicketRef, body: string): Promise<string> {
    const created = await this.api.post<{ id: number }>(
      `/repos/${this.cfg.scope}/issues/${ref.externalId}/comments`,
      { body },
    );
    return String(created.id);
  }

  async editComment(_ref: TicketRef, commentId: string, body: string): Promise<void> {
    await this.api.patch(`/repos/${this.cfg.scope}/issues/comments/${commentId}`, { body });
  }

  async commentsSince(ref: TicketRef, since: string): Promise<BoardComment[]> {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const raw = await this.api.get<Comment[]>(
      `/repos/${this.cfg.scope}/issues/${ref.externalId}/comments${query}`,
    );

    return raw
      .filter((c) => c.created_at > since)
      .map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? "?",
        mine: isMine(c.body),
        body: c.body,
        createdAt: c.created_at,
      }));
  }

  private async statusOf(number: number): Promise<TicketStatus> {
    const item = (await this.projects.items()).find((i) => i.issueNumber === number);
    if (!item?.status) return "todo";

    const found = (Object.entries(this.cfg.statuses) as [TicketStatus, string][]).find(
      ([, column]) => column === item.status,
    );
    return found?.[0] ?? "todo";
  }

  private async ticket(number: number, status: TicketStatus): Promise<Ticket> {
    const issue = await this.api.get<Issue>(`/repos/${this.cfg.scope}/issues/${number}`);
    return {
      ref: {
        provider: "github",
        scope: this.cfg.scope,
        externalId: String(issue.number),
        url: issue.html_url,
      },
      title: issue.title,
      body: issue.body ?? "",
      status,
      labels: issue.labels.map((l) => l.name),
      updatedAt: issue.updated_at,
    };
  }
}
