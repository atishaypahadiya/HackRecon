// The API pull (user 2026-11-07): read-only methods only, paced, backing off on 429, incremental, and the session
// token never leaves SlackApi.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pull, THREAD_LOOKBACK_S, type PullState } from "./apipull.ts";
import { ApiError, ApiRefused, BACKOFF_BASE_MS, MIN_GAP_MS, READ_METHODS, SlackApi, type ApiDeps } from "./slackapi.ts";

const TOKEN = "xoxc-1234567890-secret-session-token";
const ORIGIN = "https://cal-hacks-13-0.slack.com";

type Reply = { status?: number; retryAfter?: string; body?: Record<string, unknown> };
/** A fake Slack: answers by method; records every request (method, params, time). */
function fakeSlack(answer: (method: string, params: URLSearchParams) => Reply) {
  let t = 1_792_000_000_000;
  const sent: { method: string; params: URLSearchParams; at: number; url: string }[] = [];
  const deps: ApiDeps = {
    now: () => t,
    sleep: async (ms) => void (t += ms),
    fetch: async (url, init) => {
      const method = url.split("/api/")[1]!;
      sent.push({ method, params: init.body, at: t, url });
      const r = answer(method, init.body);
      return { status: r.status ?? 200, headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? (r.retryAfter ?? null) : null) }, json: async () => r.body ?? { ok: true } };
    },
  };
  return { deps, sent, advance: (ms: number) => void (t += ms), now: () => t };
}

describe("SlackApi", () => {
  test("only the five read-only methods; anything that writes or marks read is refused before a request", async () => {
    expect([...READ_METHODS]).toEqual(["conversations.list", "conversations.history", "conversations.replies", "users.list", "users.info"]);
    const s = fakeSlack(() => ({}));
    const api = new SlackApi(ORIGIN, TOKEN, s.deps);
    for (const m of ["chat.postMessage", "conversations.mark", "reactions.add", "conversations.join", "users.setPresence", "auth.revoke"])
      await expect(api.call(m)).rejects.toBeInstanceOf(ApiRefused);
    expect(s.sent).toHaveLength(0);
  });

  test("the token goes only to the workspace's own Slack origin, and never into an error", async () => {
    const s = fakeSlack(() => ({ body: { ok: false, error: "invalid_auth" } }));
    for (const o of ["https://evil.example", "http://cal-hacks-13-0.slack.com", "https://slack.com.evil.example", "https://cal-hacks-13-0.slack.com/"])
      expect(() => new SlackApi(o, TOKEN, s.deps)).toThrow(ApiRefused);
    const api = new SlackApi(ORIGIN, TOKEN, s.deps);
    const err = await api.call("users.list").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(String((err as Error).message)).toBe("users.list: invalid_auth");
    expect(JSON.stringify(api)).not.toContain(TOKEN);
    expect(s.sent[0]!.url).toBe(`${ORIGIN}/api/users.list`);
    expect(s.sent[0]!.params.get("token")).toBe(TOKEN);
  });

  test("paced per method", async () => {
    const s = fakeSlack(() => ({}));
    const api = new SlackApi(ORIGIN, TOKEN, s.deps);
    for (let i = 0; i < 3; i++) await api.call("conversations.history", { channel: "C1" });
    await api.call("users.list");
    await api.call("users.list");
    const at = (m: string) => s.sent.filter((x) => x.method === m).map((x) => x.at);
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    expect(gaps(at("conversations.history"))).toEqual([MIN_GAP_MS["conversations.history"], MIN_GAP_MS["conversations.history"]]);
    expect(gaps(at("users.list"))).toEqual([MIN_GAP_MS["users.list"]]);
  });

  test("429: waits Retry-After, else backs off doubling; gives up after five", async () => {
    let n = 0;
    const s = fakeSlack(() => (++n <= 2 ? { status: 429, ...(n === 1 ? { retryAfter: "7" } : {}) } : { body: { ok: true, members: [] } }));
    const api = new SlackApi(ORIGIN, TOKEN, s.deps);
    await api.call("users.list");
    const at = s.sent.map((x) => x.at);
    expect(at[1]! - at[0]!).toBe(7000);
    expect(at[2]! - at[1]!).toBe(BACKOFF_BASE_MS * 2);
    expect(api.retries).toBe(2);
    const always = fakeSlack(() => ({ status: 429, retryAfter: "1" }));
    await expect(new SlackApi(ORIGIN, TOKEN, always.deps).call("users.list")).rejects.toThrow("rate limited 5 times");
    expect(always.sent).toHaveLength(5);
  });

  test("no other extension code reaches Slack's API, and no write or mark method is named anywhere", () => {
    const dir = import.meta.dir;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      // Code only: comments may name what's refused.
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (f !== "slackapi.ts") expect({ f, api: /\/api\/|slack\.com\/api/.test(src) }).toEqual({ f, api: false });
      expect({ f, write: /\b(chat\.[a-zA-Z]+|conversations\.(mark|join|leave|open|close|invite|kick|archive|rename|set[A-Z]\w*|create)|reactions\.\w+|pins\.\w+|stars\.\w+|files\.(upload|delete))\b/.test(src) }).toEqual({ f, write: false });
    }
  });
});

