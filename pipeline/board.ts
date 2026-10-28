// `hr board`: the data the board renders (data/board.json, workspace data, gitignored) and the local
// server for board/index.html. Offers come only from the Opus grouping pass (`hr group`); the board
// never shows a number it can't link to source posts. Demo mode (D18, amended 2026-10-27) hides author
// names only: offer text is the evidence, so excerpts are shown, with people's names in the text
// redacted the same way as the classifier input.
import type { Offer } from "./group.ts";
import type { Sponsors } from "./pool.ts";
import { buildNameList, compileRedactor } from "./redact.ts";
import type { PosterRole } from "./roles.ts";
import type { Message } from "./schema.ts";

export const BOARD_DATA_PATH = "data/board.json";
export const BOARD_PAGE = new URL("../board/index.html", import.meta.url).pathname;

export interface BoardPost {
  ts: number;
  permalink: string;
  channel: string;
}
export interface BoardOffer {
  id: string;
  sponsor: string;
  title: string;
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
  basis: { grouping: string; model: string; written_at: string };
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
 *  href goes), bare URLs shortened to their host, emoji codes dropped. */
export function plainText(s: string): string {
  return s
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, "$2")
    .replace(/\s*<https?:\/\/[^>\s]+>/g, "")
    .replace(/https?:\/\/[^\s)>\]]+/g, (u) => host(u))
    .replace(/:[a-z0-9_+'-]+:/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The evidence: the post that states the offer (its code, then its amount, then its claim link, else the first),
 *  starting at the sentence that mentions it, about three lines long. */
export function excerpt(texts: { raw: string; plain: string }[], f: Pick<Offer, "promo_code" | "claim_url" | "amount_text">, max = 280): string {
  const keys = [f.promo_code, f.amount_text, f.claim_url].filter(Boolean);
  for (const k of [...keys, ""]) {
    const t = texts.find((x) => (k ? x.raw.includes(k) || x.plain.includes(k) : true));
    if (!t) continue;
    const at = k ? Math.max(0, t.plain.indexOf(k === f.claim_url ? host(k) : k)) : 0;
    const start = Math.max(0, ...[". ", "! ", "? "].map((d) => {
      const k = t.plain.lastIndexOf(d, at);
      return k < 0 ? 0 : k + 2;
    }));
    const from = at - start > max / 2 ? at : start;
    const body = t.plain.slice(from);
    return (from > 0 ? "…" : "") + (body.length > max ? body.slice(0, max).replace(/\s+\S*$/, "") + "…" : body);
  }
  return "";
}

export function boardData(o: {
  event: string;
  timezone: string;
  run_id: string;
  channels: string[];
  messages: Message[];
  sponsors: Sponsors;
  offers: Offer[];
  role: (m: Message) => PosterRole;
  basis: BoardData["basis"];
  /** Permalinks for sheet rows the capture missed. */
  permalinks?: Map<string, string>;
}): BoardData {
  const byId = new Map(o.messages.map((m) => [m.id, m]));
  const redact = compileRedactor(buildNameList(new Set(o.messages.filter((m) => m.author_kind !== "bot").map((m) => m.author_name)), o.sponsors));
  const posts = o.messages.filter((m) => !m.subtype && m.author_kind !== "bot").map((m) => Number(m.ts)).sort((a, b) => a - b);
  const offers: BoardOffer[] = o.offers.map((f, i) => {
    const ps = f.posts.map((id) => {
      const m = byId.get(id);
      return { ts: Number(m?.ts ?? id.split(":")[1]), permalink: m?.permalink ?? o.permalinks?.get(id) ?? "", channel: m?.channel_name ?? "" };
    });
    const texts = f.posts.map((id) => byId.get(id)).filter((m): m is Message => !!m).map((m) => ({ raw: m.text, plain: redact(plainText(m.text)).text }));
    return {
      id: `o${i + 1}`,
      sponsor: f.sponsor === "event" ? o.event : f.sponsor,
      title: f.title,
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
  const reps = Object.entries(o.sponsors)
    .filter(([ch, s]) => o.channels.includes(ch) && s.sponsor !== "event")
    .map(([ch, s]) => {
      const inCh = o.messages.filter((m) => m.channel_name === ch && !m.subtype && m.author_kind !== "bot");
      return {
        sponsor: s.sponsor,
        channel: ch,
        posts: inCh.length,
        offers: offers.filter((f) => f.posts.some((p) => p.channel === ch)).length,
        candidates: new Set(inCh.filter((m) => o.role(m) === "sponsor-side").map((m) => m.author_name)).size,
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
    basis: o.basis,
  };
}
