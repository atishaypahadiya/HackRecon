// Day-1 capture check (D8): keyed recall by ts against the slackdump baseline, plus author match.
import type { NonPost } from "./rows.ts";
import type { CaptureFile, ThreadCaptureFile } from "./schema.ts";
import { expectedAuthorNames, isTopLevel, normName, readChannel, rowClass, type ExportMessage, type SlackExport } from "./export.ts";

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
  /** Found by ts, but with no text where the export has some: Slack's loading placeholder was read (sync 2026-11-07). */
  no_text: string[];
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

  const no_text = [...real, ...bot, ...broadcasts].filter((e) => (e.text ?? "").trim() && capByTs.has(e.ts) && !capByTs.get(e.ts)!.text.trim()).map((e) => e.ts);
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
    no_text,
    pass: {
      recall: keyedRecall >= RECALL_MIN,
      author: authorRate >= AUTHOR_MIN && unverifiable.every((u) => u.captured_names.length === 1 && u.captured_names[0] !== ""),
      time: duration <= TIME_MAX_S,
    },
  };
}

// Step 1 thread check (D5): keyed recall of thread replies by ts against the export, the same bar as channels.
// The baseline is every reply that isn't also sent to the channel: 494 in the locked 25. Sent-to-channel copies
// are already measured by the channel check, so here they're only counted.

export interface ThreadMissed {
  ts: string;
  thread_ts: string;
  /** not_attempted: the file has no entry for the parent; not_opened: its pane never opened; in_pane: the pane
   *  was read and this reply wasn't in it. */
  why: "not_attempted" | "not_opened" | "in_pane";
  permalink: string;
  author: string;
  text: string;
}

export interface ThreadExtra {
  ts: string;
  thread_ts: string;
  /** wrong_parent: the export has this reply under another parent; top_level: the export has it as a channel post. */
  why: "wrong_parent" | "top_level" | "after_export" | "not_in_export";
  text: string;
}

export interface ThreadReport {
  channel_id: string;
  channel_name: string;
  duration_s: number;
  /** Parents with at least one reply in the export, and how many of them the file covers. */
  threads_in_export: number;
  threads_attempted: number;
  threads_opened: number;
  stop_reasons: Record<string, number>;
  export_replies: number;
  matched: number;
  recall: number;
  broadcasts_seen: number;
  /** Parents whose rendered "N replies" differs from the export's reply_count (deleted or later replies). */
  count_mismatches: { thread_ts: string; shown: number; export: number }[];
  missed: ThreadMissed[];
  extras: ThreadExtra[];
  author: { checked: number; matched: number; rate: number; mismatches: { ts: string; captured: string; expected: string[] }[] };
  /** Found under its parent, but with no text where the export has some (Slack's loading placeholder). */
  no_text: string[];
  pass: { recall: boolean; author: boolean };
}

const isReply = (m: ExportMessage) => !isTopLevel(m) && m.subtype !== "thread_broadcast";

