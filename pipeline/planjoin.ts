// Plan's Credits, Sessions and People (P3–P5, user 2026-11-07): deterministic joins, no model calls. Each joins on
// the same sponsors: those the user's stack names, plus the likely tracks' sponsors. Every item carries a quote that
// is checked against its source post here, or it isn't shown ("no suggestion without a verified source quote").
import type { BoardOffer } from "./board.ts";
import { productMentioned, type SponsorAliases } from "./fit.ts";
import type { PlanInput, PlanTrack } from "./plan.ts";
import { likelySince, signalLabels, type RepIndex } from "./reps.ts";
import { sponsorSignals, type A5Signal, type PosterRole } from "./roles.ts";
import type { Item, Message } from "./schema.ts";
import type { Sponsors } from "./pool.ts";

export interface JoinSponsor {
  sponsor: string;
  /** "in your stack: Claude API", "likely track: [Apify] Best Use of Apify". */
  why: string[];
}

/** Sponsors named by the stack (name, sponsors.json alias or products.json product, as a whole word), in stack
 *  order, then the likely tracks' sponsors in track order. Possible tracks add none. */
export function joinSponsors(input: PlanInput, tracks: PlanTrack[], aliases: SponsorAliases, products: { sponsor: string; product: string; names: string[] }[]): JoinSponsor[] {
  const out = new Map<string, string[]>();
  const add = (s: string, why: string) => out.set(s, [...new Set([...(out.get(s) ?? []), why])]);
  const names = (s: string) => [s, ...(aliases[s] ?? []), ...products.filter((p) => p.sponsor === s).flatMap((p) => [p.product, ...p.names])].filter(Boolean);
  const all = Object.keys(aliases).filter((s) => s !== "event");
  for (const item of input.stack ?? []) for (const s of all) if (names(s).some((n) => productMentioned(n, item.name))) add(s, `in your stack: ${item.name}`);
  for (const t of tracks) if (t.fit === "likely" && t.sponsor && t.sponsor !== "event") add(t.sponsor, `likely track: ${t.name}`);
  return [...out].map(([sponsor, why]) => ({ sponsor, why }));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** The first line of a post, verbatim, cut at a word boundary past `max` with "…". */
export function firstLine(text: string, max = 160): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max).replace(/\s+\S*$/, "") + "…" : line;
}
/** A quote holds when its text, less a trailing "…", appears in the source with whitespace normalized. */
export function quoteHolds(quote: string, source: string): boolean {
  const q = squash(quote.replace(/…$/, ""));
  return q.length > 0 && squash(source).includes(q);
}

export interface PlanCredit {
  offer_id: string;
  sponsor: string;
  why: string[];
  value: string;
  quote: string;
  /** Epoch seconds; null when no limit is stated. */
  limit: number | null;
  limit_unclear: boolean;
  claim: string;
  claim_url: string;
  promo_code: string;
  first: number;
  source_url: string;
}

/** P3: Claim's offers from these sponsors, posted by now and still open, soonest limit first. `shown` gives a post's
 *  text as the board renders it (plain text), keyed by permalink; the excerpt must appear in one of them. */
export function planCredits(offers: BoardOffer[], sponsors: JoinSponsor[], shown: Map<string, string>, nowSec: number): { credits: PlanCredit[]; dropped: number } {
  const why = new Map(sponsors.map((s) => [s.sponsor, s.why]));
  let dropped = 0;
  const credits = offers
    .filter((o) => why.has(o.sponsor) && o.first <= nowSec && (o.limit === null || o.limit > nowSec))
    .flatMap((o): PlanCredit[] => {
      const post = o.posts.find((p) => quoteHolds(o.excerpt, shown.get(p.permalink) ?? ""));
      if (!post) return (dropped++, []);
      return [{ offer_id: o.id, sponsor: o.sponsor, why: why.get(o.sponsor)!, value: o.value_short || o.title, quote: o.excerpt, limit: o.limit, limit_unclear: o.limit_unclear, claim: o.claim_short || o.claim_how, claim_url: o.claim_url, promo_code: o.promo_code, first: o.first, source_url: post.permalink }];
    })
    .sort((a, b) => (a.limit ?? Infinity) - (b.limit ?? Infinity) || a.first - b.first);
  return { credits, dropped };
}

export interface SubmissionDeadline {
  at: string;
  name: string;
  source_url: string;
}

/** The submission deadline: the first event deadline (planMeta's list: event.json's unsuperseded schedule, else
 *  canon) whose name says submission. */
