// Alerts (user 2026-11-07): when something relevant lands (tracks or judging posted, a deadline or a room or time
// change, a workshop matching the user's stack, a sponsor offer), a message with the item, why it matters to this
// project, and the source, through the user's channel (channels.ts: Telegram for Nov 14). Important ones go out at once, rate-limited; the rest wait for a digest.
// Every post goes through classify --new first (offers, deadlines and workshops come from its items); tracks,
// judging and room changes are read from the post itself, and only where organizers post (D19: Message.authority).
// Nothing here is a model call. The user's Plan (data/plan.json, saved by `hr plan`) says what matters.
import { sourceLine } from "./discord.ts";
import type { Item, Message } from "./schema.ts";

export interface PlanFacts {
  saved_at?: string;
  input: { idea: string; stack: { name: string; used_for: string | null; told?: { source: "chat" | "board"; at: string; quote: string | null } }[] | null; repo?: string | null };
  /** Gaps and booth questions in the last run (chat writes report the change). */
  counts?: { gaps: number | null; booths: number | null; /** Slice 4: gaps no teammate lists a skill for. */ gaps_nobody?: number | null };
  tracks: { track_id: string; name: string; sponsor: string; fit: "likely" | "possible"; product_names: string[]; /** Since slice 4's leave fix: what a departure restores. */ reason?: string; quote?: string }[];
  /** The event's own unranked track(s), verbatim (plan.ts OverallTrack); absent in Plans saved before 2026-11-08. */
  overall?: { name: string; descriptions: string[]; prizes: string[]; source_url: string }[];
}

export const ALERT_KINDS = ["change", "deadline", "tracks", "judging", "workshop", "offer", "unread"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const KIND_LABEL: Record<AlertKind, string> = {
  change: "Room or time change",
  deadline: "Deadline",
  tracks: "Tracks posted",
  judging: "Judging",
  workshop: "Workshop",
  offer: "Sponsor offer",
  unread: "New post",
};

export interface Alert {
  /** One alert per post (or per unread badge): the post's id, or "unread:<channel>:<since>". */
  key: string;
  kind: AlertKind;
  level: "now" | "digest";
  what: string;
  why: string;
  source: string;
  link: string;
  posted_at: string;
}

/** Only fresh posts alert: the first read of a channel shows its history, which is old news. */
export const ALERT_MAX_AGE_MS = 6 * 3600_000;
/** A post stamped this far ahead of the clock still counts (clock skew); later than that, it hasn't happened yet. */
export const ALERT_SKEW_MS = 5 * 60_000;
export const isFresh = (postedMs: number, nowMs: number) => postedMs <= nowMs + ALERT_SKEW_MS && nowMs - postedMs <= ALERT_MAX_AGE_MS;

const TRACKS = /\b(tracks?|prizes?|challenges?)\b/i;
const POSTED = /\b(live|out|up|posted|announced|released|revealed|published|available)\b|\bhere (are|is)\b/i;
const JUDGING = /\bjudg(ing|es|ed)\b/i;
const JUDGING_INFO = /\b(criteria|rubric|starts?|begins?|schedule|slots?|rooms?|order|process|times?)\b/i;
const CHANGED = /\b(moved|moving|relocat\w*|changed?|rescheduled|postponed|delayed|pushed back|new (room|location|time)|now (in|at)|instead)\b/i;
const PLACE_OR_TIME = /\b(room|hall|floor|building|location|venue|stage|time)\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;
const DUE = /\b(due|deadline|submissions? (close|closes|closing)|closes at)\b/i;

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ");
const mentions = (text: string, name: string) => name.trim().length >= 2 && ` ${words(text)} `.includes(` ${words(name).trim()} `);

/** Why a post matters to this project, from the Plan only: a stack item it names, or a Plan track's sponsor or
 *  product it names. Empty when it touches neither. */
export function planHits(text: string, sponsor: string, plan: PlanFacts | null): string[] {
  if (!plan) return [];
  const out: string[] = [];
  for (const s of plan.input.stack ?? []) if (mentions(text, s.name) || (sponsor && words(sponsor).trim() === words(s.name).trim())) out.push(`It's about ${s.name}, in your stack${s.used_for ? ` (${s.used_for})` : ""}`);
  for (const t of plan.tracks) {
    const names = [t.sponsor, ...t.product_names].filter((n) => n && n !== "event");
    if (names.some((n) => mentions(text, n) || words(sponsor).trim() === words(n).trim())) out.push(`Your Plan's ${t.fit} track: ${t.name}`);
  }
  return [...new Set(out)];
}

const firstLine = (s: string, n = 160) => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line;
};

