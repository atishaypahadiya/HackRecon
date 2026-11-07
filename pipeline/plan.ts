// Plan (v2, user 2026-11-06; design review D2–D13): the default tab. The user's one-line project and stack →
// a personal game plan whose every item carries a project-specific reason and a verified source quote.
// This module builds the Tracks section from idea fit (D4, D6): the same ranker, schema, quote check and
// cache as `hr fit-eval`, so the eval's numbers (recall@3/@5, the fit gate) describe what Plan shows.
// Rules (user, verbatim): "no suggestion without a verified source quote; never claims eligibility; updates
// live with 'new' markers; never sends anything." Fit words are "likely fits" / "possible", never "eligible".
import type Anthropic from "@anthropic-ai/sdk";
import type { EventConfig } from "./classify.ts";
import { checkFit, FIT_EFFORT, FIT_MAX_TOKENS, FIT_MODEL, FIT_SCHEMA, fitHash, fitRequest, fitSystemPrompt, productMentioned, trackCards, type Evidence, type Ranked, type SponsorAliases, type TrackCard } from "./fit.ts";
import { callChecked } from "./model.ts";
import type { Gap } from "./gaps.ts";
import type { Entity } from "./schema.ts";
import type { Usage } from "./usage.ts";

/** One stack item (user 2026-11-06). In the Plan input each item is a name field plus one optional short field,
 *  placeholder "what it does in your project". used_for is the user's own words, so Booths and the fit reason may
 *  state it as fact. */
export interface StackItem {
  name: string;
  used_for: string | null;
}

export interface PlanInput {
  idea: string;
  /** null when the user left it empty. */
  stack: StackItem[] | null;
  /** A public GitHub repo for the gap check; the ranker never sees it, so rankings keep their cache keys. */
  repo?: string | null;
}

/** What the ranker sees: the names, with "(used for: …)" only where the user gave one. A stack without any used_for
 *  renders exactly as a plain list, so the eval's Built With requests (names only) keep their cache keys. */
export const stackForRanker = (stack: StackItem[] | null): string[] | null => stack?.map((i) => (i.used_for ? `${i.name} (used for: ${i.used_for})` : i.name)) ?? null;

export interface PlanTrack {
  track_id: string;
  /** This track's entry steps: D3's checkboxes, shared with Ship. */
  steps: PlanStep[];
  name: string;
  sponsor: string;
  fit: "likely" | "possible";
  /** True when the ranker said "likely" and capLikely lowered it to "possible". */
  capped: boolean;
  reason: string;
  /** Tiered evidence (fit.ts): stated → a requirement or criterion sentence; title / cash_only → the title. */
  evidence: Evidence;
  /** What the user's words may name for this track: the title's products, the sponsor and its sponsors.json aliases. */
  product_names: string[];
  /** "requirements not stated" when the page states none (tiers title and cash_only); null on stated tracks. */
  label: string | null;
  /** Verified by checkFit against the track's requirement and criterion lines, or its title. */
  quote: string;
  source_url: string;
}

/** A question for a sponsor's rep (Booths section). Grounded in what the page leaves out, never invented. */
export interface BoothQuestion {
  track_id: string;
  sponsor: string;
  /** opening + "; " + ask. A sponsor's block says a shared opening once (boothBlocks). */
  question: string;
  opening: string;
  ask: string;
  /** Why it's asked, in what the page does or doesn't say. */
  grounds: string;
  source_url: string;
}

export const NOT_STATED = "requirements not stated";
const bare = (name: string) => name.replace(/^\[[^\]]*\]\s*/, "");

const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const unstop = (s: string) => s.replace(/[\s.!?;:,]+$/, "");

/** The project in the user's words: the description's first sentence, without a leading "<Name>:" label. */
export function projectLead(idea: string): string {
  const first = sentences(idea)[0] ?? idea;
  return unstop(first.replace(/^[^:\s][^:]{0,40}:\s+(?=\S)/, (m) => (m.trim().split(/\s+/).length <= 3 ? "" : m)));
}

/** A stack item naming one of the track's products, in the user's words: the entry when it is little more than
 *  the product ("Claude API" for Claude), else the product as the entry spells it ("Figma" from "UI designed in Figma"). */
