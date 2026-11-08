// The Donna bot (user 2026-11-07; named Donna 2026-11-08): a bot account the user created, in a private server they own. When an event's
// announcement channel can be followed, the user clicks Follow once and picks that server; Discord then copies every
// announcement there as a crosspost, and this reads those copies through the official API with the bot's own token
// (never the user's). GET only, four read routes, paced far under Discord's limits, backing off on 429.
// Setup and permissions: docs/discord-bot.md.
import { crosspostSource, type DiscordPost } from "./discord.ts";

export const DISCORD_API = "https://discord.com/api/v10";
/** Every route the bot may call, all GET. Nothing that sends, reacts, edits, deletes or acknowledges. */
export const BOT_ROUTES = [/^\/users\/@me\/guilds$/, /^\/guilds\/\d+\/channels$/, /^\/channels\/\d+\/messages$/] as const;
/** One request a second at most: a poll is a handful of calls (Discord allows 50 a second). */
export const BOT_MIN_GAP_MS = 1000;
export const BOT_MAX_TRIES = 5;
const PAGE = 100;
const MAX_PAGES = 5;
/** Text and announcement channels: the kinds a Follow can deliver into. */
const READABLE = new Set([0, 5]);
const CROSSPOSTED = 1 << 1;
const UA = "DiscordBot (https://github.com/atishaypahadiya/hackrecon, 0.5)";

export class BotRefused extends Error {}
export class BotError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    why: string,
  ) {
    super(`${route}: ${status} ${why}`);
  }
}

export interface BotDeps {
  fetch(url: string, init: { method: "GET"; headers: Record<string, string> }): Promise<{ status: number; headers: { get(h: string): string | null }; json(): Promise<unknown> }>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export class DiscordBot {
  readonly #token: string;
  calls = 0;
  retries = 0;
  #next = 0;
  constructor(
    token: string,
    private readonly deps: BotDeps,
  ) {
    if (!/^[\w.-]{50,}$/.test(token)) throw new BotRefused("DISCORD_BOT_TOKEN doesn't look like a bot token");
    this.#token = token;
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (!BOT_ROUTES.some((r) => r.test(path))) throw new BotRefused(`${path}: not a read route the bot may call`);
    const url = `${DISCORD_API}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`;
    for (let tries = 1; ; tries++) {
      const wait = this.#next - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      this.#next = this.deps.now() + BOT_MIN_GAP_MS;
      this.calls++;
      const res = await this.deps.fetch(url, { method: "GET", headers: { Authorization: `Bot ${this.#token}`, "User-Agent": UA } });
      if (res.status === 429) {
        if (tries >= BOT_MAX_TRIES) throw new BotError(path, 429, `rate limited ${tries} times`);
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        this.retries++;
        this.#next = this.deps.now() + Math.ceil((body.retry_after ?? 2 ** tries) * 1000);
        continue;
      }
      if (res.status === 401) throw new BotError(path, 401, "unauthorized: the bot token is wrong or was reset");
      if (res.status === 403) throw new BotError(path, 403, "missing access: the bot needs View Channels and Read Message History there");
      if (res.status >= 400) throw new BotError(path, res.status, "request failed");
      if (res.headers.get("x-ratelimit-remaining") === "0") this.#next = Math.max(this.#next, this.deps.now() + Number(res.headers.get("x-ratelimit-reset-after") ?? "1") * 1000);
      return (await res.json()) as T;
    }
  }

  /** True when `s` holds the token: nothing the bot saves may. */
  holdsToken(s: string): boolean {
    return s.includes(this.#token);
  }
}

interface ApiMessage {
  id: string;
  content: string;
  flags?: number;
  webhook_id?: string;
  author: { username: string; bot?: boolean };
  message_reference?: { guild_id?: string; channel_id?: string; message_id?: string };
  embeds?: { title?: string; description?: string; url?: string }[];
}

/** Discord markdown as the reader shows it: [label](url) → `label <url>`, <url> → url; mentions as plain text. */
export function renderContent(s: string): { text: string; links: string[] } {
  const links: string[] = [];
  // Each link is set aside as soon as it's matched, so a later pattern never rewrites it.
  const kept: string[] = [];
  const hold = (out: string) => `\u0000${kept.push(out) - 1}\u0000`;
  const text = s
    .replace(/\[([^\]]+)\]\(<?(https?:\/\/[^)\s>]+)>?\)/g, (_, label: string, url: string) => (links.push(url), hold(`${label} <${url}>`)))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => (links.push(url), hold(url)))
    .replace(/https?:\/\/[^\s<>]+/g, (raw) => {
      const url = raw.replace(/[.,;:!?)\]]+$/, "");
      links.push(url);
      return hold(url) + raw.slice(url.length);
    })
    .replace(/<@!?\d+>/g, "@someone")
    .replace(/<@&\d+>/g, "@role")
    .replace(/<#\d+>/g, "#channel")
    .replace(/<a?(:\w+:)\d+>/g, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_, n: string) => kept[Number(n)]!);
  return { text: text.trim(), links: [...new Set(links)] };
}