export function compareThreads(cap: ThreadCaptureFile, exp: SlackExport, exportCutoffTs: number, origin = "https://app.slack.com"): ThreadReport {
  const name = exp.channelsById.get(cap.channel_id);
  if (!name) throw new Error(`${cap.channel_id} (${cap.channel_name}) is not in the export's channels.json`);
  const all = readChannel(exp, name);
  const byTs = new Map(all.map((m) => [m.ts, m]));
  const replies = all.filter(isReply);
  const parents = new Set(replies.map((m) => m.thread_ts!));
  const runs = new Map(cap.threads.map((t) => [t.thread_ts, t]));
  const captured = new Map(cap.threads.flatMap((t) => t.replies.filter((r) => r.subtype !== "thread_broadcast").map((r) => [r.ts, r] as const)));

  // A reply counts only under its own parent; one filed under another parent is an extra (wrong_parent).
  const found = (m: ExportMessage) => captured.get(m.ts)?.thread_ts === m.thread_ts;
  const missed: ThreadMissed[] = replies
    .filter((m) => !found(m))
    .map((m) => {
      const run = runs.get(m.thread_ts!);
      return {
        ts: m.ts,
        thread_ts: m.thread_ts!,
        why: !run ? ("not_attempted" as const) : run.stop_reason === "not_opened" ? ("not_opened" as const) : ("in_pane" as const),
        permalink: `${origin}/archives/${cap.channel_id}/p${m.ts.replace(".", "")}?thread_ts=${m.thread_ts}&cid=${cap.channel_id}`,
        author: expectedAuthorNames(exp, m)[0] ?? m.user ?? "",
        text: snippet(m.text ?? ""),
      };
    });

  const extras: ThreadExtra[] = [];
  for (const [ts, r] of captured) {
    const e = byTs.get(ts);
    if (e && isReply(e) && e.thread_ts === r.thread_ts) continue;
    const why = e ? (isTopLevel(e) ? "top_level" : "wrong_parent") : Number(ts) > exportCutoffTs ? "after_export" : "not_in_export";
    extras.push({ ts, thread_ts: r.thread_ts!, why, text: snippet(r.text) });
  }

  const mismatches: ThreadReport["author"]["mismatches"] = [];
  let checked = 0;
  for (const e of replies) {
    const c = found(e) ? captured.get(e.ts) : undefined;
    const expected = c ? expectedAuthorNames(exp, e) : [];
    if (!c || !expected.length) continue;
    checked++;
    if (!expected.some((n) => normName(n) === normName(c.author_name))) mismatches.push({ ts: e.ts, captured: c.author_name, expected });
  }

  const no_text = replies.filter((e) => found(e) && (e.text ?? "").trim() && !captured.get(e.ts)!.text.trim()).map((e) => e.ts);
  const count_mismatches = cap.threads
    .filter((t) => t.reply_count_shown !== null && byTs.get(t.thread_ts)?.reply_count !== undefined && t.reply_count_shown !== byTs.get(t.thread_ts)!.reply_count)
    .map((t) => ({ thread_ts: t.thread_ts, shown: t.reply_count_shown!, export: byTs.get(t.thread_ts)!.reply_count! }));
  const stop_reasons: Record<string, number> = {};
  for (const t of cap.threads) stop_reasons[t.stop_reason] = (stop_reasons[t.stop_reason] ?? 0) + 1;
  const matched = replies.length - missed.length;
  const recall = replies.length ? matched / replies.length : 1;
  const rate = checked ? (checked - mismatches.length) / checked : 1;
  return {
    channel_id: cap.channel_id,
    channel_name: name,
    duration_s: Math.round((Date.parse(cap.finished_at) - Date.parse(cap.started_at)) / 1000),
    threads_in_export: parents.size,
    threads_attempted: [...parents].filter((p) => runs.has(p)).length,
    threads_opened: [...parents].filter((p) => runs.has(p) && runs.get(p)!.stop_reason !== "not_opened").length,
    stop_reasons,
    export_replies: replies.length,
    matched,
    recall,
    broadcasts_seen: cap.threads.reduce((n, t) => n + t.replies.filter((r) => r.subtype === "thread_broadcast").length, 0),
    count_mismatches,
    missed,
    extras,
    author: { checked, matched: checked - mismatches.length, rate, mismatches },
    no_text,
    pass: { recall: recall >= RECALL_MIN, author: rate >= AUTHOR_MIN },
  };
}

/** Recall over every reply in the given channels' export: the step-1 gate is this number for the locked 25. A
 *  channel with no thread file counts all its replies as missed. */
export function threadTotals(exp: SlackExport, channels: string[], reports: ThreadReport[]) {
  const byName = new Map(reports.map((r) => [r.channel_name, r]));
  let replies = 0, matched = 0;
  const uncaptured: string[] = [];
  for (const ch of channels) {
    const r = byName.get(ch);
    if (r) { replies += r.export_replies; matched += r.matched; continue; }
    const n = readChannel(exp, ch).filter(isReply).length;
    replies += n;
    if (n) uncaptured.push(ch);
  }
  const recall = replies ? matched / replies : 1;
  return { replies, matched, recall, uncaptured, pass: recall >= RECALL_MIN };
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
