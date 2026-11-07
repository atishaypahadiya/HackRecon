// `hr board`: the data the board renders (data/board.json, workspace data, gitignored) and the local
// server for board/index.html. Offers come only from the Opus grouping pass (`hr group`); the board
// never shows a number it can't link to source posts. Demo mode (D18, amended 2026-10-27) hides author
// names only: offer text is the evidence, so excerpts are shown, with people's names in the text
// redacted the same way as the classifier input.
import type { EventConfig } from "./classify.ts";
import type { Offer } from "./group.ts";
import type { Sponsors } from "./pool.ts";
import { buildNameList, compileRedactor } from "./redact.ts";
import { likelySince, signalLabels, type RepIndex } from "./reps.ts";
import { sponsorSignals, type A5Signal, type PosterRole } from "./roles.ts";
import type { Message } from "./schema.ts";
import {  } from "./event.ts";

export const BOARD_PAGE = new URL("../board/index.html", import.meta.url).pathname;
/** Inlined into the page at `<!-- prefill.js -->` (the CSP allows inline scripts only). */
export const BOARD_PREFILL_JS = new URL("../board/prefill.js", import.meta.url).pathname;
/** Self-hosted (CSP font-src 'self'), OFL texts beside them; see DESIGN.md. Only these names are served. */
export const BOARD_FONT_DIR = new URL("../board/fonts/", import.meta.url).pathname;
export const BOARD_FONTS = ["manrope.woff2", "atkinson-hyperlegible-mono.woff2"] as const;

export interface BoardPost {
  ts: number;
  permalink: string;
  channel: string;
}
export interface BoardOffer {
  id: string;
  sponsor: string;
  title: string;
  value_short: string;
  claim_short: string;
  amount_text: string;
  /** Stated USD per person; null when the posts don't state one. */
  usd: number | null;
  /** Epoch seconds of the stated deadline or claim-window end. */
  limit: number | null;
  limit_unclear: boolean;
  claim_url: string;
  promo_code: string;
  claim_how: string;
  /** The first post's time: the offer appears on the board from here. */
  first: number;
  excerpt: string;
  posts: BoardPost[];
}
export interface BoardRep {
  sponsor: string;
  channel: string;
  posts: number;
  offers: number;
  candidates: number;
  /** When each rep candidate first posted (epoch seconds), ascending: the board counts candidates found by
   *  the replay's time. Times only, never names (demo mode). */
  candidate_first: number[];
}
export interface BoardEventDeadline {
  what: string;
  /** Epoch seconds. */
  at: number;
  until: number | null;
  /** When the organizers announced it (the source post's time), so the replay shows it only from then. */
  posted: number;
  source: string;
}
export interface BoardData {
  event: string;
  timezone: string;
  run_id: string;
  channels: number;
  /** Real top-level post times (the P set), ascending. */
  posts: number[];
  offers: BoardOffer[];
  frames: number[];
  reps: BoardRep[];
  /** Per sponsor channel, how many Slack accounts stand behind each rep candidate, aligned with that rep's
   *  candidate_first (people.ts: one person with two accounts is one candidate). Kept out of `reps`, whose shape
   *  D14 fingerprints. */
  rep_accounts: Record<string, number[]>;
  /** Per sponsor channel, what each rep candidate matched (reps.ts signalLabels), aligned with candidate_first.
   *  Signal 3 is left out here (Plan shows it): its counts depend on the replay's time. */
  rep_signals: Record<string, string[][]>;
  /** Per sponsor channel, when each candidate first named the sponsor as their employer (reps.ts signal 2b), aligned
   *  the same way; null if never. A time, so a replay shows it only once posted; no phrase, which can hold a name. */
  rep_self: Record<string, (number | null)[]>;
  /** Per sponsor channel, likely staff (reps.ts signal 3) who aren't sponsor-side: shown apart, never counted as
   *  reps, never given authority. `first` is when the signal first holds (a staff post and an answer both in);
   *  posts and answers are their times, so a replay counts only what was posted by then. Never names. */
  rep_likely: Record<string, { first: number; posts: number[]; answers: number[]; self: number | null; hacker: number }[]>;
  /** The organizers' own deadlines from config/event.json, superseded entries left out. */
  event_deadlines: BoardEventDeadline[];
  basis: { grouping: string; model: string; written_at: string };
  /** v1's positional ids (`o<n>`) → today's, so done marks saved before OV5 migrate once in the browser. */
  v1_ids?: Record<string, string>;
}