export function submissionDeadline(deadlines: { name: string; at: string; url: string }[]): SubmissionDeadline | null {
  const d = deadlines.filter((x) => /\bsubmi(?:ssions?|t)\b/i.test(x.name)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  return d ? { at: d.at, name: d.name, source_url: d.url } : null;
}

export interface PlanSession {
  sponsor: string;
  why: string[];
  start: string;
  quote: string;
  source_url: string;
}

/** A post's text as the board shows it: plain text, as posted (the Claim board's rendering). Every quote on Plan is
 *  taken from, and checked against, this. */
export type Shown = (m: Message) => string;

/** P4: workshops, talks and office hours (classifier kind `workshop`) from these sponsors, starting after now and
 *  before the submission deadline, by time. One per sponsor and start; the quote is the post's first line, as shown. */
export function planSessions(items: Item[], messages: Map<string, Message>, sponsors: JoinSponsor[], nowMs: number, deadline: SubmissionDeadline | null, shown: Shown): PlanSession[] {
  const why = new Map(sponsors.map((s) => [s.sponsor, s.why]));
  const end = deadline ? Date.parse(deadline.at) : Infinity;
  const seen = new Set<string>();
  return items
    .filter((i) => i.kind === "workshop" && i.event_start_iso && why.has(i.sponsor))
    .map((i) => ({ i, at: Date.parse(i.event_start_iso!), m: messages.get(i.message_id) }))
    .filter(({ at, m }) => at > nowMs && at < end && !!m && Number(m.ts) * 1000 <= nowMs)
    .sort((a, b) => a.at - b.at || Number(a.m!.ts) - Number(b.m!.ts))
    .flatMap(({ i, at, m }) => {
      const key = `${i.sponsor}|${at}`;
      const text = shown(m!), quote = firstLine(text);
      if (seen.has(key) || !quoteHolds(quote, text)) return [];
      seen.add(key);
      return [{ sponsor: i.sponsor, why: why.get(i.sponsor)!, start: i.event_start_iso!, quote, source_url: m!.permalink }];
    });
}

export interface PlanRep {
  person: string;
  /** Display name on their latest post (names change mid-event; the key is the person). */
  name: string;
  accounts: number;
  posts: number;
  first: number;
  quote: string;
  source_url: string;
  /** What the rep matched, strongest first (reps.ts signalLabels). */
  signals: string[];
  /** Likely staff only (reps.ts signal 3): shown with its evidence, never sponsor-side. */
  likely: boolean;
}

export interface PlanPeople {
  sponsor: string;
  why: string[];
  reps: PlanRep[];
}

/** P5: reps of each likely track's sponsor: sponsor-side posters in that sponsor's channels, by person, posted by
 *  now; then likely staff (reps.ts), labeled. Every rep carries the signals it matched. */
export function planPeople(messages: Message[], sponsors: JoinSponsor[], channels: Sponsors, role: (m: Message) => PosterRole, person: (id: string) => string, nowSec: number, shown: Shown, ix?: RepIndex): PlanPeople[] {
  return sponsors
    .filter((s) => s.why.some((w) => w.startsWith("likely track: ")))
    .map((s) => {
      const by = new Map<string, Message[]>();
      for (const m of messages) {
        const ch = channels[m.channel_name];
        if (ch?.sponsor !== s.sponsor || ch.kind === "event" || !m.author_id || m.subtype || m.author_kind === "bot" || Number(m.ts) > nowSec) continue;
        const who = person(m.author_id);
        // Likely staff only once both its staff post and its answer are posted, as of now.
        const since = likelySince(ix?.signals.get(`${who}|${s.sponsor}`));
        if (role(m) !== "sponsor-side" && !(role(m) === "other" && ix?.likely.get(who)?.has(s.sponsor) && since !== null && since <= nowSec)) continue;
        by.set(who, [...(by.get(who) ?? []), m]);
      }
      const out = [...by].flatMap(([who, ms]): PlanRep[] => {
        ms.sort((a, b) => Number(a.ts) - Number(b.ts));
        const first = ms[0]!, text = shown(first), quote = firstLine(text);
        if (!quoteHolds(quote, text)) return [];
        const likely = role(first) !== "sponsor-side";
        const a5 = likely ? [] : [...new Set(ms.flatMap((m) => sponsorSignals(m, channels[m.channel_name])))] as A5Signal[];
        const signals = signalLabels(a5, ix?.signals.get(`${who}|${s.sponsor}`), nowSec);
        return [{ person: who, name: ms.at(-1)!.author_name, accounts: new Set(ms.map((m) => m.author_id)).size, posts: ms.length, first: Number(first.ts), quote, source_url: first.permalink, signals, likely }];
      });
      return { sponsor: s.sponsor, why: s.why, reps: out.sort((a, b) => Number(a.likely) - Number(b.likely) || a.first - b.first) };
    });
}
