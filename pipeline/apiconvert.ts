// The API pull (user 2026-11-07): Slack's own message objects (conversations.history / .replies; the same shape as
// the export) turned into the capture files the DOM sync writes, so ingest, record-run and everything downstream
// read one format. Text is rendered the way the DOM capture renders it: links as `label <href>`, mentions as
// `@Display Name`, mrkdwn emphasis dropped, entities unescaped.
import type { ExportMessage, ExportUser } from "./export.ts";
import { isTopLevel, rowClass } from "./export.ts";
import { SCHEMA_VERSION, type CaptureFile, type Message, type ThreadCaptureFile } from "./schema.ts";

export interface ApiUser extends ExportUser {
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  profile?: ExportUser["profile"] & { title?: string; email?: string };
}

/** One channel as the extension's API pull saves it: `api/<channel_id>.json`. */
export interface ApiChannelFile {
  kind: "api-channel";
  channel_id: string;
  channel_name: string;
  started_at: string;
  finished_at: string;
  /** Oldest ts asked for (the incremental cursor less the thread lookback); null: the whole history. */
  oldest: string | null;
  /** Top-level rows and broadcasts, as conversations.history returns them. */
  history: ExportMessage[];
  /** Replies per parent ts (conversations.replies, the parent itself dropped), only for threads read this pull. */
  replies: Record<string, ExportMessage[]>;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** mrkdwn emphasis the web client renders as style, not characters: *bold*, _italic_, ~strike~, `code`. */
const unstyle = (s: string) =>
  s
    .replace(/^[ \t]*[•◦▪][ \t]+/gm, "") // list bullets: the DOM renders list items without them
    .replace(/```\n?([\s\S]*?)\n?```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:;])/gm, "$1$2")
    .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,!?:;])/gm, "$1$2")
    .replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s).,!?:;])/gm, "$1$2");

export const displayName = (u: ApiUser | undefined): string => u?.profile?.display_name?.trim() || u?.profile?.real_name?.trim() || u?.real_name?.trim() || u?.name || "";

/** Slack mrkdwn → the DOM capture's text, links and mentions, by the DOM serializer's rules (extension/src/parse.ts
 *  serializeBody): a link whose label is its URL (with or without the scheme) is the URL alone, a channel link is
 *  `#name <origin/archives/ID>`, and the same whitespace cleanup. */
export function renderText(
  mrkdwn: string,
  users: Map<string, ApiUser>,
  channels: Map<string, string>,
  origin = "",
): { text: string; links: string[]; mentions: { id: string; label: string }[] } {
  const links: string[] = [];
  const mentions: { id: string; label: string }[] = [];
  const text = unstyle(mrkdwn).replace(/<([^<>]+)>/g, (_all, inner: string) => {
    const [target, label] = inner.split(/\|(.*)/s) as [string, string | undefined];
    if (target.startsWith("@")) {
      const id = target.slice(1);
      const name = label?.replace(/^@/, "") || displayName(users.get(id)) || id;
      mentions.push({ id, label: `@${name}` });
      return `@${name}`;
    }
    if (target.startsWith("#")) {
      const name = `#${label || channels.get(target.slice(1)) || target.slice(1)}`;
      if (!origin) return name;
      const href = `${origin}/archives/${target.slice(1)}`;
      links.push(href);
      return `${name} <${href}>`;
    }
    if (target.startsWith("!")) {
      const special = target.slice(1);
      if (/^(channel|here|everyone)$/.test(special)) return `@${special}`;
      return label ?? (special.startsWith("subteam^") ? "" : `@${special}`);
    }
    const href = unescape(target);
    const shown = label === undefined ? "" : unescape(label).replace(/\s+/g, " ").trim();
    links.push(href);
    return !shown || shown === href || `https://${shown}` === href || `http://${shown}` === href ? href : `${shown} <${href}>`;
  });
  const clean = unescape(text).replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean, links, mentions };
}

