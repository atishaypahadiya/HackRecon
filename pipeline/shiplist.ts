// Ship's checklist (P9, design doc §4 Ship, D13): deterministic joins over canon, event.json's schedule and the
// capture, as of an instant (a replay sees only what was posted by then). No model calls. Every line shown is
// verbatim: a page's sentence, or a post's sentence as the board renders it (redacted plain text).
import type { EventConfig } from "./classify.ts";
import { entrySteps, trackDetail } from "./plan.ts";
import type { Shown } from "./planjoin.ts";
import { baseline, disagreement, merge, type PageChange } from "./merge.ts";
import type { Change, Entity, Message } from "./schema.ts";

export interface ShipItem {
  /** Done-state key, shared with Plan: an entry step's id is the same in both, so ticking either ticks both. */
  id: string;
  /** The checkbox's text: the verbatim line, or for the drafts item, HackRecon's own wording. */
  label: string;
  /** The verbatim line, when the label isn't it. */
  quote?: string;
  /** "page": canon; "slack": a post (`channel` says where); "standing": HackRecon's own item, no source; "told": a
   *  rep's requirement told to Donna (`told_by` says who), the weakest tier. */
  from: "page" | "slack" | "standing" | "told";
  told_by?: string;
  source_url: string;
  channel?: string;
  /** When it happens, for schedule items (ISO). */
  at?: string;
  until?: string;
}

export interface ShipDeadline {
  at: string;
  quote: string;
  from: "page" | "slack";
  source_url: string;
  channel?: string;
  /** What the page said, when a post moved it (D13's merge line: "Sun 9:30 · Devpost said 9:00"). */
  was?: { at: string; quote: string; source_url: string };
  /** Merge rule 4: a post landed inside a page edit's window, so no winner is picked ("Page and Slack disagree…"). */
  disagree?: string;
}

export interface ShipList {
  deadline: ShipDeadline | null;
  /** 1. Required to submit: the drafts item first, then the page's submission rules. */
  required: ShipItem[];
  /** 2. For the tracks you entered: entry steps, then stated requirements, per track. */
  tracks: { track_id: string; name: string; source_url: string; items: ShipItem[] }[];
  /** Every track on the pages, in page order: what the "Tracks you're entering" chooser offers. Never Plan's
   *  picks (user 2026-11-07): what you enter is yours, ticked here or read from your Devpost draft. */
  choices: { track_id: string; name: string }[];
  /** 3. Judging: schedule entries from the deadline on, then the page's rules about pitching and judges. */
  judging: ShipItem[];
}

/** A post's sentences, without the broadcast mention that opens it ("@channel"), which isn't part of any sentence. */
const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim().replace(/^@(?:channel|here|everyone)\s+/, "")).filter(Boolean);
const tsOf = (permalink: string) => {
  const m = /\/p(\d{10})(\d{6})/.exec(permalink);
  return m ? Number(`${m[1]}.${m[2]}`) : null;
};

/** A clock time as posts write it ("9:30am", "9:30 AM", "9am", "9 AM"), in the event's timezone. */
export function timePattern(iso: string, tz: string): RegExp {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === "hour")!.value, mm = parts.find((p) => p.type === "minute")!.value;
  const ap = parts.find((p) => p.type === "dayPeriod")!.value[0]!.toLowerCase();
  return new RegExp(mm === "00" ? `(?<![\\d:])${h}(?::00)?\\s*${ap}\\.?m\\b` : `(?<![\\d:])${h}:${mm}(?!\\d)`, "i");
}

/** Schedule entries current at `nowSec`: posted by then, and not yet superseded by an entry also posted by then. */
export function currentSchedule(e: EventConfig, nowSec: number): EventConfig["schedule"] {
  const s = e.schedule.filter((x) => x.at && (tsOf(x.source) ?? -Infinity) <= nowSec);
  const posted = new Set(s.map((x) => x.what));
  return s.filter((x) => !x.superseded_by || !posted.has(x.superseded_by));
}

