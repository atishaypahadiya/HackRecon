// `hr pool`: builds the day-2 labeling sheet (D12). The pool is drawn from the slackdump baseline
// (a sanctioned baseline use: labels must cover messages the capture missed, so capture recall can
// be measured); text, author and permalink come from the capture when the message is in it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toCsv } from "./csv.ts";
import { expectedAuthorNames, isTopLevel, readChannel, rowClass, type SlackExport } from "./export.ts";
import { COLUMNS, LABEL_COLUMNS, hasLabel, type LabelRow } from "./labels.ts";
import { messageId, type Message } from "./schema.ts";
import { tsToEventIso } from "./time.ts";

/** The design doc's keyword list (`$`, credit, code, promo, free, deadline, due, by <day/time>,
 *  tonight, submit, apply, RSVP, closes). Reproduces the measured 187 top-level hits in the locked 25. */
export const KEYWORD_RE =
  /\$\s?\d|\b(?:credit|code|promo|free|deadline|due|tonight|submit|apply|rsvp|closes)|\bby (?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|today|tomorrow|tonight|noon|midnight|eod|end of|\d)/i;

export const RANDOM_N = 30;
export const DEFAULT_SEED = 20261027;

export interface SponsorEntry {
  sponsor: string;
  kind: string;
  aliases: string[];
  stretch?: boolean;
}
export type Sponsors = Record<string, SponsorEntry>;

/** A channel-visible baseline message: real top-level post or reply also sent to the channel. */
export interface Candidate {
  id: string;
  channel_id: string;
  channel: string;
  ts: string;
  cls: "real" | "broadcast";
  text: string;
  author: string;
}

export function candidatesFromExport(exp: SlackExport, channels: string[]): Candidate[] {
  const idByName = new Map([...exp.channelsById].map(([id, name]) => [name, id]));
  return channels.flatMap((channel) => {
    const cid = idByName.get(channel);
    if (!cid) throw new Error(`${channel} is not in the export's channels.json`);
    return readChannel(exp, channel).flatMap((m): Candidate[] => {
      const cls = rowClass(m);
      if (!((cls === "real" && isTopLevel(m)) || cls === "broadcast")) return [];
      return [{ id: messageId(cid, m.ts), channel_id: cid, channel, ts: m.ts, cls, text: m.text ?? "", author: expectedAuthorNames(exp, m)[0] ?? "" }];
    });
  });
}

/** mulberry32: small, seedable, same sequence on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Selection {
  keyword: Candidate[];
  random: Candidate[];
}

/** Every keyword hit (real top-level and broadcast), plus `randomN` real top-level non-hits.
 *  Random picks already in the sheet (`keepRandom`) are kept, so a re-run never re-draws them. */
export function selectPool(cands: Candidate[], seed = DEFAULT_SEED, randomN = RANDOM_N, keepRandom = new Set<string>()): Selection {
  const keyword = cands.filter((c) => KEYWORD_RE.test(c.text));
  const hit = new Set(keyword.map((c) => c.id));
  const others = cands.filter((c) => c.cls === "real" && !hit.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const kept = others.filter((c) => keepRandom.has(c.id));
  const rest = others.filter((c) => !keepRandom.has(c.id));
  const next = rng(seed);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return { keyword, random: [...kept, ...rest.slice(0, Math.max(0, randomN - kept.length))] };
}

export function permalinkFor(workspace: string, channelId: string, ts: string): string {
  return `${workspace}/archives/${channelId}/p${ts.replace(".", "")}`;
}

export interface BuildOpts {
  sponsors: Sponsors;
  captured: Map<string, Message>;
  workspace: string;
  existing: LabelRow[];
}

export interface Built {
  rows: LabelRow[];
  /** Rows already in the sheet that are no longer in the pool; kept at the end, never dropped. */
  orphans: LabelRow[];
}

/** Sheet rows in sponsors.json channel order, then ts. Human columns carry over by message_id. */
export function buildRows(sel: Selection, o: BuildOpts): Built {
  const order = Object.keys(o.sponsors);
  const prev = new Map(o.existing.map((r) => [r.message_id, r]));
  const tagged = [...sel.keyword.map((c) => ({ c, pool: "keyword" })), ...sel.random.map((c) => ({ c, pool: "random" }))];
  tagged.sort((a, b) => order.indexOf(a.c.channel) - order.indexOf(b.c.channel) || (a.c.ts < b.c.ts ? -1 : a.c.ts > b.c.ts ? 1 : 0));
  const rows = tagged.map(({ c, pool }) => {
    const m = o.captured.get(c.id);
    const row = {
      message_id: c.id,
      channel: c.channel,
      sponsor: o.sponsors[c.channel]?.sponsor ?? "",
      posted_at: tsToEventIso(c.ts),
      author: m?.author_name ?? c.author,
      subtype: c.cls === "broadcast" ? "thread_broadcast" : "",
      pool,
      in_capture: m ? "y" : "n",
      permalink: m?.permalink ?? permalinkFor(o.workspace, c.channel_id, c.ts),
      // Capture text is what the classifier sees; baseline text (Slack mrkdwn) only if it was missed.
      text: m?.text ?? c.text,
    } as LabelRow;
    const old = prev.get(c.id);
    for (const col of LABEL_COLUMNS) row[col] = old?.[col] ?? "";
    return row;
  });
  const inPool = new Set(rows.map((r) => r.message_id));
  const orphans = o.existing.filter((r) => !inPool.has(r.message_id) && (hasLabel(r) || r.pool === "flagged"));
  return { rows, orphans };
}

export function writeSheet(path: string, rows: LabelRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toCsv([[...COLUMNS], ...rows.map((r) => COLUMNS.map((c) => r[c]))]));
}

export function readSponsors(path: string): Sponsors {
  return JSON.parse(readFileSync(path, "utf8")) as Sponsors;
}

export function lockedChannels(s: Sponsors): string[] {
  return Object.entries(s)
    .filter(([, v]) => !v.stretch)
    .map(([k]) => k);
}

