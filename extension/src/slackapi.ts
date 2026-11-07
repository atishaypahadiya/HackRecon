// The only way the extension talks to Slack's web API (user 2026-11-07): read-only methods on an allowlist, paced
// well under the web client's limits, backing off on 429. Anything that writes or marks read (chat.*,
// conversations.mark, reactions.*, …) is refused before a request is built. The session token is held here, in the
// service worker's memory; it goes only to the workspace's own https://<name>.slack.com origin and never into a
// return value, an error message or a log line.

/** Every method the extension may call. A test pins this list and checks no other code reaches /api/. */
export const READ_METHODS = ["conversations.list", "conversations.history", "conversations.replies", "users.list", "users.info"] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

/** Minimum gap between calls of one method. Slack's tiers: conversations.list and users.list are Tier 2 (20+ a
 *  minute), history, replies and users.info Tier 3 to 4 (50+ a minute); these run at a half or less of that. */
export const MIN_GAP_MS: Record<ReadMethod, number> = {
  "conversations.list": 6000,
  "users.list": 6000,
  "conversations.history": 3000,
  "conversations.replies": 3000,
  "users.info": 3000,
};
export const MAX_TRIES = 5;
/** Without a Retry-After header: 30 s, doubling each try. */
export const BACKOFF_BASE_MS = 30_000;

export const WORKSPACE_ORIGIN = /^https:\/\/[a-z0-9][a-z0-9-]*\.slack\.com$/;

export class ApiRefused extends Error {}
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`${method}: ${code}`);
  }
}

export interface ApiDeps {
  fetch: (url: string, init: { method: "POST"; body: URLSearchParams; credentials: "include" }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

type Page = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string } } & Record<string, unknown>;

export class SlackApi {
  private last = new Map<ReadMethod, number>();
  calls = 0;
  retries = 0;
  readonly #token: string;

  constructor(
    readonly origin: string,
    token: string,
    private readonly deps: ApiDeps,
  ) {
    if (!WORKSPACE_ORIGIN.test(origin)) throw new ApiRefused(`refused: ${origin} is not a Slack workspace origin`);
    this.#token = token;
  }

  /** True when `text` holds the session token: callers check every file before saving it. */
  holdsToken(text: string): boolean {
    return this.#token.length > 0 && text.includes(this.#token);
  }

  async call(method: string, params: Record<string, string> = {}): Promise<Page> {
    if (!(READ_METHODS as readonly string[]).includes(method)) throw new ApiRefused(`refused: ${method} is not a read-only method on the allowlist`);
    const m = method as ReadMethod;
    for (let attempt = 0; ; attempt++) {
      const wait = (this.last.get(m) ?? -Infinity) + MIN_GAP_MS[m] - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      this.last.set(m, this.deps.now());
      this.calls++;
      const res = await this.deps.fetch(`${this.origin}/api/${m}`, { method: "POST", body: new URLSearchParams({ ...params, token: this.#token }), credentials: "include" });
      const body = res.status === 429 ? null : ((await res.json()) as Page);
      if (res.status === 429 || body?.error === "ratelimited") {
        if (attempt + 1 >= MAX_TRIES) throw new ApiError(m, `rate limited ${MAX_TRIES} times in a row`);
        const after = Number(res.headers.get("retry-after"));
        this.retries++;
        await this.deps.sleep(after > 0 ? after * 1000 : BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }
      if (res.status !== 200 || !body) throw new ApiError(m, `HTTP ${res.status}`);
      if (!body.ok) throw new ApiError(m, String(body.error ?? "not ok"));
      return body;
    }
  }

  /** Every page of a cursor-paginated method, concatenating `key`. */
  async all<T>(method: string, params: Record<string, string>, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor = "";
    do {
      const page = await this.call(method, cursor ? { ...params, cursor } : params);
      out.push(...((page[key] as T[] | undefined) ?? []));
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return out;
  }
}