const permalink = (origin: string, channelId: string, ts: string, threadTs?: string) =>
  `${origin}/archives/${channelId}/p${ts.replace(".", "")}` + (threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channelId}` : "");

/** One API message as a captured Message; null for rows the DOM capture skips (joins, topic changes, tombstones). */
export function apiMessage(
  m: ExportMessage,
  ctx: { channelId: string; channelName: string; origin: string; runId: string; capturedAt: string; users: Map<string, ApiUser>; channels: Map<string, string> },
): Message | null {
  const cls = rowClass(m);
  if (cls === "system") return null;
  const u = m.user ? ctx.users.get(m.user) : undefined;
  const { text, links, mentions } = renderText(m.text ?? "", ctx.users, ctx.channels, ctx.origin);
  const reply = !isTopLevel(m);
  return {
    id: `${ctx.channelId}:${m.ts}`,
    channel_id: ctx.channelId,
    channel_name: ctx.channelName,
    ts: m.ts,
    ...(reply ? { thread_ts: m.thread_ts! } : {}),
    ...(m.subtype === "thread_broadcast" ? { subtype: "thread_broadcast" as const } : {}),
    author_name: m.user_profile?.display_name?.trim() || m.user_profile?.real_name?.trim() || displayName(u) || m.username || m.bot_profile?.name || "",
    ...(m.user ? { author_id: m.user } : {}),
    author_kind: cls === "bot" ? "bot" : "user",
    text,
    links,
    ...(mentions.length ? { mentions } : {}),
    permalink: permalink(ctx.origin, ctx.channelId, m.ts, reply ? m.thread_ts : undefined),
    ...(m.reply_count ? { reply_count: m.reply_count } : {}),
    ...(m.latest_reply ? { latest_reply: m.latest_reply } : {}),
    captured_at: ctx.capturedAt,
    run_id: ctx.runId,
  };
}

/** An API channel file as the DOM sync's two capture files (channel and threads). */
export function captureFromApi(f: ApiChannelFile, o: { origin: string; runId: string; users: Map<string, ApiUser>; channels: Map<string, string> }): { channel: CaptureFile; threads: ThreadCaptureFile } {
  const ctx = { channelId: f.channel_id, channelName: f.channel_name, origin: o.origin, runId: o.runId, capturedAt: f.finished_at, users: o.users, channels: o.channels };
  const visible = f.history.filter((m) => isTopLevel(m) || m.subtype === "thread_broadcast");
  const messages = visible.map((m) => apiMessage(m, ctx)).filter((m): m is Message => !!m).sort((a, b) => Number(a.ts) - Number(b.ts));
  const base = { schema_version: SCHEMA_VERSION as typeof SCHEMA_VERSION, run_id: o.runId, source: "extension" as const, channel_id: f.channel_id, channel_name: f.channel_name, started_at: f.started_at, finished_at: f.finished_at };
  const parents = new Map(f.history.map((m) => [m.ts, m]));
  return {
    channel: { ...base, stop_reason: "api_end", scroll_steps: 0, system_rows_skipped: visible.length - messages.length, unresolved_authors: [], posting_restricted: null, messages },
    threads: {
      ...base,
      kind: "threads",
      budget: "uncapped",
      threads: Object.entries(f.replies).map(([ts, rows]) => ({
        thread_ts: ts,
        reply_count_shown: parents.get(ts)?.reply_count ?? null,
        stop_reason: "api_end" as const,
        replies: rows.filter((r) => r.ts !== ts).map((r) => apiMessage({ ...r, thread_ts: r.thread_ts ?? ts }, ctx)).filter((m): m is Message => !!m),
      })),
    },
  };
}

/** What a pull saved for one channel, merged across pulls: every top-level/broadcast row and every reply, by ts. */
export interface ApiChannelKeys {
  visible: Set<string>;
  replies: Set<string>;
}
export function apiKeys(files: ApiChannelFile[]): Map<string, ApiChannelKeys> {
  const out = new Map<string, ApiChannelKeys>();
  for (const f of files) {
    const k = out.get(f.channel_name) ?? { visible: new Set(), replies: new Set() };
    for (const m of f.history) if (rowClass(m) !== "system" && (isTopLevel(m) || m.subtype === "thread_broadcast")) k.visible.add(m.ts);
    for (const rows of Object.values(f.replies)) for (const r of rows) if (rowClass(r) !== "system" && r.subtype !== "thread_broadcast") k.replies.add(r.ts);
    out.set(f.channel_name, k);
  }
  return out;
}

/** The export's keys for one channel, counted the way the 494-reply baseline counts them (D8): channel-visible
 *  non-system rows, and replies by thread_ts without the sent-to-channel copies. */
export function exportKeys(rows: ExportMessage[]): ApiChannelKeys {
  const real = rows.filter((m) => rowClass(m) !== "system");
  return { visible: new Set(real.filter((m) => isTopLevel(m) || m.subtype === "thread_broadcast").map((m) => m.ts)), replies: new Set(real.filter((m) => !isTopLevel(m) && m.subtype !== "thread_broadcast").map((m) => m.ts)) };
}

export interface KeyCompare {
  channel: string;
  posts: { export: number; matched: number; missing: string[]; extra: number };
  replies: { export: number; matched: number; missing: string[]; extra: number };
}
/** Pull against export, per channel: matched, in the export but not the pull (missing), and in the pull only
 *  (extra: posted after the export, or rows the export left out). */
export function compareKeys(channel: string, api: ApiChannelKeys | undefined, exp: ApiChannelKeys): KeyCompare {
  const side = (a: Set<string>, e: Set<string>) => {
    const missing = [...e].filter((t) => !a.has(t)).sort();
    return { export: e.size, matched: e.size - missing.length, missing, extra: [...a].filter((t) => !e.has(t)).length };
  };
  const a = api ?? { visible: new Set<string>(), replies: new Set<string>() };
  return { channel, posts: side(a.visible, exp.visible), replies: side(a.replies, exp.replies) };
}