export function stackProduct(names: string[], stack: StackItem[] | null): { phrase: string; entry: string; used_for: string | null } | null {
  for (const { name: entry, used_for } of stack ?? [])
    for (const n of names) {
      if (!productMentioned(n, entry)) continue;
      const short = entry.split(/\s+/).length <= n.split(/\s+/).length + 1;
      const at = entry.toLowerCase().indexOf(n.toLowerCase());
      return { phrase: short || at < 0 ? entry : entry.slice(at, at + n.length), entry, used_for };
    }
  return null;
}

const DETERMINER = /^(?:the|a|an|our|its|their|my|this|each|every|all)\b/i;
/** A used_for as a clause after "We use X": kept when it starts with "to"/"for"; "for" before a noun phrase ("the Ask
 *  assistant", a capitalized name, an -ing word), else "to" before a verb phrase ("pull course catalogs"). */
export function useClause(usedFor: string): string {
  const u = unstop(usedFor.trim());
  if (/^(?:to|for)\s/i.test(u)) return u;
  const first = u.split(/\s+/)[0] ?? "";
  return DETERMINER.test(u) || /^[A-Z]/.test(first) || /ing$/i.test(first) ? `for ${u}` : `to ${u}`;
}

const PARTICIPLE = "(?:\\w+ed|built|made|written|drawn|done|run|hosted)";
/**
 * A stack entry that already says its use (user 2026-11-06): "<thing> <past participle> in|with|on|using <product>"
 * → "We <participle> the <thing> <prep> <product>". "UI designed in Figma" → "We designed the UI in Figma";
 * "frontend built with React" → "We built the frontend with React". Null for a bare name ("web app on Vercel" has
 * no participle), so nothing is read into it.
 */
export function entryUse(entry: string, product: string): string | null {
  const m = new RegExp(`^(.+?)\\s+(${PARTICIPLE})\\s+(in|with|on|using|via)\\s+(.+)$`, "i").exec(unstop(entry.trim()));
  if (!m || !productMentioned(product, m[4]!)) return null;
  const thing = DETERMINER.test(m[1]!) ? m[1]! : `the ${m[1]!}`;
  return `We ${m[2]!.toLowerCase()} ${thing} ${m[3]!.toLowerCase()} ${m[4]!}`;
}

/** What the description itself says the product does: "uses Apify to scrape course catalogs" → "to scrape course
 *  catalogs". Null when it says nothing, so the question never states a use the user didn't write. */
export function statedUse(names: string[], idea: string): string | null {
  for (const s of sentences(idea))
    for (const n of names) {
      const m = new RegExp(`(?<![a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])(?:\\s+\\w+){0,2}?\\s+((?:to|for)\\s+[^.;!?]+)`, "i").exec(s);
      if (m) return unstop(m[1]!);
    }
  return null;
}

/**
 * Booths (user 2026-11-06), built in code from the plan item; no model call. Facts come only from the user's
 * description and stack, and the page:
 *   "We use <stack product> <use>; does that count as '<quoted requirement>'?"     (stated tracks)
 *   "We use <stack product> <use>; what does '<track title>' reward beyond that?"  (title-only tracks)
 * <use>, in order: the item's used_for ("We use Apify to pull course catalogs"); the description's own "to/for …"
 * clause about the product; a stack entry that already says its use, which replaces the opening ("We designed the
 * UI in Figma; …"); else "for <the project>" (the description's first sentence), which says only that the product
 * is used in this project. A title-only track whose
 * products the user doesn't name gets the plain "What does '<track>' reward?"; a stated track without one gets no
 * question (its requirement is already on the page). cash_only tracks get none.
 */
