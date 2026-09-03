import type { Api } from "./http";
import type { TicketStatus } from "../types";

/**
 * Projects v2 живе тільки в GraphQL, і статус там — кастомне поле single-select.
 * Тому перед першою зміною треба розвʼязати три ідентифікатори й закешувати їх:
 * проєкт, поле Status, і опцію на кожну колонку.
 */

type ProjectMeta = {
  projectId: string;
  statusFieldId: string;
  /** назва колонки → id опції */
  options: Map<string, string>;
};

const META_QUERY = `
query($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) {
      id
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;

const ORG_META_QUERY = META_QUERY.replace("user(login:", "organization(login:");

const ITEMS_QUERY = `
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content { ... on Issue { number } }
        }
      }
    }
  }
}`;

const SET_STATUS = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;

const ADD_ITEM = `
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}`;

export type ProjectItem = { itemId: string; issueNumber: number; status: string | null };

export class Projects {
  private meta: ProjectMeta | null = null;

  constructor(
    private readonly api: Api,
    private readonly owner: string,
    private readonly ownerType: "user" | "organization",
    private readonly number: number,
    private readonly statusNames: Partial<Record<TicketStatus, string>>,
  ) {}

  /** Розвʼязується один раз на процес: ідентифікатори не змінюються. */
  private async load(): Promise<ProjectMeta> {
    if (this.meta) return this.meta;

    const query = this.ownerType === "organization" ? ORG_META_QUERY : META_QUERY;
    const data = await this.api.graphql<{
      user?: { projectV2: RawProject | null } | null;
      organization?: { projectV2: RawProject | null } | null;
    }>(query, { login: this.owner, number: this.number });

    const project = (data.user ?? data.organization)?.projectV2;
    if (!project) throw new Error(`проєкт №${this.number} у ${this.owner} не знайдено`);
    if (!project.field?.id) throw new Error("у проєкті немає поля Status типу single-select");

    this.meta = {
      projectId: project.id,
      statusFieldId: project.field.id,
      options: new Map(project.field.options.map((o) => [o.name, o.id])),
    };
    return this.meta;
  }

  async items(): Promise<ProjectItem[]> {
    const { projectId } = await this.load();
    const all: ProjectItem[] = [];
    let cursor: string | null = null;

    for (;;) {
      const data: ItemsPage = await this.api.graphql<ItemsPage>(ITEMS_QUERY, { projectId, cursor });
      for (const node of data.node.items.nodes) {
        if (!node.content?.number) continue;
        all.push({
          itemId: node.id,
          issueNumber: node.content.number,
          status: node.fieldValueByName?.name ?? null,
        });
      }
      if (!data.node.items.pageInfo.hasNextPage) return all;
      cursor = data.node.items.pageInfo.endCursor;
    }
  }

  /** Назва колонки для нашого статусу; кидає одразу, якщо в проєкті такої немає. */
  columnFor(status: TicketStatus): string {
    const name = this.statusNames[status];
    if (!name) throw new Error(`для статусу ${status} не задана колонка в конфігу`);
    return name;
  }

  async setStatus(itemId: string, status: TicketStatus): Promise<void> {
    const meta = await this.load();
    const column = this.columnFor(status);
    const optionId = meta.options.get(column);
    if (!optionId) {
      throw new Error(`у проєкті немає колонки "${column}"; є: ${[...meta.options.keys()].join(", ")}`);
    }

    await this.api.graphql(SET_STATUS, {
      projectId: meta.projectId,
      itemId,
      fieldId: meta.statusFieldId,
      optionId,
    });
  }

  /** Issue, створений агентом, треба явно додати в проєкт — сам він там не зʼявиться. */
  async add(issueNodeId: string): Promise<string> {
    const { projectId } = await this.load();
    const data = await this.api.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_ITEM, {
      projectId,
      contentId: issueNodeId,
    });
    return data.addProjectV2ItemById.item.id;
  }
}

type RawProject = {
  id: string;
  field: { id: string; options: { id: string; name: string }[] } | null;
};

type ItemsPage = {
  node: {
    items: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: {
        id: string;
        fieldValueByName: { name: string } | null;
        content: { number?: number } | null;
      }[];
    };
  };
};
