// Discord (user 2026-11-07, for the Nov 14 event): posts arrive two ways, both read-only.
// (a) The extension reads what the user's own Discord tabs render (DOM only: no user token, no Discord API, no
//     navigation, clicks or scrolling; Discord bans self-bots), plus the sidebar's unread badges.
// (b) The HackRecon bot, a real bot account in a private server the user owns, reads the crossposts Discord copies
//     there from event announcement channels the user followed (official API, bot token, GET only: discordbot.ts).
// Both become Messages here, so classify --new, the cost guard and the SMS rules (alerts.ts) treat them alike.
import { messageId, type Message } from "./schema.ts";

export const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** One post as read, before it becomes a Message. */
export interface DiscordPost {
  via: "dom" | "bot";
  guild_id: string;
  guild_name: string;
  channel_id: string;
  channel_name: string;
  message_id: string;
  author_name: string;
  author_kind: "user" | "bot";
  /** A post Discord relayed from a followed announcement channel: where it was first posted. */
  crosspost?: { guild_name: string; channel_name: string; guild_id?: string; channel_id?: string; message_id?: string };
  /** The composer says this user can't post here. An observation only, never authority: servers lock every channel
   *  for a member who hasn't verified yet. A read-only announcement-named channel is proposed for authority_channels. */
  read_only_channel?: boolean;
  /** Message text, then each embed's title and description on their own lines; links as `label <href>`. */
  text: string;
  links: string[];
}

/** A file the extension saves (Downloads/hackrecon/discord/…): the posts one tab rendered, and its sidebar. */
export interface DiscordDomFile {
  kind: "discord-dom";
  captured_at: string;
  guild_id: string;
  guild_name: string;
  posts: DiscordPost[];
  /** Discovered channels with an unread badge that no open tab shows: content unknown, only that something landed. */
  unread: { channel_id: string; channel_name: string; role: ChannelRole; since: string }[];
}

export type ChannelRole = "announcement" | "sponsor" | "other";

const ANNOUNCE = /announce|news|updates?|important|^info$|schedule|📢/i;
const SPONSOR = /sponsor|partner|^spons-|cohost|company|booth/i;

/** Discovery by name (user: "auto-discover the event's announcement and sponsor channels by name"). A channel named
 *  after a known sponsor counts as a sponsor channel. Names decide where to look, never authority (D19). */
export function channelRole(name: string, sponsorNames: string[] = []): ChannelRole {
  const n = name.toLowerCase().replace(/^[^a-z0-9📢]+/u, "");
  if (ANNOUNCE.test(n)) return "announcement";
  if (SPONSOR.test(n)) return "sponsor";
  const flat = n.replace(/[^a-z0-9]/g, "");
  if (sponsorNames.some((s) => s.length >= 3 && flat.includes(s.toLowerCase().replace(/[^a-z0-9]/g, "")))) return "sponsor";
  return "other";
}

export function snowflakeMs(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** A Slack-shaped ts (the schema's TS_RE) from a snowflake: the post's millisecond, then three digits of Discord's
 *  per-process increment so two posts in one millisecond stay apart. */
export function snowflakeTs(id: string): string {
  const ms = snowflakeMs(id);
  const inc = Number(BigInt(id) & 0xfffn) % 1000;
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}${String(inc).padStart(3, "0")}`;
}

/** The crosspost webhook's name, "Example Hacks #announcements", split into server and channel. */
export function crosspostSource(webhookName: string): { guild_name: string; channel_name: string } | null {
  const m = /^(.+?)\s+#([^\s#]+)$/.exec(webhookName.trim());
  return m ? { guild_name: m[1]!, channel_name: m[2]! } : null;
}

export const permalink = (guild: string, channel: string, message: string) => `https://discord.com/channels/${guild}/${channel}/${message}`;

/** As a Message: channel ids are prefixed so they never meet a Slack id; a crosspost is filed under its source
 *  channel's name (where it was posted), linked to its source when Discord gave one. Authority (D19) only from what
 *  the user chose: a channel they followed into their own server, or one listed in event.json authority_channels. */
export function toMessage(p: DiscordPost, runId: string, capturedAt: string, authorityChannels: ReadonlySet<string> = new Set()): Message {
  const channel_id = `discord-${p.channel_id}`;
  const ts = snowflakeTs(p.message_id);
  const src = p.crosspost;
  const link = src?.guild_id && src.channel_id && src.message_id ? permalink(src.guild_id, src.channel_id, src.message_id) : permalink(p.guild_id, p.channel_id, p.message_id);
  return {
    id: messageId(channel_id, ts),
    channel_id,
    channel_name: src?.channel_name ?? p.channel_name,
    ts,
    author_name: src ? `${src.guild_name} #${src.channel_name}` : p.author_name,
    author_kind: p.author_kind,
    ...(src || authorityChannels.has(p.channel_name) ? { authority: true as const } : {}),
    text: p.text,
    links: p.links,
    permalink: link,
    captured_at: capturedAt,
    run_id: runId,
  };
}

/** Where a Discord message came from, for the SMS: "#announcements, Example Hacks". */
export function sourceLine(m: Message, guildName = ""): string {
  const via = m.author_kind === "bot" && /\s#\S+$/.test(m.author_name) ? m.author_name.replace(/\s#\S+$/, "") : guildName;
  return `#${m.channel_name}${via ? `, ${via}` : ""}`;
}