export function boothQuestions(tracks: PlanTrack[], input: PlanInput, gaps: Gap[] = []): BoothQuestion[] {
  const lead = projectLead(input.idea);
  const out: BoothQuestion[] = [];
  const q = (base: Pick<BoothQuestion, "track_id" | "sponsor" | "source_url">, opening: string, ask: string, grounds: string): BoothQuestion => ({ ...base, opening, ask, question: `${opening}; ${ask}`, grounds });
  for (const t of tracks) {
    if (t.evidence === "cash_only") continue;
    // A gap (user 2026-11-06): the question names what the project does instead, from the checked gap, and asks
    // what the requirement needs. Both sides are already verified quotes; this only words them.
    const gap = gaps.find((g) => g.track_id === t.track_id);
    if (gap) {
      const from = gap.project.map((p) => `${p.source} “${unstop(p.quote)}”`).join("; ");
      const ask = gap.question.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
      out.push(q({ track_id: t.track_id, sponsor: t.sponsor, source_url: t.source_url }, `We ${gap.instead}`, ask, `the gap check: ${from}; the page's ${gap.requirement.kind === "entry_step" ? "entry step" : "requirement"} “${unstop(gap.requirement.quote)}”`));
      continue;
    }
    const sp = stackProduct(t.product_names, input.stack);
    const named = sp ? null : t.product_names.find((n) => productMentioned(n, input.idea));
    const product = sp?.phrase ?? named;
    const base = { track_id: t.track_id, sponsor: t.sponsor, source_url: t.source_url };
    const page = t.evidence === "stated" ? `the page's requirement “${unstop(t.quote)}”` : `Devpost states no requirements or judging criteria for ${t.name}`;
    if (!product) {
      if (t.evidence === "title") out.push({ ...base, opening: "", ask: `What does ‘${bare(t.name)}’ reward?`, question: `What does ‘${bare(t.name)}’ reward?`, grounds: page });
      continue;
    }
    const ask = t.evidence === "stated" ? `does that count as ‘${unstop(t.quote)}’?` : `what does ‘${bare(t.name)}’ reward beyond that?`;
    const said = sp ? `your stack lists “${sp.entry}”` : `your description names ${product}`;
    const described = statedUse(t.product_names, input.idea);
    const inEntry = sp && !sp.used_for && !described ? entryUse(sp.entry, product) : null;
    const [opening, why] = sp?.used_for
      ? [`We use ${product} ${useClause(sp.used_for)}`, `${said}, used for “${unstop(sp.used_for)}”`]
      : described
        ? [`We use ${product} ${described}`, `${said}; your description says “${described}”`]
        : inEntry
          ? [inEntry, said]
          : [`We use ${product} for ${lead}`, `${said}; your description: “${lead}”`];
    out.push(q(base, opening, ask, `${why}; ${page}`));
  }
  return out;
}

/** One block per sponsor (user 2026-11-06), in first-appearance order. Questions with the same opening share it:
 *  "We use Apify to …; does that count as ‘…’, and what does ‘Best Use of Apify’ reward beyond that?". The text is
 *  what Copy copies; `lines` holds its sentences, one question per line on the board. */
export interface BoothBlock {
  sponsor: string;
  text: string;
  lines: string[];
  questions: BoothQuestion[];
}

export function boothBlocks(questions: BoothQuestion[]): BoothBlock[] {
  const sponsors = [...new Set(questions.map((x) => x.sponsor))];
  return sponsors.map((sponsor) => {
    const qs = questions.filter((x) => x.sponsor === sponsor);
    const openings = [...new Set(qs.map((x) => x.opening))];
    const sentences = openings.map((o) => {
      const asks = qs.filter((x) => x.opening === o).map((x) => x.ask);
      const joined = asks.map((a, k) => (k ? a.replace(/^What /, "what ") : a)).map((a, k) => (k < asks.length - 1 ? a.replace(/\?$/, "") : a)).join(", and ");
      return o ? `${o}; ${joined}` : joined;
    });
    return { sponsor, text: sentences.join(" "), lines: sentences, questions: qs };
  });
}

export interface PlanSection<T> {
  items: T[];
  /** "cache" when the same idea and stack were ranked before (D4: cached results show instantly). */
  from: "cache" | "model";
  ms: number;
  usage: Usage | null;
}

export type FitCache = Record<string, { ranked: Ranked[]; usage: Usage; calls: number }>;

/** One canon entry_step (user 2026-11-06): a Plan checkbox under its track (D3) and a line of Ship's checklist.
 *  Both read this one list, keyed by entity id, so checking it in one view checks it in the other (P5). */
export interface PlanStep {
  id: string;
  track_id: string;
  track: string;
  step_kind: string;
  label: string;
  /** The page's sentence, verbatim; checked against the snapshot block at extraction (checkCanon). */
  quote: string;
  source_url: string;
}

/** Entry steps for the given tracks, in plan order, then the page's order within a track. */
export function entrySteps(entities: Entity[], trackIds: string[]): PlanStep[] {
  const byId = new Map(entities.map((x) => [x.id, x]));
  return trackIds.flatMap((tid) =>
    entities
      .filter((s) => s.kind === "entry_step" && s.fields.track_id?.value === tid)
      .sort((a, b) => (a.fields.text?.source.block ?? 0) - (b.fields.text?.source.block ?? 0))
      .map((s) => ({
        id: s.id,
        track_id: tid,
        track: byId.get(tid)?.name.value ?? "",
        step_kind: String(s.fields.step_kind?.value ?? ""),
        label: s.name.value ?? "",
        quote: s.fields.text?.source.quote ?? "",
        source_url: s.fields.text?.source.url ?? s.name.source.url,
      })),
  );
}