function when(iso: string | undefined, nowMs: number, tz: string): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  const s = new Date(at).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });
  const h = (at - nowMs) / 3600_000;
  return h > 0 ? `${s} (in ${h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`})` : s;
}

/** One alert at most per post: the most urgent rule that matches; null when none does. */
export function alertFor(m: Message, items: Item[], plan: PlanFacts | null, o: { nowMs: number; tz: string; guildName?: string; organizer: boolean }): Alert | null {
  const authority = o.organizer || !!m.authority;
  const base = { key: m.id, what: firstLine(m.text), source: sourceLine(m, o.guildName), link: m.permalink, posted_at: new Date(Number(m.ts) * 1000).toISOString() };
  const hits = (sponsor = "") => planHits(m.text, sponsor, plan);
  const likely = plan?.tracks.filter((t) => t.fit === "likely").map((t) => t.name) ?? [];
  const deadline = items.find((i) => i.kind === "deadline" || i.deadline_status !== "none");
  if (authority && CHANGED.test(m.text) && PLACE_OR_TIME.test(m.text)) {
    const h = hits();
    return { ...base, kind: "change", level: "now", why: h.length ? h.join("; ") : "Anything you planned around the old room or time is out of date" };
  }
  if (deadline || (authority && DUE.test(m.text))) {
    const due = when(deadline?.deadline_iso, o.nowMs, o.tz);
    return { ...base, kind: "deadline", level: authority ? "now" : "digest", why: [due ? `Due ${due}` : "", ...hits(deadline?.sponsor)].filter(Boolean).join("; ") || "A time limit for hackers" };
  }
  if (authority && TRACKS.test(m.text) && POSTED.test(m.text))
    return { ...base, kind: "tracks", level: "now", why: likely.length ? `Check your Plan's likely tracks are there as you expect: ${likely.join(", ")}` : "Tracks decide what to build for: run your Plan on them" };
  if (authority && JUDGING.test(m.text) && JUDGING_INFO.test(m.text)) return { ...base, kind: "judging", level: "now", why: "How your project is judged and when" };
  const workshop = items.find((i) => i.kind === "workshop");
  if (workshop) {
    const h = hits(workshop.sponsor);
    const at = when(workshop.event_start_iso, o.nowMs, o.tz);
    return { ...base, kind: "workshop", level: h.length ? "now" : "digest", why: [...h, at ? `Starts ${at}` : ""].filter(Boolean).join("; ") || "Not tied to your stack or tracks" };
  }
  // "other" is food, swag and the like: a sponsor's counts as an offer, the event's own (dinner is served) doesn't.
  const offer = items.find((i) => i.kind === "credit" || i.kind === "prize" || i.kind === "job" || (i.kind === "other" && i.sponsor !== "event"));
  if (offer) {
    const h = offer.kind === "job" ? [] : hits(offer.sponsor);
    // The classifier's amount is the post's own words ("$50 in Modal credits"): add only what it leaves out.
    const amount = offer.amount_text;
    const named = offer.sponsor !== "event" && !mentions(amount, offer.sponsor) ? `${offer.sponsor}: ` : "";
    const what = !amount || offer.kind === "job" || offer.kind === "other" ? base.what : `${named}${amount}${offer.kind === "credit" && !/credit/i.test(amount) ? " in credits" : offer.kind === "prize" && !/prize/i.test(amount) ? " prize" : ""}`;
    return { ...base, kind: "offer", what, level: h.length ? "now" : "digest", why: h.length ? h.join("; ") : offer.kind === "job" ? "A job or internship, not tied to your project" : "Not tied to your stack or tracks" };
  }
  return null;
}

