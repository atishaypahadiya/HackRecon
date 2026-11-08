// Idea fit (v2 D4, D6, D16, D23): a one-sentence project idea (and, optionally, its stack) → the sponsor tracks
// it most likely fits, each with a quote from that track's own canon that the fit rests on. Sonnet ranks;
// code checks every quote is in the track's card and every id is a track. Fit is a suggestion, never a
// guarantee. Event-level tracks (no sponsor tag, or listed in event.json `event_level_prizes`) aren't ranked:
// every project is judged for them.
import { createHash } from "node:crypto";
import type { EventConfig } from "./classify.ts";
import { norm } from "./canon.ts";
import type { Entity } from "./schema.ts";

export const FIT_MODEL = "claude-sonnet-5-5" as const;
export const FIT_EFFORT = "medium" as const;
export const FIT_MAX_TOKENS = 16000;
/** How many tracks a ranking returns; the eval scores the top 3. */
export const FIT_TOP = 5;

export function isEventLevel(track: Entity, e: EventConfig): boolean {
  return track.sponsor === "event" || (e.event_level_prizes ?? []).includes(track.name.value ?? "");
}

const glob = (pattern: string, s: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(s);
export const isToolGated = (name: string, e: EventConfig) => (e.tool_gated_prizes ?? []).some((p) => glob(p, name));

/**
 * Tiered evidence (user 2026-11-06), from what canon holds for the track, never from the model:
 *   stated     a requirement or judging-criterion sentence → the quote is one of them, plus a reason
 *   title      none, but the block says more than a prize amount → the title is the evidence ("requirements
 *              not stated"), and Plan asks the rep in Booths: "What does '<track>' reward?"
 *   cash_only  the block gives only "$X in cash" / "N winners" and the title names no sponsor product → title as
 *              evidence, ranked last, never "likely"
 * A requirement from any source upgrades the track: when step 1 merges Slack sponsor posts into canon as
 * requirements or criteria, title and cash_only tracks become stated with no change here.
 */
export const EVIDENCE = ["stated", "title", "cash_only"] as const;
/** Sponsor name → its aliases from sponsors.json ("Anthropic" → ["Claude"]): the product names a title may use. */
export type SponsorAliases = Record<string, string[]>;
export function sponsorAliases(sponsors: Record<string, { sponsor: string; aliases: string[] }>): SponsorAliases {
  const out: SponsorAliases = {};
  for (const s of Object.values(sponsors)) out[s.sponsor] = [...new Set([...(out[s.sponsor] ?? []), ...s.aliases])];
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive: "Fetch.ai" in "built on fetch.ai agents", not "Mana" in "manage". */
const hasWord = (text: string, w: string) => new RegExp(`(?<![a-z0-9])${esc(w)}(?![a-z0-9])`, "i").test(text);

/**
 * The sponsor products a track's title names (user 2026-11-06), in code: the X of "Use of (the) X" ("Gemini API",
 * "Factory Droid SDK", "x402"), and the sponsor's name or a sponsors.json alias anywhere in the title outside
 * "sponsored by …" ("Claude for Public Benefit" → Claude). "Best use of Reimagining Shopping sponsored by Visa"
 * names none: that X is no product of Visa's, and "sponsored by" credits a sponsor, not a product.
 */
export function titleProducts(name: string, sponsor: string, aliases: SponsorAliases = {}): string[] {
  const body = name.replace(/^\[[^\]]*\]\s*/, "");
  const credited = body.replace(/\bsponsored by\b.*$/i, "");
  const out: string[] = [];
  const m = /\buse of (?:the )?(.+?)(?=\s+(?:by|sponsored|on|for|in)\b|$)/i.exec(credited);
  const names = [sponsor, ...(aliases[sponsor] ?? [])].filter((n) => n && n !== "event");
  // "Use of X" names a product when X holds the sponsor's name, or is a proper name ("Gemini API", "Nessie",
  // "x402") that isn't a gerund phrase ("Reimagining Shopping").
  const x = m?.[1]?.trim();
  if (x && (names.some((n) => hasWord(x, n)) || (/^(?:[A-Z0-9]|[a-z]+\d)/.test(x) && !/^[A-Z][a-z]+ing\b/.test(x)))) out.push(x);
  for (const n of names) if (hasWord(credited, n) && !out.some((o) => hasWord(o, n))) out.push(n);
  return out;
}

/** Words a product name ends in that don't identify it: "Gemini API" is named by "Gemini", "Bitdeer AI Model Studio" by "Bitdeer". */
const GENERIC = /\s+(?:api|sdk|ai|model|studio|builder|agent|platform|cloud)$/i;
/** True when the user's idea or stack names the product: in full, or by its core without generic trailing words. */
export function productMentioned(product: string, text: string): boolean {
  let core = product;
  while (GENERIC.test(core)) core = core.replace(GENERIC, "");
  return hasWord(text, product) || (core.length >= 3 && hasWord(text, core));
}

/** A line that only restates a prize amount or winner count ("$5,000 in cash": Mana's whole award, Cal Hacks 13.0). */
const CASH_ONLY = /^(?:\$\s?[\d,]+(?:\.\d+)?\+?(?:\s+in cash)?|\d+ winners?)$/i;
export type Evidence = (typeof EVIDENCE)[number];

export interface TrackCard {
  id: string;
  sponsor: string;
  name: string;
  evidence: Evidence;
  /** Sponsor products the title names (titleProducts); a track with any is at least "title". */
  products: string[];
  /** What the ranker may quote on a stated track: its requirement and judging-criterion sentences only. */
  lines: string[];
  /** Shown to the ranker, never quotable: description sentences, entry steps, stacking rules, awards. */
  context: string[];
}

/** A sponsor track and everything canon says about it, split into quotable (requirements, criteria) and context. */
export function trackCards(entities: Entity[], e: EventConfig, aliases: SponsorAliases = {}): TrackCard[] {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const clean = (ls: (string | null)[]) => [...new Set(ls.filter((l): l is string => !!l).map(norm))];
  return entities
    .filter((t) => t.kind === "track" && !isEventLevel(t, e))
    .map((t) => {
      const field = (re: RegExp) => Object.entries(t.fields).filter(([k]) => re.test(k)).map(([, v]) => str(v.value));
      const of = (kind: string) => entities.filter((c) => c.kind === kind && c.fields.track_id?.value === t.id);
      const crit = of("criterion").flatMap((c) => [str(c.name.value), str(c.fields.description?.value)]);
      const lines = clean([...field(/^requirements\[/), ...crit]);
      const context = clean([...field(/^descriptions?(\[|$)/), ...of("entry_step").map((s) => str(s.fields.text?.value)), ...field(/^eligible_with$/), ...of("prize").map((p) => str(p.fields.award_text?.value))]).filter((l) => !lines.includes(l));
      const name = t.name.value ?? "";
      const products = titleProducts(name, t.sponsor, aliases);
      // A title that names a sponsor product is evidence whatever the prize block holds (user 2026-11-06).
      const evidence: Evidence = lines.length ? "stated" : products.length || context.some((l) => !CASH_ONLY.test(l)) ? "title" : "cash_only";
      return { id: t.id, sponsor: t.sponsor, name, evidence, products, lines, context };
    });
}

/** Phrases a fit reason may never use (user 2026-11-06): fit is a suggestion, never an eligibility claim. */
export const ELIGIBILITY = /\b(?:can|could|may) (?:still )?enter\b|\bqualif(?:y|ies|ied|ying)\b|\beligib(?:le|ility)\b|\bguarantee(?:d|s)?\b/i;

/** True when the quote is the track's name, or holds nothing beyond words of the name (user 2026-11-06). */
export function nameOnlyQuote(quote: string, name: string): boolean {
  const words = (s: string) => norm(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const nameWords = new Set(words(name));
  return words(quote).every((w) => nameWords.has(w));
}

export function fitSystemPrompt(e: EventConfig, cards: TrackCard[]): string {
  const body = cards
    .map((c) => `<track id="${c.id}" sponsor="${c.sponsor}" evidence="${c.evidence}">\n${c.name}${c.lines.map((l) => `\n- quotable: ${l}`).join("")}${c.context.map((l) => `\n- context: ${l}`).join("")}\n</track>`)
    .join("\n");
  return `You match a hackathon project idea to the sponsor tracks of ${e.event} it most likely fits. A hacker reads your answer to decide which tracks to enter, so rank by what each track says it wants and judges, as stated below, not by general popularity.

Return the ${FIT_TOP} best-fitting tracks, best first. For each: its id, fit ("likely" when the idea plainly meets what the track asks for, "possible" when it could with a small change), quote, and reason.

Each track's evidence attribute says what the page states about it:
- evidence="stated": quote a requirement or judging-criterion sentence copied exactly from one of its "quotable" lines, the one the fit rests on. Never just the track's name, never a "context" line.
- evidence="title": the page states no requirements, so the title is the only evidence. Quote the title exactly. Judge the fit from the title and the context lines.
- evidence="cash_only": the page gives only a prize amount. Quote the title exactly. Its fit is always "possible", never "likely".

reason: one sentence that combines only facts the hacker stated (their idea or stack) with the quoted line or title, phrased as a condition: "Your stack lists Apify; this track requires a project using Apify in a meaningful way." or "Your idea serves transfer students; this track is titled 'Claude for Public Benefit' and states no requirements." Don't guess how they would use a tool or what they built beyond what they wrote. Never say they can enter, qualify, are eligible or will win: whether a project counts is the judges' call.

When the hacker lists their stack, a track that asks for a tool they use is a strong signal; a track asking for a tool they don't use can still fit if the idea suits it.

<tracks count="${cards.length}">
${body}
</tracks>`;
}

export const FIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ranked"],
  properties: {
    ranked: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["track_id", "fit", "reason", "quote"],
        properties: { track_id: { type: "string" }, fit: { type: "string", enum: ["likely", "possible"] }, reason: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
} as const;

export interface Ranked {
  track_id: string;
  fit: "likely" | "possible";
  reason: string;
  quote: string;
}

/** `team`: each person's skills as told to Donna ("Priya: React, Figma"). Absent with no team, so a teamless request
 *  (and its cached ranking) is unchanged. */
export function fitRequest(idea: string, stack: string[] | null, team: string[] = []): string {
  const t = team.length
    ? `\n<team>What the hacker's team can do, as they told it (the hacker is "you"). Count these toward what a track asks for, as you would the stack; a reason may cite one, like "Priya lists React". They are skills, not things the project does yet.\n${team.join("\n")}</team>`
    : "";
  return `<idea>${idea}</idea>${stack?.length ? `\n<stack>${stack.join(", ")}</stack>` : ""}${t}`;
}

export function fitHash(system: string, request: string): string {
  return createHash("sha256").update(JSON.stringify([FIT_MODEL, FIT_EFFORT, FIT_SCHEMA, system, request])).digest("hex").slice(0, 16);
}

/** Every id is a sponsor track, no track twice; a stated track's quote is one of its requirement or criterion
 *  sentences and more than its name, any other track's quote is in its title; a cash_only track is never "likely";
 *  no reason uses eligibility language. A failure goes back to the model (callChecked). The result keeps the
 *  model's order with cash_only tracks moved last, so the eval scores the order Plan shows. */
export function checkFit(parsed: unknown, cards: TrackCard[], partial = false): Ranked[] | { error: string } {
  // partial: re-judging only some tracks (plan.ts), where any number can come back, none left out by the top-5 cut.
  const r = (parsed as { ranked?: Ranked[] })?.ranked;
  if (!Array.isArray(r) || (!r.length && !partial)) return { error: "missing ranked[]" };
  const byId = new Map(cards.map((c) => [c.id, c]));
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const x of r) {
    const c = byId.get(x.track_id);
    if (!c) {
      errors.push(`${x.track_id} is not a track id`);
      continue;
    }
    if (seen.has(x.track_id)) errors.push(`${x.track_id} is ranked twice`);
    seen.add(x.track_id);
    const q = norm(x.quote).toLowerCase();
    if (c.evidence !== "stated") {
      if (!q || !norm(c.name).toLowerCase().includes(q)) errors.push(`${c.name} states no requirements (evidence="${c.evidence}"): quote its title, not "${x.quote.slice(0, 80)}"`);
      if (c.evidence === "cash_only" && x.fit === "likely") errors.push(`${c.name} gives only a prize amount (evidence="cash_only"): fit must be "possible"`);
    } else if (!q || !c.lines.some((l) => norm(l).toLowerCase().includes(q))) errors.push(`quote "${x.quote.slice(0, 80)}" is not one of ${c.name}'s requirement or criterion lines`);
    else if (nameOnlyQuote(x.quote, c.name)) errors.push(`quote "${x.quote.slice(0, 80)}" is only ${c.name}'s name; quote a requirement or criterion`);
    const bad = ELIGIBILITY.exec(x.reason);
    if (bad) errors.push(`reason for ${c.name} says "${bad[0]}": state the condition, never eligibility`);
  }
  if (!partial && r.length < Math.min(FIT_TOP, cards.length)) errors.push(`ranked ${r.length} tracks, expected ${Math.min(FIT_TOP, cards.length)}`);
  if (errors.length) return { error: errors.join("; ") };
  const top = partial ? r : r.slice(0, FIT_TOP);
  const last = (x: Ranked) => (byId.get(x.track_id)!.evidence === "cash_only" ? 1 : 0);
  return top.map((x, i) => ({ x, i })).sort((a, b) => last(a.x) - last(b.x) || a.i - b.i).map(({ x }) => x);
}
