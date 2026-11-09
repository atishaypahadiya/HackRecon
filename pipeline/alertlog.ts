// The alert log (user 2026-11-08, before Iterate): every alert sent, with its category and when it went out, and
// whether the user responded or acted within 30 minutes. Recording only: nothing here changes what alerts or when.
// After the event it's the data an interruption policy is built on.
import type { Alert, Notice } from "./alerts.ts";
import type { ChatTurn } from "./agent.ts";
import type { WriteRecord } from "./told.ts";
import type { OutboxLine } from "./watch.ts";

/** The user's categories. No alert rule produces "intro" yet; "other" holds room changes, how to submit, judging,
 *  unread badges and non-credit offers (each line keeps the alert's own kind beside it). */
export const ALERT_CATEGORIES = ["deadline", "workshop", "credit", "track", "intro", "other"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export function alertCategory(a: Pick<Alert, "kind" | "offer_kind">): AlertCategory {
  if (a.kind === "deadline") return "deadline";
  if (a.kind === "workshop") return "workshop";
  if (a.kind === "tracks") return "track";
  if (a.kind === "offer" && a.offer_kind === "credit") return "credit";
  return "other";
}

/** One alert in one message: sent, or a failed or dry-run attempt (a failed one is retried and logged again). */
export interface AlertSend {
  key: string;
  kind: Alert["kind"];
  category: AlertCategory;
  level: Alert["level"];
  what: string;
  source: string;
  posted_at: string;
  /** When it joined its queue (a held-back "now" alert or a digest item waits). */
  queued_at: string;
  /** When the message carrying it went out (or was attempted). */
  sent_at: string;
  /** "now" alone or with up to two others; "digest" in the 2-hour digest. */
  via: Notice["level"];
  /** Alerts in the same message, this one included. */
  batch: number;
  status: OutboxLine["status"];
  channel?: string;
  /** The channel's id for the message (Telegram message_id), so a reply to it can be matched. */
  ref?: string;
}

export function alertSends(n: Notice, line: OutboxLine): AlertSend[] {
  return n.alerts.map((a) => ({
    key: a.key,
    kind: a.kind,
    category: alertCategory(a),
    level: a.level,
    what: a.what,
    source: a.source,
    posted_at: a.posted_at,
    queued_at: a.queued_at,
    sent_at: line.at,
    via: n.level,
    batch: n.alerts.length,
    status: line.status,
    ...(line.channel ? { channel: line.channel } : {}),
    ...(line.ref ? { ref: line.ref } : {}),
  }));
}

export const RESPONSE_WINDOW_MS = 30 * 60_000;

export interface AlertOutcome extends AlertSend {
  /** False while the 30 minutes since sent_at haven't passed: the answers below can still change. */
  window_closed: boolean;
  /** The user's first message to Donna in the window; `reply` when it was a Telegram reply to this alert's message. */
  responded: { at: string; minutes: number; reply: boolean; text: string } | null;
  /** Writes in the window, from chat or the board (claims, entered tracks, Ship ticks, stack, team, rep notes). */
  acted: { at: string; minutes: number; op: string; source: string; result: string }[];
}

const minutes = (from: string, to: string) => Math.round(((Date.parse(to) - Date.parse(from)) / 60_000) * 10) / 10;

/** Sent alerts only (the last successful send per alert), each with what the user did in the 30 minutes after. */
export function alertOutcomes(sends: AlertSend[], turns: ChatTurn[], writes: WriteRecord[], nowMs: number): AlertOutcome[] {
  const sent = new Map<string, AlertSend>();
  for (const s of sends) if (s.status === "sent") sent.set(s.key, s);
  const inWindow = (sentAt: string, at: string) => {
    const d = Date.parse(at) - Date.parse(sentAt);
    return d >= 0 && d <= RESPONSE_WINDOW_MS;
  };
  return [...sent.values()]
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
    .map((s) => {
      const t = turns.filter((x) => inWindow(s.sent_at, x.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const reply = s.ref ? t.find((x) => x.reply_to === s.ref) : undefined;
      const first = reply ?? t[0];
      return {
        ...s,
        window_closed: nowMs - Date.parse(s.sent_at) > RESPONSE_WINDOW_MS,
        responded: first ? { at: first.at, minutes: minutes(s.sent_at, first.at), reply: !!reply, text: first.q } : null,
        acted: writes
          .filter((w) => inWindow(s.sent_at, w.at) && !/\b(asked|cancelled)$/.test(w.op))
          .map((w) => ({ at: w.at, minutes: minutes(s.sent_at, w.at), op: w.op, source: w.source, result: w.result })),
      };
    });
}

/** Per category: sent, responded and acted within 30 minutes, counting closed windows only. */
export function outcomeSummary(o: AlertOutcome[]): { category: AlertCategory; sent: number; closed: number; responded: number; replied: number; acted: number }[] {
  return ALERT_CATEGORIES.map((category) => {
    const all = o.filter((x) => x.category === category);
    const closed = all.filter((x) => x.window_closed);
    return {
      category,
      sent: all.length,
      closed: closed.length,
      responded: closed.filter((x) => x.responded).length,
      replied: closed.filter((x) => x.responded?.reply).length,
      acted: closed.filter((x) => x.acted.length).length,
    };
  });
}