/** A sidebar badge on a discovered channel no open tab shows: something landed there, content unknown. */
/** What a re-read of the event's page changed about tracks (hr watch's hourly check, user 2026-11-08): tracks that
 *  weren't in canon before, with the re-ranked Plan's fit when the re-rank ran, and event.json canon_notes whose
 *  line the page dropped (e.g. "Thematic prizes from challenge partners" turning into named tracks). */
export interface TrackChange {
  at: string;
  url: string;
  tracks: { name: string; sponsor: string; fit: "likely" | "possible" | null }[];
  notes_gone: string[];
}

export function pageChangeAlert(c: TrackChange): Alert {
  const named = c.tracks.map((t) => `${t.name}${t.sponsor !== "event" ? ` (${t.sponsor})` : ""}`);
  const likely = c.tracks.filter((t) => t.fit === "likely").map((t) => t.name);
  const gone = c.notes_gone.map((q) => `"${q}" is no longer on the event page`);
  const ranked = c.tracks.some((t) => t.fit);
  return {
    key: `page:${c.url}:${c.at}`,
    kind: "tracks",
    level: "now",
    what: [named.length ? `New tracks on the event page: ${named.join(", ")}` : "", ...gone].filter(Boolean).join(". "),
    why: likely.length
      ? `Your Plan likely fits ${likely.join(", ")}`
      : c.tracks.length
        ? ranked ? "Ranked against your Plan: possible fits at most" : "Not ranked against your Plan yet"
        : "Its prizes may now be named tracks",
    source: "the event page",
    link: c.url,
    posted_at: c.at,
  };
}

export function unreadAlert(u: { channel_id: string; channel_name: string; role: string; since: string; guild_id: string; guild_name: string }): Alert {
  return {
    key: `unread:${u.channel_id}:${u.since}`,
    kind: "unread",
    level: u.role === "announcement" ? "now" : "digest",
    what: `New post in #${u.channel_name}`,
    why: u.role === "announcement" ? "An announcement channel no open tab shows: open it in Discord to read it" : "A sponsor channel no open tab shows",
    source: `#${u.channel_name}, ${u.guild_name}`,
    link: `https://discord.com/channels/${u.guild_id}/${u.channel_id}`,
    posted_at: u.since,
  };
}

// Delivery: "Rate-limit to the important ones; batch the rest."
/** At most one immediate text per 10 minutes, four an hour; what's held back goes in the next one. */
export const NOW_MIN_GAP_MS = 10 * 60_000;
export const NOW_MAX_PER_HOUR = 4;
export const NOW_MAX_ITEMS = 3;
/** The rest: a digest every two hours, when there is anything. */
export const DIGEST_EVERY_MS = 2 * 3600_000;
export const DIGEST_MAX_ITEMS = 6;
/** Twilio takes up to 1,600 characters; texts stay well under. */
export const MESSAGE_MAX_CHARS = 1200;

export interface NotifyState {
  alerted: string[];
  queue_now: (Alert & { queued_at: string })[];
  queue_digest: (Alert & { queued_at: string })[];
  sent: { at: string; level: "now" | "digest"; keys: string[] }[];
}
export const EMPTY_NOTIFY: NotifyState = { alerted: [], queue_now: [], queue_digest: [], sent: [] };

export interface Notice {
  level: "now" | "digest";
  body: string;
  keys: string[];
  /** What it carries, so a text that fails to send goes back in its queue. */
  alerts: (Alert & { queued_at: string })[];
}

