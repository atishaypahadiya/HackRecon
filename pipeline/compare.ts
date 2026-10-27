// Day-1 capture check (D8): keyed recall by ts against the slackdump baseline, plus author match.
import type { NonPost } from "./rows.ts";
import type { CaptureFile } from "./schema.ts";
import { expectedAuthorNames, isTopLevel, normName, readChannel, rowClass, type SlackExport } from "./export.ts";

export const RECALL_MIN = 0.9;
export const AUTHOR_MIN = 0.95;
export const TIME_MAX_S = 120;

export interface Missed {
  ts: string;
  /** Only `real` misses count against keyed recall (D8). */
  class: "real" | "broadcast";
  permalink: string;
  author: string;
  text: string;
}

export interface Extra {
  ts: string;
  /** system_leak: a join/topic/etc row was captured; thread_reply: a reply that isn't a broadcast
   *  appeared in the channel; broadcast_unmarked: a broadcast captured without subtype/thread_ts;
   *  after_export: posted after the baseline was taken; not_in_export: none of the above. */
  why: "system_leak" | "thread_reply" | "broadcast_unmarked" | "after_export" | "not_in_export";
  subtype?: string;
  text: string;
}

export interface ChannelReport {
  channel_id: string;
  channel_name: string;
  stop_reason: string;
  duration_s: number;
  scroll_steps: number;
  captured: number;
  system_rows_skipped: number;
  unresolved_authors: number;
  export_top_level: { real: number; bot: number; system: number };
  /** Replies also sent to the channel, in the export. */
  export_broadcasts: number;
  matched_real: number;
  keyed_recall: number;
  bot_captured: number;
  broadcast_captured: number;
  /** Non-posts removed when the capture was loaded (pipeline/captures.ts). */
  dropped_on_load: { ts: string; reason: NonPost }[];
  missed: Missed[];
  extras: Extra[];
  author: {
    checked: number;
    matched: number;
    rate: number;
    mismatches: { ts: string; captured: string; expected: string[] }[];
    /** Posters the export has no name for (Slack Connect accounts missing from users.json).
     *  Left out of the rate; every post by one user must still get the same captured name. */
    unverifiable: { user: string; posts: number; captured_names: string[] }[];
  };
  pass: { recall: boolean; author: boolean; time: boolean };
}

export function compareChannel(
  cap: CaptureFile,
  exp: SlackExport,
  exportCutoffTs: number,
  droppedOnLoad: ChannelReport["dropped_on_load"] = [],
): ChannelReport {
  const name = exp.channelsById.get(cap.channel_id);
  if (!name) throw new Error(`${cap.channel_id} (${cap.channel_name}) is not in the export's channels.json`);
  const all = readChannel(exp, name);
  const byTs = new Map(all.map((m) => [m.ts, m]));
  const top = all.filter(isTopLevel);
  const real = top.filter((m) => rowClass(m) === "real");
  const bot = top.filter((m) => rowClass(m) === "bot");
  const broadcasts = all.filter((m) => rowClass(m) === "broadcast");
  const capByTs = new Map(cap.messages.map((m) => [m.ts, m]));
  const origin = workspaceOrigin(cap);

  const missed: Missed[] = [...real, ...broadcasts]
    .filter((m) => !capByTs.has(m.ts))
    .map((m) => ({
      ts: m.ts,
      class: rowClass(m) === "broadcast" ? ("broadcast" as const) : ("real" as const),
      permalink: `${origin}/archives/${cap.channel_id}/p${m.ts.replace(".", "")}`,
      author: expectedAuthorNames(exp, m)[0] ?? m.user ?? "",
      text: snippet(m.text ?? ""),
    }));

  const extras: Extra[] = [];
  for (const m of cap.messages) {
    const e = byTs.get(m.ts);
    if (e && isTopLevel(e) && rowClass(e) !== "system") continue;
    if (e && rowClass(e) === "broadcast") {
      if (m.subtype !== "thread_broadcast" || m.thread_ts !== e.thread_ts) {
        extras.push({ ts: m.ts, why: "broadcast_unmarked", text: snippet(m.text) });
      }
      continue;
    }
    if (e && !isTopLevel(e)) extras.push({ ts: m.ts, why: "thread_reply", text: snippet(m.text) });
    else if (e) extras.push({ ts: m.ts, why: "system_leak", subtype: e.subtype, text: snippet(m.text) });
    else if (Number(m.ts) > exportCutoffTs) extras.push({ ts: m.ts, why: "after_export", text: snippet(m.text) });
    else extras.push({ ts: m.ts, why: "not_in_export", text: snippet(m.text) });
  }

  const mismatches: ChannelReport["author"]["mismatches"] = [];
  const nameless = new Map<string, { posts: number; names: Set<string> }>();
  let checked = 0;
  for (const e of [...real, ...bot, ...broadcasts]) {
    const c = capByTs.get(e.ts);
    if (!c) continue;
    const expected = expectedAuthorNames(exp, e);
    if (!expected.length) {
      const u = nameless.get(e.user ?? "") ?? { posts: 0, names: new Set<string>() };
      u.posts++;
      u.names.add(c.author_name);
      nameless.set(e.user ?? "", u);
      continue;
    }
    checked++;
    if (!expected.some((n) => normName(n) === normName(c.author_name))) {
      mismatches.push({ ts: e.ts, captured: c.author_name, expected });
    }
  }

  const matchedReal = real.length - missed.filter((m) => m.class === "real").length;
  const keyedRecall = real.length ? matchedReal / real.length : 1;
  const authorRate = checked ? (checked - mismatches.length) / checked : 1;
  const unverifiable = [...nameless].map(([user, u]) => ({ user, posts: u.posts, captured_names: [...u.names].sort() }));
  const duration = (Date.parse(cap.finished_at) - Date.parse(cap.started_at)) / 1000;
  return {
    channel_id: cap.channel_id,
    channel_name: name,
    stop_reason: cap.stop_reason,
    duration_s: Math.round(duration),
    scroll_steps: cap.scroll_steps,
    captured: cap.messages.length,
    system_rows_skipped: cap.system_rows_skipped,
    unresolved_authors: cap.unresolved_authors.length,
    export_top_level: { real: real.length, bot: bot.length, system: top.length - real.length - bot.length },
    export_broadcasts: broadcasts.length,
    matched_real: matchedReal,
    keyed_recall: keyedRecall,
    bot_captured: bot.filter((m) => capByTs.has(m.ts)).length,
    broadcast_captured: broadcasts.filter((m) => capByTs.has(m.ts)).length,
    dropped_on_load: droppedOnLoad,
    missed,
    extras,
    author: { checked, matched: checked - mismatches.length, rate: authorRate, mismatches, unverifiable },
    pass: {
      recall: keyedRecall >= RECALL_MIN,
      author: authorRate >= AUTHOR_MIN && unverifiable.every((u) => u.captured_names.length === 1 && u.captured_names[0] !== ""),
      time: duration <= TIME_MAX_S,
    },
  };
}

function workspaceOrigin(cap: CaptureFile): string {
  for (const m of cap.messages) {
    try {
      return new URL(m.permalink).origin;
    } catch {}
  }
  return "https://app.slack.com";
}

function snippet(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
}