export interface BotState {
  /** Per channel, the newest message id read. */
  channels: Record<string, string>;
}

export interface BotPollLog {
  guilds: number;
  channels: number;
  crossposts: number;
  calls: number;
  retries: number;
  /** Crossposts that arrived with no text at all: the Message Content Intent is off in the Developer Portal. */
  empty: number;
}

const newer = (a: string, b: string | undefined) => !b || BigInt(a) > BigInt(b);

/** Every readable channel of every server the bot is in (normally one: the user's own); only crossposts are kept,
 *  so whatever else the user writes in their server is never read into HackRecon. */
export async function pollBot(bot: DiscordBot, prev: BotState): Promise<{ state: BotState; posts: DiscordPost[]; log: BotPollLog }> {
  const state: BotState = { channels: { ...prev.channels } };
  const posts: DiscordPost[] = [];
  const log: BotPollLog = { guilds: 0, channels: 0, crossposts: 0, calls: 0, retries: 0, empty: 0 };
  const guilds = await bot.get<{ id: string; name: string }[]>("/users/@me/guilds");
  log.guilds = guilds.length;
  for (const g of guilds) {
    const chans = (await bot.get<{ id: string; name: string; type: number }[]>(`/guilds/${g.id}/channels`)).filter((c) => READABLE.has(c.type));
    for (const c of chans) {
      log.channels++;
      const after = prev.channels[c.id];
      const got: ApiMessage[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const cursor = got.reduce<string | undefined>((n, m) => (newer(m.id, n) ? m.id : n), after);
        const batch = await bot.get<ApiMessage[]>(`/channels/${c.id}/messages`, { limit: String(PAGE), ...(cursor ? { after: cursor } : {}) });
        got.push(...batch);
        if (batch.length < PAGE || !cursor) break; // without a cursor, the newest page only
      }
      for (const m of got) if (newer(m.id, state.channels[c.id])) state.channels[c.id] = m.id;
      for (const m of got.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
        const src = crosspostSource(m.author.username);
        if (!(((m.flags ?? 0) & CROSSPOSTED) || (m.webhook_id && m.message_reference?.guild_id)) || !src) continue;
        const body = renderContent(m.content);
        const embeds = (m.embeds ?? []).flatMap((e) => [e.title, e.description].filter((x): x is string => !!x).map((x) => renderContent(x)));
        const text = [body.text, ...embeds.map((e) => e.text)].filter(Boolean).join("\n");
        if (!text) {
          log.empty++;
          continue;
        }
        log.crossposts++;
        const ref = m.message_reference;
        posts.push({
          via: "bot",
          guild_id: g.id,
          guild_name: g.name,
          channel_id: c.id,
          channel_name: c.name,
          message_id: m.id,
          author_name: m.author.username,
          author_kind: "bot",
          crosspost: { ...src, ...(ref?.guild_id ? { guild_id: ref.guild_id } : {}), ...(ref?.channel_id ? { channel_id: ref.channel_id } : {}), ...(ref?.message_id ? { message_id: ref.message_id } : {}) },
          text,
          links: [...new Set([...body.links, ...embeds.flatMap((e) => e.links), ...(m.embeds ?? []).flatMap((e) => (e.url ? [e.url] : []))])],
        });
      }
    }
  }
  log.calls = bot.calls;
  log.retries = bot.retries;
  return { state, posts, log };
}