function cap(body: string): string {
  return body.length <= MESSAGE_MAX_CHARS ? body : `${body.slice(0, MESSAGE_MAX_CHARS - 1).trimEnd()}…`;
}

export function nowBody(alerts: Alert[], more: number): string {
  const one = (a: Alert) => [KIND_LABEL[a.kind], a.what, `Why: ${a.why}`, a.source, a.link].join("\n");
  const head = alerts.length === 1 ? `Donna: ${one(alerts[0]!)}` : `Donna, ${alerts.length} updates:\n\n${alerts.map((a, i) => `${i + 1}. ${one(a)}`).join("\n\n")}`;
  return cap(head + (more ? `\n\n+${more} more in the next message` : ""));
}

export function digestBody(alerts: Alert[], more: number): string {
  const line = (a: Alert, i: number) => `${i + 1}. ${KIND_LABEL[a.kind]}: ${a.what} (${a.source})`;
  return cap(`Donna's digest, ${alerts.length + more} item${alerts.length + more === 1 ? "" : "s"}:\n${alerts.map(line).join("\n")}${more ? `\n+${more} more: bun run hr alerts --list` : ""}`);
}

/** New alerts in, texts out. Pure: the caller sends them and saves the state. */
export function deliver(prev: NotifyState, fresh: Alert[], nowMs: number): { state: NotifyState; notices: Notice[] } {
  const now = new Date(nowMs).toISOString();
  const alerted = new Set(prev.alerted);
  const state: NotifyState = { alerted: [...prev.alerted], queue_now: [...prev.queue_now], queue_digest: [...prev.queue_digest], sent: [...prev.sent] };
  for (const a of fresh) {
    if (alerted.has(a.key)) continue;
    alerted.add(a.key);
    state.alerted.push(a.key);
    (a.level === "now" ? state.queue_now : state.queue_digest).push({ ...a, queued_at: now });
  }
  const notices: Notice[] = [];
  const nows = state.sent.filter((s) => s.level === "now").map((s) => Date.parse(s.at));
  const lastNow = Math.max(-Infinity, ...nows);
  if (state.queue_now.length && nowMs - lastNow >= NOW_MIN_GAP_MS && nows.filter((t) => nowMs - t < 3600_000).length < NOW_MAX_PER_HOUR) {
    const take = state.queue_now.splice(0, NOW_MAX_ITEMS);
    notices.push({ level: "now", body: nowBody(take, state.queue_now.length), keys: take.map((a) => a.key), alerts: take });
  }
  const lastDigest = Math.max(-Infinity, ...state.sent.filter((s) => s.level === "digest").map((s) => Date.parse(s.at)));
  const since = Math.max(lastDigest, Math.min(...state.queue_digest.map((a) => Date.parse(a.queued_at))));
  if (state.queue_digest.length && nowMs - since >= DIGEST_EVERY_MS) {
    const take = state.queue_digest.splice(0);
    notices.push({ level: "digest", body: digestBody(take.slice(0, DIGEST_MAX_ITEMS), Math.max(0, take.length - DIGEST_MAX_ITEMS)), keys: take.map((a) => a.key), alerts: take });
  }
  for (const s of notices) state.sent.push({ at: now, level: s.level, keys: s.keys });
  return { state, notices };
}

/** A text that didn't go out: its alerts back at the front of their queue, its send forgotten. */
export function unsend(state: NotifyState, s: Notice): NotifyState {
  const key = s.keys.join(",");
  const i = state.sent.map((x) => x.level === s.level && x.keys.join(",") === key).lastIndexOf(true);
  const sent = i < 0 ? state.sent : [...state.sent.slice(0, i), ...state.sent.slice(i + 1)];
  return s.level === "now" ? { ...state, sent, queue_now: [...s.alerts, ...state.queue_now] } : { ...state, sent, queue_digest: [...s.alerts, ...state.queue_digest] };
}
