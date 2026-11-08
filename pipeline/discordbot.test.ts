// The Donna bot (user 2026-11-07): GET only on four read routes, the token only in the Authorization header, paced
// and backing off on 429; a poll reads crossposts from followed announcement channels and nothing else.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_MIN_GAP_MS, BOT_ROUTES, BotError, BotRefused, DiscordBot, pollBot, renderContent, type BotDeps } from "./discordbot.ts";
import { idOf, replay } from "./testdata/discord-replay.ts";

const TOKEN = "MTQwMDAwMDAwMDAwMDAwMDAwMQ.Gx1y2z.abcdefghijklmnopqrstuvwxyz0123456789ABCD";
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function fakeDiscord(answer: (path: string, q: URLSearchParams) => Reply) {
  let t = 1_794_700_000_000;
  const sent: { path: string; q: URLSearchParams; at: number; init: { method: string; headers: Record<string, string> } }[] = [];
  const deps: BotDeps = {
    now: () => t,
    sleep: async (ms) => void (t += ms),
    fetch: async (url, init) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/api\/v10/, "");
      sent.push({ path, q: u.searchParams, at: t, init });
      const r = answer(path, u.searchParams);
      return { status: r.status ?? 200, headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null }, json: async () => r.body ?? [] };
    },
  };
  return { deps, sent };
}

const own = replay.own_server;
const botPosts = replay.posts.filter((p) => p.via === "bot");
const apiMessage = (p: (typeof botPosts)[number]) => ({
  id: idOf(p),
  content: p.html,
  flags: 2,
  webhook_id: "1400000000000000999",
  author: { username: p.author, bot: true },
  message_reference: { guild_id: replay.guild.id, channel_id: p.source_channel, message_id: p.source_message },
});
/** The user's own feed channel: two crossposts and one line the user typed there themselves. */
function ownServer(after?: string) {
  const all = [...botPosts.map(apiMessage), { id: "1571500000000000000", content: "note to self: ask Modal about GPUs", author: { username: "me" } }];
  return fakeDiscord((path, q) => {
    if (path === "/users/@me/guilds") return { body: [{ id: own.id, name: own.name }] };
    if (path === `/guilds/${own.id}/channels`) return { body: [{ id: own.feed_channel.id, name: own.feed_channel.name, type: 0 }, { id: "1400000000000000002", name: "voice", type: 2 }] };
    if (path === `/channels/${own.feed_channel.id}/messages`) {
      const a = q.get("after") ?? after;
      return { body: all.filter((m) => !a || BigInt(m.id) > BigInt(a)).sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? 1 : -1)) };
    }
    return { status: 404 };
  });
}

describe("DiscordBot", () => {
  test("only GET on the read routes; anything else is refused before a request", async () => {
    const s = fakeDiscord(() => ({}));
    const bot = new DiscordBot(TOKEN, s.deps);
    for (const p of ["/channels/1/messages/2", "/channels/1/messages/2/ack", "/channels/1/typing", "/users/@me/channels", "/guilds/1/members", "/channels/1/messages/2/reactions/x/@me", "/users/@me"])
      await expect(bot.get(p)).rejects.toBeInstanceOf(BotRefused);
    expect(s.sent).toHaveLength(0);
    expect(BOT_ROUTES).toHaveLength(3);
    const src = readFileSync(join(import.meta.dir, "discordbot.ts"), "utf8");
    expect(src.match(/method: "(\w+)"/g)).toEqual(['method: "GET"', 'method: "GET"']);
    expect(src).not.toMatch(/"(POST|PUT|PATCH|DELETE)"/);
  });

  test("the token goes only in the Authorization header to discord.com, never into an error or the object", async () => {
    const s = fakeDiscord(() => ({ status: 401 }));
    const bot = new DiscordBot(TOKEN, s.deps);
    const err = (await bot.get("/users/@me/guilds").catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(BotError);
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(bot)).not.toContain(TOKEN);
    expect(s.sent[0]!.init).toEqual({ method: "GET", headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": expect.stringContaining("DiscordBot") } });
    expect(() => new DiscordBot("xoxc-not-a-bot-token", s.deps)).toThrow(BotRefused);
  });

  test("paced a second apart; 429 waits retry_after; a spent bucket waits its reset", async () => {
    let n = 0;
    const s = fakeDiscord(() => (++n === 2 ? { status: 429, body: { retry_after: 3.5 } } : n === 3 ? { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "4" } } : {}));
    const bot = new DiscordBot(TOKEN, s.deps);
    await bot.get("/users/@me/guilds");
    await bot.get("/users/@me/guilds");
    await bot.get("/users/@me/guilds");
    const at = s.sent.map((x) => x.at);
    expect([at[1]! - at[0]!, at[2]! - at[1]!, at[3]! - at[2]!]).toEqual([BOT_MIN_GAP_MS, 3500, 4000]);
    expect(bot.retries).toBe(1);
  });
});

describe("pollBot", () => {
  test("crossposts only, with their source; the user's own lines and voice channels are skipped; three calls", async () => {
    const s = ownServer();
    const { state, posts, log } = await pollBot(new DiscordBot(TOKEN, s.deps), { channels: {} });
    expect(posts.map((p) => p.text)).toEqual(botPosts.map((p) => p.html));
    expect(posts[0]).toMatchObject({ via: "bot", channel_name: "event-feed", crosspost: { guild_name: "Example Hacks", channel_name: "announcements", guild_id: replay.guild.id, message_id: "1300000000000009001" } });
    expect(log).toEqual({ guilds: 1, channels: 1, crossposts: 2, calls: 3, retries: 0, empty: 0 });
    expect(state.channels[own.feed_channel.id]).toBe("1571500000000000000");
  });

  test("the next poll asks only for what came after the cursor", async () => {
    const s = ownServer();
    const first = await pollBot(new DiscordBot(TOKEN, s.deps), { channels: {} });
    const again = await pollBot(new DiscordBot(TOKEN, s.deps), first.state);
    expect(again.posts).toEqual([]);
    expect(s.sent.filter((x) => x.path.endsWith("/messages")).map((x) => x.q.get("after"))).toEqual([null, "1571500000000000000"]);
  });

  test("crossposts with no text mean the Message Content Intent is off", async () => {
    const s = fakeDiscord((path) =>
      path === "/users/@me/guilds" ? { body: [{ id: own.id, name: own.name }] } : path.startsWith("/guilds/") ? { body: [{ id: own.feed_channel.id, name: "event-feed", type: 0 }] } : { body: [{ ...apiMessage(botPosts[0]!), content: "" }] },
    );
    expect((await pollBot(new DiscordBot(TOKEN, s.deps), { channels: {} })).log.empty).toBe(1);
  });

  test("Discord markdown as read: masked links, bare URLs, mentions", () => {
    expect(renderContent("Claim [here](https://modal.com/c) or <https://x.example/a>, ping <@123> in <#456>: https://y.example/b")).toEqual({
      text: "Claim here <https://modal.com/c> or https://x.example/a, ping @someone in #channel: https://y.example/b",
      links: ["https://modal.com/c", "https://x.example/a", "https://y.example/b"],
    });
  });
});
