// Public page fetch (v2, D11 reversed by the user 2026-11-06): `hr sync` fetches every public page canon needs,
// so nobody captures Devpost by hand. Polite by construction:
//   - one GET per page URL per sync, plus robots.txt once per host per sync (and at most MAX_REDIRECTS hops,
//     each on the same site and checked against robots.txt);
//   - an honest User-Agent naming the tool and where it lives;
//   - robots.txt respected per RFC 9309: the group for our product token, else `*`; longest match wins, Allow
//     wins a tie; 4xx means no rules; 5xx or unreachable means fetch nothing from that host this sync.
// A page that answers with a login (401/403, a redirect to a login path, or a password form with little text)
// or renders no text without JavaScript is reported "needs the extension": the extension reads only pages that
// need the user's login (or a browser to render). Fetched snapshots are access "public" by definition: the
// request carries no cookies or credentials.
import type { PageSnapshot } from "./schema.ts";

export const USER_AGENT = "HackRecon/2.0 (+https://github.com/atishaypahadiya/hackrecon; a hacker's local tool, one request per page per sync)";
/** The product token robots.txt groups are matched against. */
export const ROBOTS_TOKEN = "hackrecon";
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 20_000;
/** Below this many characters of block text, a page that also shows a password field is a login wall. */
const LOGIN_TEXT_MAX = 800;
/** A block that says the content is still loading: the server sent a shell and JavaScript fills it in. */
const LOADING = /^(loading\b|fetching\b|please wait\b|enable javascript\b|you need to enable javascript\b)/i;
const LOGIN_PATH = /\/(log-?in|sign-?in|sign_in|auth|sso|oauth|session)s?\b/i;

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}
/** "none": no rules apply (no file, 4xx). "deny": unreachable or 5xx, so nothing is fetched from that host. */
export type Robots = RobotsRules | "none" | "deny";

/** The rules for our token from a robots.txt body (RFC 9309 §2.2.1: a group may name several user-agents). */
export function parseRobots(txt: string, token = ROBOTS_TOKEN): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: { allow: [], disallow: [] } }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" && val) cur.rules.allow.push(val);
    if (key === "disallow" && val) cur.rules.disallow.push(val);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return { allow: pick.flatMap((g) => g.rules.allow), disallow: pick.flatMap((g) => g.rules.disallow) };
}

