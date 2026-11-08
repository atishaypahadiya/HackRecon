// Discord to SMS (user 2026-11-07): `hr discord-ingest` turns what the extension saved and what the bot read into
// Messages; `hr classify --new` classifies them under the cost guard; `hr alerts` decides and sends the texts.
// `hr watch` runs the three on a timer. Paths are event-relative (hr runs in the event directory).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alertFor, deliver, isFresh, EMPTY_NOTIFY, unreadAlert, unsend, type Alert, type NotifyState, type PlanFacts, type Sms } from "./alerts.ts";
import { readJsonFile, writeJsonFile } from "./classify.ts";
import { channelKey, channelRole, toMessage, type DiscordDomFile, type DiscordPost } from "./discord.ts";
import { pollBot, type BotState, type DiscordBot, type BotPollLog } from "./discordbot.ts";
import { ALERTS_LOG_PATH, ALERTS_STATE_PATH, CAPTURES_DIR, EVENT_PATH, DISCORD_STATE_PATH, DISCORD_UNREAD_PATH, ITEMS_PATH, MESSAGES_PATH, ORGANIZERS_PATH, PLAN_PATH, SMS_OUTBOX_PATH } from "./event.ts";
import { readMessages, saveRun } from "./runs.ts";
import type { Item, Message } from "./schema.ts";

export interface DiscordState {
  files: string[];
  bot: BotState;
  /** Discord channel id → its server's name, for the text's source line. */
  guilds: Record<string, string>;
}
export interface UnreadRecord {
  channel_id: string;
  channel_name: string;
  role: string;
  since: string;
  guild_id: string;
  guild_name: string;
}

const DOM_FILE = /^[0-9TZ-]+-\d+\.json$/;