/** OV5: an offer's id is its first post: `o-<channel name>-<ts digits>`, the ts as the permalink writes it.
 *  Stable when offers are regrouped or reordered; a second offer from the same first post gets `~2`. */
export function offerIds(firsts: { channel: string; ts: string }[]): string[] {
  const seen = new Map<string, number>();
  return firsts.map((f) => {
    const base = `o-${f.channel}-${f.ts.replace(".", "")}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

const firstKey = (o: Pick<BoardOffer, "posts">) => {
  const p = o.posts.reduce((a, b) => (b.ts < a.ts ? b : a));
  return `${p.channel} ${p.ts}`;
};

/** v1 id → today's id, from the board.json this build replaces: carried forward when it already has the map,
 *  else matched by first post when its ids are still positional (v1). Offers with no match are left out. */
export function v1Ids(prev: Pick<BoardData, "offers" | "v1_ids"> | null, offers: BoardOffer[]): Record<string, string> {
  if (!prev) return {};
  const ids = new Set(offers.map((o) => o.id));
  if (prev.v1_ids) return Object.fromEntries(Object.entries(prev.v1_ids).filter(([, id]) => ids.has(id)));
  const byFirst = new Map(offers.filter((o) => o.posts.length).map((o) => [firstKey(o), o.id]));
  const out: Record<string, string> = {};
  for (const o of prev.offers) if (/^o\d+$/.test(o.id) && o.posts.length && byFirst.has(firstKey(o))) out[o.id] = byFirst.get(firstKey(o))!;
  return out;
}

/** A Slack permalink's message time: .../p1792918203114859 is ts 1792918203.114859. */
export function permalinkTs(url: string): number | null {
  const m = /\/p(\d{10})(\d{6})(?:\b|$)/.exec(url);
  return m ? Number(`${m[1]}.${m[2]}`) : null;
}

export function eventDeadlines(schedule: EventConfig["schedule"]): BoardEventDeadline[] {
  return schedule
    .filter((s) => !s.superseded_by)
    .map((s) => ({ what: s.what, at: Date.parse(s.at) / 1000, until: s.until ? Date.parse(s.until) / 1000 : null, posted: permalinkTs(s.source) ?? Date.parse(s.at) / 1000, source: s.source }))
    .sort((a, b) => a.at - b.at);
}

/** Epoch seconds of 08:00 local time on the calendar day containing t, in tz. */
export function morningOf(t: number, tz: string): number {
  t = Math.floor(t);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t * 1000))
      .map((p) => [p.type, p.value]),
  );
  const sinceMidnight = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return t - sinceMidnight + 8 * 3600;
}

/** Replay frames, from the data only (D16 without the 3-hour cadence: event.json has no hacking window yet).
 *  08:00 every morning from the first morning after the oldest post to the first morning after the newest,
 *  plus a frame at each offer's first post and at each limit inside that range, so every offer is seen open
 *  before it moves to Missed. Limits after the last morning add nothing (the replay ends the morning after). */
export function replayFrames(posts: number[], offers: BoardOffer[], tz: string): number[] {
  if (!posts.length) return [];
  const after = (t: number) => {
    const m = morningOf(t, tz);
    return m > t ? m : morningOf(t + 86400, tz);
  };
  const first = after(posts[0]!);
  const last = after(posts.at(-1)!);
  const out = new Set<number>();
  for (let d = first; d <= last; d = after(d)) out.add(d);
  for (const o of offers) {
    if (o.first >= first && o.first <= last) out.add(o.first);
    if (o.limit !== null && o.limit > first && o.limit <= last) out.add(o.limit);
  }
  return [...out].sort((a, b) => a - b);
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** Post text as plain reading text: link labels kept (the capture writes anchors as `label <href>`, so the
 *  href goes), bare URLs shortened to their host, emoji codes dropped. Line breaks are kept (one per break)
 *  because they end sentences in Slack posts; excerpt() flattens them. */
export function plainText(s: string): string {
  return s
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, "$2")
    .replace(/[ \t]*<https?:\/\/[^>\s]+>/g, "")
    .replace(/https?:\/\/[^\s)>\]]+/g, (u) => host(u))
    .replace(/:[a-z0-9_+'-]+:/g, "")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

/** The evidence: the post that states the offer (its code, then its amount, then its short value, then its claim
 *  link, else the first),
 *  from the start of the sentence that mentions it, trimmed at the end to about three lines. */
export function excerpt(texts: { raw: string; plain: string }[], f: Pick<Offer, "promo_code" | "claim_url" | "amount_text"> & { value_short?: string }, max = 280): string {
  const keys = [f.promo_code, f.amount_text, f.value_short ?? "", f.claim_url].filter(Boolean);
  for (const k of [...keys, ""]) {
    const t = texts.find((x) => (k ? x.raw.includes(k) || x.plain.includes(k) : true));
    if (!t) continue;
    const at = k ? Math.max(0, t.plain.indexOf(k === f.claim_url ? host(k) : k)) : 0;
    // Sentence ends: ". ", "! ", "? ", and a line break unless the next line carries on in lowercase.
    let from = 0;
    for (const m of t.plain.matchAll(/[.!?] |\n(?!\p{Ll})/gu)) {
      const end = m.index + m[0].length;
      if (end > at) break;
      from = end;
    }
    const body = t.plain.slice(from).replace(/\n/g, " ");
    return body.length > max ? body.slice(0, max).replace(/\s+\S*$/, "") + "…" : body;
  }
  return "";
}

export function boardData(o: {
  event: string;
  timezone: string;
  schedule?: EventConfig["schedule"];
  run_id: string;
  channels: string[];
  messages: Message[];
  sponsors: Sponsors;
  offers: Offer[];
  role: (m: Message) => PosterRole;
  /** Slack id → its person (people.ts); without it every account is its own person. */
  person?: (id: string) => string;
  /** reps.ts evidence: signals to show per rep, and likely staff. */
  reps?: RepIndex;
  basis: BoardData["basis"];
  /** Permalinks for sheet rows the capture missed. */
  permalinks?: Map<string, string>;
}): BoardData {
  const byId = new Map(o.messages.map((m) => [m.id, m]));
  const redact = compileRedactor(buildNameList(new Set(o.messages.filter((m) => m.author_kind !== "bot").map((m) => m.author_name)), o.sponsors));
  const posts = o.messages.filter((m) => !m.subtype && m.author_kind !== "bot").map((m) => Number(m.ts)).sort((a, b) => a - b);
  const ids = offerIds(
    o.offers.map((f) => {
      const id = f.posts.reduce((a, b) => (Number(b.split(":")[1]) < Number(a.split(":")[1]) ? b : a));
      return { channel: byId.get(id)?.channel_name ?? "", ts: id.split(":")[1] ?? "" };
    }),
  );
  const offers: BoardOffer[] = o.offers.map((f, i) => {
    const ps = f.posts.map((id) => {
      const m = byId.get(id);
      return { ts: Number(m?.ts ?? id.split(":")[1]), permalink: m?.permalink ?? o.permalinks?.get(id) ?? "", channel: m?.channel_name ?? "" };
    });
    const texts = f.posts.map((id) => byId.get(id)).filter((m): m is Message => !!m).map((m) => ({ raw: m.text, plain: redact(plainText(m.text)).text }));
    return {
      id: ids[i]!,
      sponsor: f.sponsor === "event" ? o.event : f.sponsor,
      title: f.title,
      value_short: f.value_short,
      claim_short: f.claim_short,
      amount_text: f.amount_text,
      usd: f.amount_usd_per_person ? Number(f.amount_usd_per_person) : null,
      limit: f.limit_iso ? Date.parse(f.limit_iso) / 1000 : null,
      limit_unclear: !f.limit_iso && f.limit_status === "unresolved",
      claim_url: f.claim_url,
      promo_code: f.promo_code,
      claim_how: f.claim_how,
      first: Math.min(...ps.map((p) => p.ts)),
      excerpt: excerpt(texts, f),
      posts: ps.sort((a, b) => a.ts - b.ts),
    };
  });
  const repAccounts: Record<string, number[]> = {};
  const repSignals: Record<string, string[][]> = {};
  const repSelf: Record<string, (number | null)[]> = {};
  const repLikely: BoardData["rep_likely"] = {};
  const reps = Object.entries(o.sponsors)
    .filter(([ch, s]) => o.channels.includes(ch) && s.sponsor !== "event")
    .map(([ch, s]) => {
      const inCh = o.messages.filter((m) => m.channel_name === ch && !m.subtype && m.author_kind !== "bot");
      // Keyed by person: a Slack id, or the ids people.ts links on hashed evidence. A rename never splits or merges a rep.
      const person = o.person ?? ((id: string) => id);
      const firstBy = new Map<string, number>();
      const accounts = new Map<string, Set<string>>();
      const a5 = new Map<string, Set<A5Signal>>();
      const likelyFirst = new Map<string, number>();
      for (const m of inCh) {
        if (!m.author_id) continue;
        const who = person(m.author_id);
        if (o.role(m) !== "sponsor-side") {
          const since = likelySince(o.reps?.signals.get(`${who}|${s.sponsor}`));
          if (o.role(m) === "other" && o.reps?.likely.get(who)?.has(s.sponsor) && since !== null) likelyFirst.set(who, since);
          continue;
        }
        firstBy.set(who, Math.min(firstBy.get(who) ?? Infinity, Number(m.ts)));
        accounts.set(who, (accounts.get(who) ?? new Set()).add(m.author_id));
        for (const x of sponsorSignals(m, s)) a5.set(who, (a5.get(who) ?? new Set()).add(x));
      }
      const ranked = [...firstBy].sort((a, b) => a[1] - b[1]);
      repAccounts[ch] = ranked.map(([who]) => accounts.get(who)!.size);
      const fileSignals = (who: string) => o.reps?.signals.get(`${who}|${s.sponsor}`) ?? [];
      const selfSince = (who: string) => {
        const x = fileSignals(who).find((x) => x.kind === "self-identified");
        return x?.kind === "self-identified" ? (x.posts[0]?.ts ?? null) : null;
      };
      repSignals[ch] = ranked.map(([who]) => signalLabels([...(a5.get(who) ?? [])], fileSignals(who).filter((x) => x.kind === "email domain" || x.kind === "organizer mention" || x.kind === "hacker channels")));
      repSelf[ch] = ranked.map(([who]) => selfSince(who));
      repLikely[ch] = [...likelyFirst].sort((a, b) => a[1] - b[1]).map(([who, first]) => {
        const l = fileSignals(who).find((x) => x.kind === "likely staff");
        const h = fileSignals(who).find((x) => x.kind === "hacker channels");
        return {
          first,
          posts: l?.kind === "likely staff" ? l.posts.map((e) => e.ts) : [],
          answers: l?.kind === "likely staff" ? l.answers.map((e) => e.ts) : [],
          self: selfSince(who),
          hacker: h?.kind === "hacker channels" ? h.channels.reduce((n, c) => n + c.posts, 0) : 0,
        };
      });
      return {
        sponsor: s.sponsor,
        channel: ch,
        posts: inCh.length,
        offers: offers.filter((f) => f.posts.some((p) => p.channel === ch)).length,
        candidates: firstBy.size,
        candidate_first: ranked.map(([, t]) => t),
      };
    })
    .sort((a, b) => b.offers - a.offers || b.candidates - a.candidates || b.posts - a.posts);
  return {
    event: o.event,
    timezone: o.timezone,
    run_id: o.run_id,
    channels: o.channels.length,
    posts,
    offers,
    frames: replayFrames(posts, offers, o.timezone),
    reps,
    rep_accounts: repAccounts,
    rep_signals: repSignals,
    rep_self: repSelf,
    rep_likely: repLikely,
    event_deadlines: eventDeadlines(o.schedule ?? []),
    basis: o.basis,
  };
}