/** `*` matches any run of characters; a trailing `$` anchors the end; everything else is literal. */
const ruleRegex = (rule: string) =>
  new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\$$/, "$")}`);

/** RFC 9309 §2.2.2: the most specific (longest) matching rule wins; Allow wins a tie. */
export function robotsAllows(robots: Robots, pathAndQuery: string): boolean {
  if (robots === "none") return true;
  if (robots === "deny") return false;
  const len = (rules: string[]) => Math.max(-1, ...rules.filter((r) => ruleRegex(r).test(pathAndQuery)).map((r) => r.length));
  const a = len(robots.allow);
  const d = len(robots.disallow);
  return d < 0 || a >= d;
}

/** "refused": HTTP 403 or 429, often bot protection; the last snapshot stands and the next sync tries again. */
export type FetchStatus = "fetched" | "blocked_by_robots" | "needs_extension" | "refused" | "error";
export interface FetchResult {
  url: string;
  status: FetchStatus;
  /** Why, in a sentence the run report prints. */
  detail: string;
  final_url?: string;
  http_status?: number;
  html?: string;
  /** HTTP requests this URL cost (page + redirect hops), robots.txt counted per host separately. */
  requests: number;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const sameSite = (a: URL, b: URL) => {
  const base = (h: string) => h.split(".").slice(-2).join(".");
  return base(a.hostname) === base(b.hostname);
};

/** One sync's worth of polite fetching. Holds robots.txt per host for the run only, so each sync rereads it. */
export class PoliteFetcher {
  private robots = new Map<string, Promise<Robots>>();
  private seen = new Map<string, Promise<FetchResult>>();
  robotsRequests = 0;
  constructor(private fetcher: Fetcher = fetch) {}

  private headers() {
    return { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" };
  }

  robotsFor(origin: string): Promise<Robots> {
    let r = this.robots.get(origin);
    if (!r) {
      this.robotsRequests++;
      r = this.fetcher(`${origin}/robots.txt`, { headers: this.headers(), redirect: "follow", credentials: "omit", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        .then(async (res): Promise<Robots> => (res.ok ? parseRobots(await res.text()) : res.status >= 400 && res.status < 500 ? "none" : "deny"))
        .catch((): Robots => "deny");
      this.robots.set(origin, r);
    }
    return r;
  }

  /** Fetches a URL at most once per sync, however many times it is asked for. `want` is the content type. */
  get(url: string, want: "html" | "json" = "html"): Promise<FetchResult> {
    const key = new URL(url).href;
    let p = this.seen.get(key);
    if (!p) this.seen.set(key, (p = this.fetchOnce(key, want)));
    return p;
  }

  private async fetchOnce(url: string, want: "html" | "json"): Promise<FetchResult> {
    let at = new URL(url);
    let requests = 0;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!robotsAllows(await this.robotsFor(at.origin), at.pathname + at.search))
        return { url, status: "blocked_by_robots", detail: `${at.origin}/robots.txt does not allow ${at.pathname}${(await this.robotsFor(at.origin)) === "deny" ? " (robots.txt unreachable: fetching nothing from this host this sync)" : ""}`, requests };
      let res: Response;
      try {
        requests++;
        res = await this.fetcher(at.href, { headers: this.headers(), redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch (e) {
        return { url, status: "error", detail: `request failed: ${(e as Error).message}`, requests };
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, at);
        if (LOGIN_PATH.test(next.pathname)) return { url, status: "needs_extension", detail: `redirects to a login page (${next.origin}${next.pathname}): capture it with the extension`, final_url: next.href, http_status: res.status, requests };
        if (!sameSite(at, next)) return { url, status: "error", detail: `redirects off-site to ${next.origin}; not followed`, final_url: next.href, http_status: res.status, requests };
        at = next;
        continue;
      }
      if (res.status === 401) return { url, status: "needs_extension", detail: "HTTP 401: the page needs a login; capture it with the extension", final_url: at.href, http_status: res.status, requests };
      // 403/429 is a refusal, not proof of a login wall: Devpost's Cloudflare answered 403 once and 200 two minutes
      // later (2026-11-06). No retry inside a sync (one request per URL); the last snapshot stands.
      if (res.status === 403 || res.status === 429) {
        const cdn = res.headers.get("cf-ray") ? " by Cloudflare" : "";
        return { url, status: "refused", detail: `HTTP ${res.status}${cdn}: refused this sync (bot protection or a login); kept the last snapshot, the next sync tries again`, final_url: at.href, http_status: res.status, requests };
      }
      if (!res.ok) return { url, status: "error", detail: `HTTP ${res.status}`, final_url: at.href, http_status: res.status, requests };
      const type = res.headers.get("content-type") ?? "";
      if (!(want === "json" ? /json/i : /html/i).test(type)) return { url, status: "error", detail: `not ${want === "json" ? "JSON" : "an HTML page"} (${type || "no content-type"})`, final_url: at.href, http_status: res.status, requests };
      return { url, status: "fetched", detail: `HTTP ${res.status}${at.href !== url ? ` via ${at.href}` : ""}`, final_url: at.href, http_status: res.status, html: await res.text(), requests };
    }
    return { url, status: "error", detail: `more than ${MAX_REDIRECTS} redirects`, requests };
  }
}

/** After snapshotting: a page with no text, or a password form and little text, needs the extension. */
export function needsExtension(s: PageSnapshot, html: string): string | null {
  const chars = s.blocks.filter((b) => !b.heading).reduce((n, b) => n + b.text.length, 0);
  if (s.no_text) return `${s.no_text} without JavaScript; capture it with the extension`;
  if (/<input[^>]+type=["']?password/i.test(html) && chars < LOGIN_TEXT_MAX) return "shows a login form; capture it with the extension";
  const loading = s.blocks.find((b) => LOADING.test(b.text));
  if (loading) return `loads its content with JavaScript ("${loading.text.slice(0, 60)}"); capture it with the extension`;
  return null;
}
