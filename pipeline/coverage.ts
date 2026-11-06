// D15 coverage checks: model-free, so they back the Opus judge instead of trusting it. On one page's
// snapshot and the entities extracted from it:
//   prize_total   the page's own total ("$204,408+ in prizes") = Σ track cash_value_usd × winners (each prize
//                 block's "$X in cash" line times its "N winners" line); measured equal on Cal Hacks, 2026-11-06.
//                 Any nonzero gap fails; every prize block whose figures don't match is listed.
//   prize_blocks  every prize block (Devpost: an element id prize_<n>) has exactly one track named from its
//                 heading, and the number of tracks equals the number of prize blocks; within a block, the number
//                 of prizes (not counting "every entrant") equals the number of stated places, or 1 when none is
//                 stated (D15 (2), user 2026-11-06). statedPlaces() is how places are counted.
//   prize_amounts info, never gating (D15 (1), user): the literal sum of prize amounts that state a dollar
//                 figure, beside the page total, so the gap between the two is visible on every run.
//   figures       every $-amount and date on the page is inside a verified quote from its block, or is
//                 listed "unattached". Listing is the check (D15); an unattached figure in a prize block
//                 is also counted, so a dropped award shows up in the summary.
// A check that doesn't apply (no total stated, no prize blocks) says so and neither passes nor fails.
import { norm } from "./canon.ts";
import type { Entity, PageSnapshot } from "./schema.ts";

export interface CoverageCheck {
  name: "prize_total" | "prize_blocks" | "prize_amounts" | "figures";
  /** null: doesn't apply to this page. */
  pass: boolean | null;
  summary: string;
  details: string[];
}
export interface CoverageReport {
  url: string;
  pass: boolean;
  checks: CoverageCheck[];
}

const PRIZE_ANCHOR = /^prize_\d+$/;
const MONEY = /\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?\s?[kK]?(?![\d])|\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:USD|USDC)\b|\b\d(?:[\d,]*\d)?\$/g;
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "gi");

/** "$1k", "$1,000" and "1000 USD" all read as 1000 (OV8). */
export function moneyValue(token: string): number {
  const m = /(\d[\d,]*(?:\.\d+)?)\s?([kK])?/.exec(token)!;
  return Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
}

export function figuresIn(text: string): string[] {
  return [...text.matchAll(MONEY), ...text.matchAll(DATE)].map((m) => m[0].trim());
}

/** The page's stated prize total, e.g. "$204,408+ in prizes" → 204408. */
export function statedTotal(s: PageSnapshot): { usd: number; block: number; text: string } | null {
  for (const b of s.blocks) {
    const m = /\$\s?([\d,]+)\+?\s+in prizes/i.exec(b.text);
    if (m) return { usd: Number(m[1]!.replace(/,/g, "")), block: b.i, text: m[0] };
  }
  return null;
}

function prizeBlocks(s: PageSnapshot) {
  const out = new Map<string, { heading: number; title: string; cash: number | null; winners: number | null; lines: string[] }>();
  for (const b of s.blocks) {
    if (!b.anchor || !PRIZE_ANCHOR.test(b.anchor)) continue;
    if (b.heading && !out.has(b.anchor)) out.set(b.anchor, { heading: b.i, title: b.text, cash: null, winners: null, lines: [] });
    const p = out.get(b.anchor);
    if (!p || b.heading) continue;
    const cash = /^\$\s?([\d,]+) in cash$/i.exec(b.text);
    const won = /^(\d+) winners?$/i.exec(b.text);
    if (cash && p.cash === null) p.cash = Number(cash[1]!.replace(/,/g, ""));
    else if (won && p.winners === null) p.winners = Number(won[1]);
    else p.lines.push(b.text);
  }
  return out;
}

/** "1st", "5th"; and word ordinals only before a number or "place" ("first 2 teams"), not in prose ("be the first"). */
const ORDINAL = /\b\d+(?:st|nd|rd|th)\b|\b(?:first|second|third|fourth|fifth)\b(?=\s+(?:\d|place))/gi;
const SEGMENT = /\s*(?:\|\||\s\/\s|\n)\s*/;
/** A named place in a place list: "Special Recognition: $250 each". */
const NAMED = /^[A-Za-z][\w'&-]*(?:\s+[\w'&-]+){0,3}\s*:/;

/**
 * Stated places in a prize block's lines (D15 (2)). A line is a place list when it has an ordinal; there each
 * ordinal is a place ("3rd, 4th & 5th Place: $500 each" is three), plus each segment that names a place
 * without one ("Special Recognition: …"). Elsewhere, "top N" preceded in its clause by N amounts is N places
 * ("8000$, 5000$, 3000$ for the top 3 teams"), and any other "top N" is one award ("interview for top 5
 * teams"). 0 when the block states no places. Measured on Cal Hacks run 3: all 52 blocks agree.
 */
export function statedPlaces(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (ORDINAL.test(line)) {
      ORDINAL.lastIndex = 0;
      for (const seg of line.split(SEGMENT)) {
        const k = seg.match(ORDINAL)?.length ?? 0;
        n += k || (NAMED.test(seg) ? 1 : 0);
      }
      continue;
    }
    let from = 0;
    for (const m of line.matchAll(/\btop (\d+)\b/gi)) {
      const amounts = line.slice(from, m.index).match(MONEY)?.length ?? 0;
      n += amounts >= Number(m[1]) ? Number(m[1]) : 1;
      from = m.index! + m[0].length;
    }
  }
  return n;
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