describe("pull", () => {
  const channels = [
    { id: "C0", name: "0-announcements" },
    { id: "C1", name: "spons-apify" },
    { id: "C2", name: "random" },
    { id: "C3", name: "1-team-formation" },
  ];
  const config = { event: "Cal Hacks 13.0", channels: ["0-announcements", "spons-apify", "cohost-gone"] };

  function slackWith(history: Record<string, Record<string, unknown>[]>, replies: Record<string, Record<string, unknown>[]>) {
    return fakeSlack((method, p) => {
      if (method === "conversations.list") return { body: { ok: true, channels } };
      if (method === "users.list") return { body: { ok: true, members: [{ id: "U1", is_admin: true }] } };
      if (method === "conversations.history") {
        const oldest = Number(p.get("oldest") ?? 0);
        return { body: { ok: true, messages: (history[p.get("channel")!] ?? []).filter((m) => Number(m.ts) > oldest) } };
      }
      if (method === "conversations.replies") return { body: { ok: true, messages: replies[`${p.get("channel")}:${p.get("ts")}`] ?? [] } };
      return { body: { ok: false, error: "unexpected" } };
    });
  }
  const io = (s: ReturnType<typeof fakeSlack>) => {
    const saved: Record<string, string> = {};
    return { saved, io: { save: async (name: string, v: unknown) => ((saved[name] = JSON.stringify(v)), null), progress: async () => {}, now: s.now } };
  };

  test("first pull: the config's channels, then prefix finds, then hacker-only channels; every thread; users and channels", async () => {
    const now = 1_792_000_000;
    const s = slackWith(
      { C0: [{ ts: `${now - 100}.000001`, text: "hi", reply_count: 2 }], C1: [{ ts: `${now - 50}.000001`, text: "credits" }], C3: [{ ts: `${now - 10}.000001`, text: "team?" }] },
      { [`C0:${now - 100}.000001`]: [{ ts: `${now - 100}.000001` }, { ts: `${now - 90}.000001`, thread_ts: `${now - 100}.000001` }, { ts: `${now - 80}.000001`, thread_ts: `${now - 100}.000001` }] },
    );
    const api = new SlackApi(ORIGIN, TOKEN, s.deps);
    const { saved, io: x } = io(s);
    const { state, log } = await pull(api, config, { channels: {} }, x);
    expect(log.channels.map((c) => c.name)).toEqual(["0-announcements", "spons-apify", "1-team-formation"]);
    expect(log.missing).toEqual(["cohost-gone"]);
    expect(Object.keys(saved).sort()).toEqual(["C0.json", "C1.json", "C3.json", "channels.json", "users.json"]);
    const c0 = JSON.parse(saved["C0.json"]!);
    expect(c0.oldest).toBeNull();
    expect(Object.values(c0.replies as Record<string, unknown[]>)[0]).toHaveLength(2); // the parent itself dropped
    expect(state.channels.C0).toEqual({ newest: `${now - 100}.000001`, threads: { [`${now - 100}.000001`]: 2 } });
    for (const v of Object.values(saved)) expect(v).not.toContain(TOKEN);
    expect(s.sent.map((x) => x.method).filter((m) => !(READ_METHODS as readonly string[]).includes(m))).toEqual([]);
  });

  test("next pull: only posts after the cursor (less the lookback); replies again only where the count grew", async () => {
    const now = 1_792_000_000;
    const old = `${now - 3 * 86400}.000001`; // outside the lookback
    const recent = `${now - 3600}.000001`; // inside it
    const prev: PullState = { channels: { C0: { newest: recent, threads: { [old]: 1, [recent]: 1 } }, C1: { newest: recent, threads: {} } } };
    const s = slackWith(
      { C0: [{ ts: old, reply_count: 5 }, { ts: recent, reply_count: 2 }, { ts: `${now - 60}.000001`, text: "new post" }], C1: [{ ts: recent }] },
      { [`C0:${recent}`]: [{ ts: recent }, { ts: `${now - 3500}.000001`, thread_ts: recent }, { ts: `${now - 30}.000001`, thread_ts: recent }] },
    );
    const api = new SlackApi(ORIGIN, TOKEN, s.deps);
    const { saved, io: x } = io(s);
    const { state, log } = await pull(api, config, prev, x);
    const hist = s.sent.filter((r) => r.method === "conversations.history");
    expect(hist.map((r) => r.params.get("oldest"))).toEqual([String(now - THREAD_LOOKBACK_S), String(now - THREAD_LOOKBACK_S), null].slice(0, hist.length));
    expect(s.sent.filter((r) => r.method === "conversations.replies").map((r) => r.params.get("ts"))).toEqual([recent]); // the old parent isn't re-listed
    expect(state.channels.C0!.newest).toBe(`${now - 60}.000001`);
    expect(state.channels.C0!.threads[recent]).toBe(2);
    expect(Object.keys(saved)).toContain("C0.json");
    expect(Object.keys(saved)).not.toContain("C1.json"); // nothing new there
    expect(log.full).toBe(false);
  });

  test("a channel that fails keeps its cursor, and the pull goes on", async () => {
    const s = fakeSlack((method, p) =>
      method === "conversations.list" ? { body: { ok: true, channels } } : method === "conversations.history" && p.get("channel") === "C0" ? { body: { ok: false, error: "channel_not_found" } } : { body: { ok: true, messages: [], members: [] } },
    );
    const { io: x } = io(s);
    const prev: PullState = { channels: { C0: { newest: "1791000000.000001", threads: {} } } };
    const { state, log } = await pull(new SlackApi(ORIGIN, TOKEN, s.deps), config, prev, x);
    expect(log.channels.find((c) => c.id === "C0")!.error).toBe("channel_not_found");
    expect(state.channels.C0).toEqual(prev.channels.C0!);
    expect(log.channels.map((c) => c.name)).toContain("spons-apify");
  });
});
