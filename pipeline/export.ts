// Read-only access to the slackdump baseline (Slack export format: <channel>/<YYYY-MM-DD>.json,
// plus channels.json and users.json). Used by compare only; never imported into product tables.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_EXPORT_DIR = join(homedir(), "projects/hackrecon-data/calhacks");

export interface ExportMessage {
  ts: string;
  thread_ts?: string;
  subtype?: string;
  user?: string;
  username?: string;
  text?: string;
  user_profile?: { display_name?: string; real_name?: string; name?: string };
  bot_profile?: { name?: string };
}

export interface ExportUser {
  id: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

export interface SlackExport {
  dir: string;
  channelsById: Map<string, string>;
  users: Map<string, ExportUser>;
}

export function loadExport(dir = DEFAULT_EXPORT_DIR): SlackExport {
  const channels = readJson<{ id: string; name: string }[]>(join(dir, "channels.json"));
  const users = readJson<ExportUser[]>(join(dir, "users.json"));
  return {
    dir,
    channelsById: new Map(channels.map((c) => [c.id, c.name])),
    users: new Map(users.map((u) => [u.id, u])),
  };
}

export function readChannel(exp: SlackExport, name: string): ExportMessage[] {
  const dir = join(exp.dir, name);
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .flatMap((f) => readJson<ExportMessage[]>(join(dir, f)));
}

export function isTopLevel(m: ExportMessage): boolean {
  return m.thread_ts === undefined || m.thread_ts === m.ts;
}

/** Shown in the channel itself: top-level rows plus replies also sent to the channel. */
export function isChannelVisible(m: ExportMessage): boolean {
  return isTopLevel(m) || m.subtype === "thread_broadcast";
}

/** Real posts (keyed-recall denominator, D8), bot posts and broadcasts (kept, reported apart),
 *  and everything else (joins, topic changes, tombstones). */
export function rowClass(m: ExportMessage): "real" | "bot" | "broadcast" | "system" {
  if (m.subtype === undefined) return "real";
  if (m.subtype === "bot_message") return "bot";
  if (m.subtype === "thread_broadcast") return "broadcast";
  return "system";
}

/** Every name the web client could plausibly render for this poster. */
export function expectedAuthorNames(exp: SlackExport, m: ExportMessage): string[] {
  const u = m.user ? exp.users.get(m.user) : undefined;
  const names = [
    m.user_profile?.display_name,
    m.user_profile?.real_name,
    m.username,
    m.bot_profile?.name,
    u?.profile?.display_name,
    u?.profile?.real_name,
    u?.real_name,
    u?.name,
  ];
  return [...new Set(names.filter((n): n is string => !!n?.trim()))];
}

export function normName(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