export async function ingestDiscord(o: { dir: string | null; bot: DiscordBot | null; now: Date }): Promise<{ files: number; posts: number; added: number; unread: number; bot?: BotPollLog; errors: string[]; proposed: { key: string; channel: string; guild: string }[] }> {
  const st = readJsonFile<DiscordState>(DISCORD_STATE_PATH, { files: [], bot: { channels: {} }, guilds: {} });
  const done = new Set(st.files);
  const posts: { post: DiscordPost; at: string }[] = [];
  const unread: UnreadRecord[] = [];
  const errors: string[] = [];
  let files = 0;
  for (const f of o.dir && existsSync(o.dir) ? readdirSync(o.dir).filter((f) => DOM_FILE.test(f) && !done.has(f)).sort() : []) {
    try {
      const file = JSON.parse(readFileSync(join(o.dir!, f), "utf8")) as DiscordDomFile;
      if (file.kind !== "discord-dom" || !Array.isArray(file.posts) || !Array.isArray(file.unread)) throw new Error("not a Discord file from the extension");
      mkdirSync(join(CAPTURES_DIR, "discord"), { recursive: true });
      copyFileSync(join(o.dir!, f), join(CAPTURES_DIR, "discord", f));
      posts.push(...file.posts.map((post) => ({ post, at: file.captured_at })));
      unread.push(...file.unread.map((u) => ({ ...u, guild_id: file.guild_id, guild_name: file.guild_name })));
      st.files.push(f);
      files++;
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  let bot: BotPollLog | undefined;
  if (o.bot) {
    try {
      const r = await pollBot(o.bot, st.bot);
      st.bot = r.state;
      bot = r.log;
      posts.push(...r.posts.map((post) => ({ post, at: o.now.toISOString() })));
    } catch (e) {
      errors.push(`bot: ${(e as Error).message}`);
    }
  }
  for (const { post } of posts) st.guilds[post.channel_id] = post.crosspost?.guild_name ?? post.guild_name;
  // Authority only where the user said so (D19): event.json discord_authority_channels, by ids. A channel that is
  // read-only for the user and named like announcements is proposed, never trusted: a server may lock everything
  // until you verify.
  const trusted = new Set(readJsonFile<{ discord_authority_channels?: string[] }>(EVENT_PATH, {}).discord_authority_channels ?? []);
  const proposed = [
    ...new Map(
      posts
        .filter(({ post }) => post.read_only_channel && !post.crosspost && !trusted.has(channelKey(post.guild_id, post.channel_id)) && channelRole(post.channel_name) === "announcement")
        .map(({ post }) => [channelKey(post.guild_id, post.channel_id), { key: channelKey(post.guild_id, post.channel_id), channel: post.channel_name, guild: post.guild_name }] as const),
    ).values(),
  ];
  const have = new Set(existsSync(MESSAGES_PATH) ? readMessages().map((m) => m.id) : []);
  const runId = `discord-${o.now.toISOString().replace(/[:.]/g, "-")}`;
  const fresh = new Map<string, Message>();
  for (const { post, at } of posts) {
    const m = toMessage(post, runId, at, trusted);
    if (!have.has(m.id)) fresh.set(m.id, m);
  }
  if (fresh.size) {
    const msgs = [...fresh.values()];
    saveRun({ run_id: runId, started_at: o.now.toISOString(), channels: [...new Set(msgs.map((m) => m.channel_name))], message_count: msgs.length, source: "discord" }, msgs);
  }
  if (unread.length) writeJsonFile(DISCORD_UNREAD_PATH, [...readJsonFile<UnreadRecord[]>(DISCORD_UNREAD_PATH, []), ...unread]);
  // Discord authority comes from where a post was made (Message.authority), not from user ids: classify still reads
  // organizers.json, so an event with none gets an empty one.
  if (!existsSync(ORGANIZERS_PATH)) writeJsonFile(ORGANIZERS_PATH, []);
  writeJsonFile(DISCORD_STATE_PATH, st);
  return { files, posts: posts.length, added: fresh.size, unread: unread.length, ...(bot ? { bot } : {}), errors, proposed };
}

export interface OutboxLine {
  at: string;
  level: Sms["level"];
  status: "sent" | "dry-run" | "failed";
  body: string;
  twilio_sid?: string;
  error?: string;
}

/** Alerts for posts from the last ALERT_MAX_AGE_MS, new unread badges, and the texts due now. */
export async function runAlerts(o: { nowMs: number; tz: string; organizerIds: Set<string>; send: ((body: string) => Promise<{ sid: string } | { error: string }>) | null }): Promise<{ fresh: Alert[]; outbox: OutboxLine[]; queued: { now: number; digest: number } }> {
  const plan = readJsonFile<PlanFacts | null>(PLAN_PATH, null);
  const st = readJsonFile<DiscordState>(DISCORD_STATE_PATH, { files: [], bot: { channels: {} }, guilds: {} });
  const items = new Map<string, Item[]>();
  for (const i of readJsonFile<Item[]>(ITEMS_PATH, [])) items.set(i.message_id, [...(items.get(i.message_id) ?? []), i]);
  const recent = (iso: string) => isFresh(Date.parse(iso), o.nowMs);
  const messages = existsSync(MESSAGES_PATH) ? readMessages() : [];
  const fresh: Alert[] = [];
  for (const m of messages.filter((m) => recent(new Date(Number(m.ts) * 1000).toISOString())).sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
    const a = alertFor(m, items.get(m.id) ?? [], plan, { nowMs: o.nowMs, tz: o.tz, guildName: st.guilds[m.channel_id.replace(/^discord-/, "")] ?? "", organizer: !!m.author_id && o.organizerIds.has(m.author_id) });
    if (a) fresh.push(a);
  }
  for (const u of readJsonFile<UnreadRecord[]>(DISCORD_UNREAD_PATH, []).filter((u) => recent(u.since))) fresh.push(unreadAlert(u));
  const prev = readJsonFile<NotifyState>(ALERTS_STATE_PATH, EMPTY_NOTIFY);
  const known = new Set(prev.alerted);
  for (const a of fresh.filter((a) => !known.has(a.key))) appendFileSync(ALERTS_LOG_PATH, JSON.stringify({ ...a, found_at: new Date(o.nowMs).toISOString() }) + "\n");
  let { state, sms } = deliver(prev, fresh, o.nowMs);
  const outbox: OutboxLine[] = [];
  for (const s of sms) {
    const at = new Date(o.nowMs).toISOString();
    if (!o.send) {
      outbox.push({ at, level: s.level, status: "dry-run", body: s.body });
      continue;
    }
    const r = await o.send(s.body);
    if ("sid" in r) outbox.push({ at, level: s.level, status: "sent", body: s.body, twilio_sid: r.sid });
    else {
      outbox.push({ at, level: s.level, status: "failed", body: s.body, error: r.error });
      state = unsend(state, s);
    }
  }
  for (const line of outbox) appendFileSync(SMS_OUTBOX_PATH, JSON.stringify(line) + "\n");
  writeJsonFile(ALERTS_STATE_PATH, state);
  return { fresh: fresh.filter((a) => !known.has(a.key)), outbox, queued: { now: state.queue_now.length, digest: state.queue_digest.length } };
}
