// D15 coverage checks: model-free, so they back the Opus judge instead of trusting it. On one page's
// snapshot and the entities extracted from it:
//   prize_total   the page's own total ("$204,408+ in prizes") = Σ track cash_value_usd × winners. That is how
//                 Devpost computes it (each prize block's "$X in cash" line times its "N winners" line).
//                 Any nonzero gap fails; every prize block whose figures don't match is listed.
//   prize_blocks  every prize block (Devpost: an element id prize_<n>) has a track named from its heading,
//                 and at least one prize on that track.
//   figures       every $-amount and date on the page is inside a verified quote from its block, or is
//                 listed "unattached". Listing is the check (D15); an unattached figure in a prize block
//                 is also counted, so a dropped award shows up in the summary.
// A check that doesn't apply (no total stated, no prize blocks) says so and neither passes nor fails.
import { norm } from "./canon.ts";
import type { Entity, PageSnapshot } from "./schema.ts";

export interface CoverageCheck {
  name: "prize_total" | "prize_blocks" | "figures";
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
  const out = new Map<string, { heading: number; title: string; cash: number | null; winners: number | null }>();
  for (const b of s.blocks) {
    if (!b.anchor || !PRIZE_ANCHOR.test(b.anchor)) continue;
    if (b.heading && !out.has(b.anchor)) out.set(b.anchor, { heading: b.i, title: b.text, cash: null, winners: null });
    const p = out.get(b.anchor);
    if (!p || b.heading) continue;
    const cash = /^\$\s?([\d,]+) in cash$/i.exec(b.text);
    const won = /^(\d+) winners?$/i.exec(b.text);
    if (cash && p.cash === null) p.cash = Number(cash[1]!.replace(/,/g, ""));
    if (won && p.winners === null) p.winners = Number(won[1]);
  }
  return out;
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
    for (const e of entities) if (e.kind === "prize") prizesOn.set(String(e.fields.track_id?.value), (prizesOn.get(String(e.fields.track_id?.value)) ?? 0) + 1);
    const details: string[] = [];
    let withTrack = 0;
    let withPrize = 0;
    for (const [anchor, p] of blocks) {
      const t = trackByAnchor.get(anchor);
      if (!t) details.push(`${p.title} (${anchor}): no track`);
      else {
        withTrack++;
        if (prizesOn.get(t.id)) withPrize++;
        else details.push(`${p.title} (${anchor}): track has no prize`);
      }
    }
    const prizes = entities.filter((e) => e.kind === "prize").length;
    checks.push({
      name: "prize_blocks",
      pass: withTrack === blocks.size && withPrize === blocks.size,
      summary: `${blocks.size} prize blocks; ${withTrack} with a track, ${withPrize} with at least one prize; ${tracks.length} tracks and ${prizes} prizes extracted`,
      details,
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