/** "Apify: pull course catalogs, Claude API: the Ask assistant, Vercel" → items; "name: used for" splits at the
 *  first ": " (colon and space), so "ASI:One" stays one name. Commas can't appear inside a used_for in this form. */
export function parseStack(s: string | undefined | null): StackItem[] | null {
  const items = (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x): StackItem => {
      const at = x.indexOf(": ");
      const used = at > 0 ? x.slice(at + 2).trim() : "";
      return used ? { name: x.slice(0, at).trim(), used_for: used } : { name: at > 0 ? x.slice(0, at).trim() : x, used_for: null };
    });
  return items.length ? items : null;
}

/**
 * The label rule (user 2026-11-06), applied after ranking, in code: a title-tier track keeps "likely" only when a
 * product its title names appears in the user's idea or stack ("Best Use of Claude" and a stack listing the Claude
 * API); otherwise it shows as "possible". Ranking order and the eval are untouched: recall reads checkFit's list.
 */
export function capLikely(r: Ranked, card: TrackCard | undefined, input: PlanInput): { fit: Ranked["fit"]; capped: boolean } {
  if (r.fit !== "likely" || card?.evidence !== "title") return { fit: r.fit, capped: false };
  const text = [input.idea, ...(input.stack ?? []).map((i) => i.name)].join("\n");
  return card.products.some((p) => productMentioned(p, text)) ? { fit: "likely", capped: false } : { fit: "possible", capped: true };
}

/** Tracks to target. Likely fits first, then possible (D12), each in checkFit's order (cash_only last). */
export async function planTracks(client: Anthropic | null, input: PlanInput, entities: Entity[], e: EventConfig, cache: FitCache, aliases: SponsorAliases = {}, now = () => performance.now()): Promise<PlanSection<PlanTrack> | { error: string }> {
  const t0 = now();
  const cards = trackCards(entities, e, aliases);
  const system = fitSystemPrompt(e, cards);
  const request = fitRequest(input.idea, stackForRanker(input.stack));
  const hash = fitHash(system, request);
  let ranked = cache[hash]?.ranked;
  let usage: Usage | null = null;
  const from = ranked ? "cache" : "model";
  if (!ranked) {
    if (!client) return { error: "no API key, and this idea hasn't been ranked before" };
    const r = await callChecked(client, { model: FIT_MODEL, effort: FIT_EFFORT, max_tokens: FIT_MAX_TOKENS, system, schema: FIT_SCHEMA, request, check: (p) => checkFit(p, cards) });
    if ("error" in r) return { error: r.error };
    ranked = r.value;
    usage = r.usage;
    cache[hash] = { ranked, usage: r.usage, calls: r.calls };
  }
  const byId = new Map(entities.map((x) => [x.id, x]));
  const cardOf = new Map(cards.map((c) => [c.id, c]));
  const items = ranked.map((r): PlanTrack => {
    const t = byId.get(r.track_id)!;
    const card = cardOf.get(r.track_id);
    const evidence = card?.evidence ?? "cash_only";
    const { fit, capped } = capLikely(r, card, input);
    const product_names = [...new Set([...(card?.products ?? []), t.sponsor, ...(aliases[t.sponsor] ?? [])])].filter((n) => n && n !== "event");
    return { track_id: r.track_id, steps: entrySteps(entities, [r.track_id]), name: t.name.value ?? "", sponsor: t.sponsor, fit, capped, product_names, reason: r.reason, evidence, label: evidence === "stated" ? null : NOT_STATED, quote: r.quote, source_url: t.name.source.url };
  });
  items.sort((a, b) => (a.fit === b.fit ? 0 : a.fit === "likely" ? -1 : 1));
  return { items, from, ms: Math.round(now() - t0), usage };
}

// ---- the board's Plan tab (P1): request validation, the before-you-type summary, a track's drawer ----

export const PLAN_LIMITS = { idea: 2000, items: 20, name: 80, used_for: 160 } as const;