/** The post's sentence naming the entry's time (and its end, for a window); the first such, else null. */
function sentenceAt(text: string, at: string, until: string | undefined, tz: string): string | null {
  const ss = sentences(text);
  const a = timePattern(at, tz), u = until ? timePattern(until, tz) : null;
  return (u && ss.find((x) => a.test(x) && u.test(x))) || ss.find((x) => a.test(x)) || null;
}

export function shipList(o: {
  entities: Entity[];
  event: EventConfig;
  messages: Message[];
  /** Organizer, or a top-level post in an authority channel (roles.ts). */
  isOrganizer: (m: Message) => boolean;
  shown: Shown;
  entered: string[];
  nowSec: number;
  /** Later snapshots' field changes (merge rule 2); none when each page has one snapshot. */
  pageChanges?: PageChange[];
}): ShipList {
  const tz = o.event.timezone;
  const byLink = new Map(o.messages.map((m) => [m.permalink, m]));
  const fromPost = (url: string) => {
    const m = byLink.get(url);
    return m && Number(m.ts) <= o.nowSec ? m : null;
  };
  const schedule = currentSchedule(o.event, o.nowSec);

  // The deadline: the page's submission rule, merged (§3) with the schedule's submission entry as a Slack change at
  // its post's time, authorized only for an organizer's post (D8), and with any later snapshot's edit by now.
  // `o.entities` is each page's first snapshot; page edits made by now are merged in (a replay never sees one early).
  const pageNow = (o.pageChanges ?? []).filter((c) => Date.parse(c.window.until) <= o.nowSec * 1000);
  const entities = pageNow.length ? merge(o.entities, { page: pageNow, authorized: () => true }) : o.entities;
  const rules = entities.filter((x) => x.kind === "rule");
  const subRule = o.entities
    .filter((x) => x.kind === "rule")
    .filter((x) => x.fields.rule_kind?.value === "submission" && typeof x.fields.deadline?.value === "string")
    .sort((a, b) => Date.parse(String(a.fields.deadline!.value)) - Date.parse(String(b.fields.deadline!.value)))[0];
  const slackDl = schedule.filter((x) => /\bsubmi(?:ssions?|t)\b/i.test(x.what)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  const post = slackDl ? fromPost(slackDl.source) : null;
  const postQuote = post && slackDl ? sentenceAt(o.shown(post), slackDl.at, undefined, tz) : null;
  let deadline: ShipDeadline | null = null;
  if (subRule) {
    // A post that agrees with the page (the same instant, however written) changes nothing: the page stays the source.
    const slack: Change[] = post && postQuote && Date.parse(slackDl!.at) !== Date.parse(String(subRule.fields.deadline!.value))
      ? [{ entity_id: subRule.id, field: "deadline", kind: "set", to: { value: slackDl!.at, source: { kind: "slack", url: post.permalink, quote: postQuote, captured_at: post.captured_at, posted_at: new Date(Number(post.ts) * 1000).toISOString() } } }]
      : [];
    const page = pageNow.filter((c) => c.entity_id === subRule.id);
    const [m] = merge([subRule], { page, slack, authorized: (c) => c.to.source.kind !== "slack" || (!!post && o.isOrganizer(post)) });
    const d = m!.fields.deadline!, base = baseline(m!, "deadline");
    const text = (f: typeof d) => String(m!.fields.text?.value ?? f.source.quote);
    deadline = {
      at: String(d.value),
      quote: d.source.kind === "slack" ? d.source.quote : text(d),
      from: d.source.kind === "slack" ? "slack" : "page",
      source_url: d.source.url,
      ...(d.source.kind === "slack" && post ? { channel: post.channel_name } : {}),
      ...(base && base.value !== d.value ? { was: { at: String(base.value), quote: String(subRule.fields.text?.value ?? base.source.quote), source_url: base.source.url } } : {}),
      ...(disagreement(m!, "deadline") ? { disagree: disagreement(m!, "deadline")! } : {}),
    };
  } else if (post && postQuote && o.isOrganizer(post)) {
    deadline = { at: slackDl!.at, quote: postQuote, from: "slack", source_url: post.permalink, channel: post.channel_name };
  }

  // 1. Required: "Submit on Devpost, not just save a draft", from the latest organizer post about drafts, then the rules.
  const drafts = o.messages
    .filter((m) => Number(m.ts) <= o.nowSec && !m.thread_ts && o.isOrganizer(m) && /\bdrafts?\b/i.test(m.text) && /\bsubmit\b/i.test(m.text))
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  const draftLines = drafts ? sentences(o.shown(drafts)).filter((s) => /\bdrafts?\b|\bsubmit\b/i.test(s)).slice(0, 2) : [];
  const required: ShipItem[] = [
    drafts && draftLines.length
      ? { id: "ship:submit", label: "Submit on Devpost, not just save a draft", quote: draftLines.join(" "), from: "slack", source_url: drafts.permalink, channel: drafts.channel_name }
      : { id: "ship:submit", label: "Submit on Devpost, not just save a draft", from: "standing", source_url: "" },
    ...rules
      .filter((x) => x.fields.rule_kind?.value === "submission" && typeof x.fields.text?.value === "string")
      .map((x): ShipItem => ({ id: x.id, label: String(x.fields.text!.value), from: "page", source_url: x.fields.text!.source.url })),
  ];

  // 2. The tracks you entered: their entry steps (the same ids as Plan's), then their stated requirements.
  const tracks = o.entered.flatMap((id) => {
    const t = entities.find((x) => x.id === id && x.kind === "track");
    if (!t) return [];
    const url = t.name.source.url;
    const steps = entrySteps(entities, [id]).map((s): ShipItem => ({ id: s.id, label: s.label, quote: s.quote, from: "page", source_url: s.source_url }));
    const quoted = new Set(steps.map((s) => s.quote));
    const reqs = trackDetail(entities, id).requirements.filter((r) => !quoted.has(r)).map((r, k): ShipItem => ({ id: `${id}:req:${k}`, label: r, from: "page", source_url: url }));
    return [{ track_id: id, name: t.name.value ?? "", source_url: url, items: [...steps, ...reqs] }];
  });

  // 3. Judging: schedule entries from the deadline on, quoted from their post; then the page's pitch and judge rules.
  const dl = deadline ? Date.parse(deadline.at) : -Infinity;
  const judging: ShipItem[] = [
    ...schedule
      .filter((x) => Date.parse(x.at) >= dl && !/\bsubmi(?:ssions?|t)\b/i.test(x.what))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .flatMap((x): ShipItem[] => {
        const m = fromPost(x.source);
        const line = m ? sentenceAt(o.shown(m), x.at, x.until, tz) : null;
        return m && line ? [{ id: `ship:judging:${Date.parse(x.at) / 1000}:${x.what}`, label: line, from: "slack", source_url: m.permalink, channel: m.channel_name, at: x.at, ...(x.until ? { until: x.until } : {}) }] : [];
      }),
    ...rules
      .filter((x) => x.fields.rule_kind?.value !== "submission" && /\b(pitch|judg\w*)\b/i.test(String(x.fields.text?.value ?? "")))
      .map((x): ShipItem => ({ id: x.id, label: String(x.fields.text!.value), from: "page", source_url: x.fields.text!.source.url })),
  ];

  const choices = entities.filter((x) => x.kind === "track").map((t) => ({ track_id: t.id, name: t.name.value ?? "" }));
  return { deadline, required, tracks, judging, choices };
}

/** D13's countdown: "5 h 12 min", "59 min", "2 d 3 h"; rounded down, so it never promises time that isn't there. */
export function durationText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under a minute";
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return d ? `${d} d${h ? ` ${h} h` : ""}` : h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