export function coverage(s: PageSnapshot, entities: Entity[]): CoverageReport {
  const checks: CoverageCheck[] = [];
  const blocks = prizeBlocks(s);
  const anchorOf = (block: number | undefined) => (block === undefined ? undefined : s.blocks[block]?.anchor);
  const tracks = entities.filter((e) => e.kind === "track");
  const trackByAnchor = new Map<string, Entity>();
  for (const t of tracks) {
    const a = anchorOf(t.name.source.block);
    if (a && PRIZE_ANCHOR.test(a) && !trackByAnchor.has(a)) trackByAnchor.set(a, t);
  }

  // prize_total
  const total = statedTotal(s);
  if (!total) checks.push({ name: "prize_total", pass: null, summary: "the page states no prize total", details: [] });
  else {
    const details: string[] = [];
    let sum = 0;
    for (const t of tracks) sum += (num(t.fields.cash_value_usd?.value) ?? 0) * (num(t.fields.winners?.value) ?? 1);
    for (const [anchor, p] of blocks) {
      const t = trackByAnchor.get(anchor);
      const page = (p.cash ?? 0) * (p.winners ?? 1);
      const got = t ? (num(t.fields.cash_value_usd?.value) ?? 0) * (num(t.fields.winners?.value) ?? 1) : 0;
      if (page !== got)
        details.push(`${p.title}: page $${p.cash ?? 0} × ${p.winners ?? 1} = $${page}; extracted ${t ? `$${num(t.fields.cash_value_usd?.value) ?? "none"} × ${num(t.fields.winners?.value) ?? "none"} = $${got}` : "no track"}`);
    }
    const gap = total.usd - sum;
    checks.push({
      name: "prize_total",
      pass: gap === 0,
      summary: `page "${total.text}" = $${total.usd}; extracted Σ cash × winners = $${sum}${gap ? `; gap $${gap}` : ""}`,
      details,
    });
  }

  // prize_blocks
  if (!blocks.size) checks.push({ name: "prize_blocks", pass: null, summary: "no prize blocks on this page", details: [] });
  else {
    const prizesOn = new Map<string, number>();
    for (const e of entities)
      if (e.kind === "prize" && !/every entrant/i.test(String(e.fields.place?.value ?? ""))) prizesOn.set(String(e.fields.track_id?.value), (prizesOn.get(String(e.fields.track_id?.value)) ?? 0) + 1);
    const tracksOn = new Map<string, number>();
    for (const t of tracks) {
      const a = anchorOf(t.name.source.block);
      if (a && PRIZE_ANCHOR.test(a)) tracksOn.set(a, (tracksOn.get(a) ?? 0) + 1);
    }
    const details: string[] = [];
    let withTrack = 0;
    let placesMatch = 0;
    for (const [anchor, p] of blocks) {
      const t = trackByAnchor.get(anchor);
      const k = tracksOn.get(anchor) ?? 0;
      if (!t) details.push(`${p.title} (${anchor}): no track`);
      else if (k > 1) details.push(`${p.title} (${anchor}): ${k} tracks`);
      else {
        withTrack++;
        const want = statedPlaces(p.lines) || 1;
        const got = prizesOn.get(t.id) ?? 0;
        if (got === want) placesMatch++;
        else details.push(`${p.title} (${anchor}): ${want} stated place${want === 1 ? "" : "s"}, ${got} prize${got === 1 ? "" : "s"} extracted`);
      }
    }
    const prizes = entities.filter((e) => e.kind === "prize").length;
    const trackCount = [...tracksOn.values()].reduce((a, b) => a + b, 0);
    checks.push({
      name: "prize_blocks",
      pass: withTrack === blocks.size && placesMatch === blocks.size && trackCount === blocks.size,
      summary: `${blocks.size} prize blocks, ${trackCount} tracks on them; ${withTrack} with exactly one track; ${placesMatch} with prizes = stated places; ${prizes} prizes extracted`,
      details,
    });
    // prize_amounts: D15 (1)'s literal reading, shown, never gating.
    const prizeEnts = entities.filter((e) => e.kind === "prize");
    const stated = prizeEnts.map((e) => num(e.fields.amount_usd?.value)).filter((v): v is number => v !== null);
    const literal = stated.reduce((a, b) => a + b, 0);
    checks.push({
      name: "prize_amounts",
      pass: null,
      summary: `prize amounts stated on ${stated.length} of ${prizeEnts.length} prizes, $${literal}${total ? ` (page total $${total.usd}; the gate is prize_total)` : ""}`,
      details: [],
    });
  }

  // figures
  const quotes = new Map<number, string[]>();
  for (const e of entities)
    for (const fv of [e.name, ...Object.values(e.fields)]) {
      const b = fv.source.block;
      if (b !== undefined) quotes.set(b, [...(quotes.get(b) ?? []), norm(fv.source.quote)]);
    }
  const unattached: string[] = [];
  let all = 0;
  let inPrizeBlocks = 0;
  for (const b of s.blocks) {
    for (const f of figuresIn(b.text)) {
      all++;
      if ((quotes.get(b.i) ?? []).some((q) => q.includes(norm(f)))) continue;
      const inPrize = !!b.anchor && PRIZE_ANCHOR.test(b.anchor);
      if (inPrize) inPrizeBlocks++;
      unattached.push(`[${b.i}] ${f}${inPrize ? ` (prize block ${b.anchor})` : ""}: ${norm(b.text).slice(0, 100)}`);
    }
  }
  checks.push({
    name: "figures",
    pass: null,
    summary: `${all} $-amounts and dates on the page; ${all - unattached.length} attached, ${unattached.length} unattached (${inPrizeBlocks} in prize blocks)`,
    details: unattached,
  });

  return { url: s.url, pass: checks.every((c) => c.pass !== false), checks };
}