/** POST /plan's body → PlanInput, or why not. Lengths are capped so one request stays one ranking. */
export function parsePlanBody(body: unknown): PlanInput | { error: string } {
  const b = body as { idea?: unknown; stack?: unknown; repo?: unknown };
  const idea = typeof b?.idea === "string" ? b.idea.trim() : "";
  if (!idea) return { error: "describe your project first" };
  if (idea.length > PLAN_LIMITS.idea) return { error: `the description is over ${PLAN_LIMITS.idea} characters` };
  if (b.stack !== undefined && b.stack !== null && !Array.isArray(b.stack)) return { error: "stack must be a list" };
  const raw = (b.stack ?? []) as unknown[];
  if (raw.length > PLAN_LIMITS.items) return { error: `the stack has over ${PLAN_LIMITS.items} items` };
  const stack: StackItem[] = [];
  for (const x of raw) {
    const it = x as { name?: unknown; used_for?: unknown };
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    const used = typeof it?.used_for === "string" ? it.used_for.trim() : "";
    if (!name) continue;
    if (name.length > PLAN_LIMITS.name || used.length > PLAN_LIMITS.used_for) return { error: `a stack item is over ${PLAN_LIMITS.name} characters, or its use over ${PLAN_LIMITS.used_for}` };
    stack.push({ name, used_for: used || null });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  if (repo && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/.test(repo)) return { error: "the repo link must be a public https://github.com/<owner>/<repo> link" };
  return { idea, stack: stack.length ? stack : null, ...(repo ? { repo } : {}) };
}

export interface PlanDeadline {
  id: string;
  name: string;
  /** ISO 8601 with offset, as canon verified it against its quote. */
  at: string;
  quote: string;
  url: string;
}

/** What Plan knows before the user types: the track count ("52 tracks on Devpost"), and the times the Next for you
 *  line can show. Times are the event config's schedule items that nothing supersedes (Slack-sourced, so they carry
 *  Cal Hacks' 9:30 extension); canon's deadlines only when there is no schedule. Merging the two with the D13 merge
 *  line is Ship's (P9). */
export interface PlanMeta {
  event: string;
  timezone: string;
  track_count: number;
  devpost_url: string | null;
  as_of: string | null;
  hacking_start: string | null;
  deadlines: PlanDeadline[];
}

export function planMeta(entities: Entity[], e: EventConfig): PlanMeta {
  const tracks = entities.filter((x) => x.kind === "track");
  const captured = entities.map((x) => x.name.source.captured_at).filter(Boolean).sort();
  const schedule = (e.schedule ?? []).filter((x) => !x.superseded_by && x.at).map((x, k) => ({ id: `schedule:${k}`, name: x.what, at: x.at, quote: x.what, url: x.source ?? "" }));
  const canon = entities
    .filter((x) => x.kind === "rule" && typeof x.fields.deadline?.value === "string")
    .map((x) => ({ id: x.id, name: x.name.value ?? "", at: String(x.fields.deadline!.value), quote: x.fields.deadline!.source.quote, url: x.fields.deadline!.source.url }));
  const deadlines = (schedule.length ? schedule : canon).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { event: e.event, timezone: e.timezone, track_count: tracks.length, devpost_url: tracks[0]?.name.source.url ?? null, as_of: captured.at(-1) ?? null, hacking_start: e.hacking_start, deadlines };
}

/** Everything canon says about one track, for its drawer: requirements, judging criteria, the rest of the block's
 *  text, and its prizes. Verbatim values; each list may be empty. */
export interface TrackDetail {
  requirements: string[];
  criteria: { name: string; description: string | null }[];
  descriptions: string[];
  prizes: { place: string | null; award: string }[];
}

export function trackDetail(entities: Entity[], trackId: string): TrackDetail {
  const t = entities.find((x) => x.id === trackId);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const field = (re: RegExp) => Object.entries(t?.fields ?? {}).filter(([k]) => re.test(k)).map(([, v]) => str(v.value)).filter((v): v is string => !!v);
  const of = (kind: string) => entities.filter((x) => x.kind === kind && x.fields.track_id?.value === trackId);
  return {
    requirements: field(/^requirements\[/),
    criteria: of("criterion").map((c) => ({ name: c.name.value ?? "", description: str(c.fields.description?.value) })),
    descriptions: field(/^descriptions?(\[|$)/),
    prizes: of("prize").map((p) => ({ place: str(p.fields.place?.value), award: str(p.fields.award_text?.value) ?? "" })),
  };
}
