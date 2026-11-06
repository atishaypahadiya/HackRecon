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
import type { Entity } from "./schema.ts";
import type { Usage } from "./usage.ts";

export interface PlanInput {
  idea: string;
  /** Comma-separated in the UI; null when the user left it empty. */
  stack: string[] | null;
}

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
  question: string;
  /** Why it's asked, in what the page does or doesn't say. */
  grounds: string;
  source_url: string;
}

export const NOT_STATED = "requirements not stated";
const bare = (name: string) => name.replace(/^\[[^\]]*\]\s*/, "");

/** Booths (user 2026-11-06): each title-tier track in the plan → "What does '<track>' reward?" for its rep. */
export function boothQuestions(tracks: PlanTrack[]): BoothQuestion[] {
  return tracks
    .filter((t) => t.evidence === "title")
    .map((t) => ({ track_id: t.track_id, sponsor: t.sponsor, question: `What does ‘${bare(t.name)}’ reward?`, grounds: `Devpost states no requirements or judging criteria for ${t.name}`, source_url: t.source_url }));
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

export function parseStack(s: string | undefined | null): string[] | null {
  const parts = (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * The label rule (user 2026-11-06), applied after ranking, in code: a title-tier track keeps "likely" only when a
 * product its title names appears in the user's idea or stack ("Best Use of Claude" and a stack listing the Claude
 * API); otherwise it shows as "possible". Ranking order and the eval are untouched: recall reads checkFit's list.
 */
export function capLikely(r: Ranked, card: TrackCard | undefined, input: PlanInput): { fit: Ranked["fit"]; capped: boolean } {
  if (r.fit !== "likely" || card?.evidence !== "title") return { fit: r.fit, capped: false };
  const text = [input.idea, ...(input.stack ?? [])].join("\n");
  return card.products.some((p) => productMentioned(p, text)) ? { fit: "likely", capped: false } : { fit: "possible", capped: true };
}

/** Tracks to target. Likely fits first, then possible (D12), each in checkFit's order (cash_only last). */
export async function planTracks(client: Anthropic | null, input: PlanInput, entities: Entity[], e: EventConfig, cache: FitCache, aliases: SponsorAliases = {}, now = () => performance.now()): Promise<PlanSection<PlanTrack> | { error: string }> {
  const t0 = now();
  const cards = trackCards(entities, e, aliases);
  const system = fitSystemPrompt(e, cards);
  const request = fitRequest(input.idea, input.stack);
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
    return { track_id: r.track_id, steps: entrySteps(entities, [r.track_id]), name: t.name.value ?? "", sponsor: t.sponsor, fit, capped, reason: r.reason, evidence, label: evidence === "stated" ? null : NOT_STATED, quote: r.quote, source_url: t.name.source.url };
  });
  items.sort((a, b) => (a.fit === b.fit ? 0 : a.fit === "likely" ? -1 : 1));
  return { items, from, ms: Math.round(now() - t0), usage };
}
