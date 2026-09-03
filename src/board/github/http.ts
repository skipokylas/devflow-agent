/**
 * Тонкий клієнт над fetch. Без octokit: нам потрібні лише issues, коментарі й
 * один GraphQL-запит, зате потрібен явний контроль ETag — саме він робить
 * полінг безкоштовним, бо відповідь 304 не рахується в ліміт.
 */

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`GitHub ${status} на ${url}: ${body.slice(0, 200)}`);
  }
}

export class RateLimited extends GitHubError {
  constructor(url: string, readonly resetAt: Date, body: string) {
    super(403, url, body);
  }
}

export type Cached<T> = { etag: string | null; data: T };

/** Мінімум, потрібний дошці. Дозволяє підставити підробку в сценаріях перевірки. */
export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export class GitHub implements Api {
  private readonly etags = new Map<string, Cached<unknown>>();

  constructor(
    private readonly token: string,
    private readonly base = "https://api.github.com",
  ) {}

  /** GET з умовним запитом: при 304 повертається закешоване, ліміт не витрачається. */
  async get<T>(path: string): Promise<T> {
    const url = `${this.base}${path}`;
    const cached = this.etags.get(url);
    const res = await fetch(url, { headers: this.headers(cached?.etag) });

    if (res.status === 304 && cached) return cached.data as T;
    await this.guard(res, url);

    const data = (await res.json()) as T;
    this.etags.set(url, { etag: res.headers.get("etag"), data });
    return data;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.write<T>("POST", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.write<T>("PATCH", path, body);
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.base}/graphql`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(null), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    await this.guard(res, url);

    const payload = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (payload.errors?.length) {
      throw new GitHubError(200, url, payload.errors.map((e) => e.message).join("; "));
    }
    if (!payload.data) throw new GitHubError(200, url, "порожня відповідь GraphQL");
    return payload.data;
  }

  private async write<T>(method: string, path: string, body: unknown): Promise<T> {
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: { ...this.headers(null), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await this.guard(res, url);
    return (await res.json()) as T;
  }

  private headers(etag: string | null | undefined): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "devflow-agent",
      ...(etag ? { "if-none-match": etag } : {}),
    };
  }

  /** 403 з вичерпаним лімітом і 403 через права — різні речі, і поводитись треба по-різному. */
  private async guard(res: Response, url: string): Promise<void> {
    if (res.ok) return;
    const body = await res.text();

    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      if (remaining === "0" && reset) {
        throw new RateLimited(url, new Date(Number(reset) * 1000), body);
      }
    }
    throw new GitHubError(res.status, url, body);
  }
}
