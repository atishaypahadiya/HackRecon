// Plan (v2, user 2026-11-06; design review D2–D13): the default tab. The user's one-line project and stack →
// a personal game plan whose every item carries a project-specific reason and a verified source quote.
// This module builds the Tracks section from idea fit (D4, D6): the same ranker, schema, quote check and
// cache as `hr fit-eval`, so the eval's numbers (recall@3/@5, the fit gate) describe what Plan shows.
// Rules (user, verbatim): "no suggestion without a verified source quote; never claims eligibility; updates
// live with 'new' markers; never sends anything." Fit words are "likely fits" / "possible", never "eligible".
import type Anthropic from "@anthropic-ai/sdk";
import type { EventConfig } from "./classify.ts";
import { checkFit, FIT_EFFORT, FIT_MAX_TOKENS, FIT_MODEL, FIT_SCHEMA, fitHash, fitRequest, fitSystemPrompt, trackCards, type Ranked } from "./fit.ts";
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
  name: string;
  sponsor: string;
  fit: "likely" | "possible";
  reason: string;
  /** Verified to appear in the track's own canon lines (checkFit). */
  quote: string;
  source_url: string;
}

export interface PlanSection<T> {
  items: T[];
  /** "cache" when the same idea and stack were ranked before (D4: cached results show instantly). */
  from: "cache" | "model";
  ms: number;
  usage: Usage | null;
}

export type FitCache = Record<string, { ranked: Ranked[]; usage: Usage; calls: number }>;

export function parseStack(s: string | undefined | null): string[] | null {
  const parts = (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/** Tracks to target. Likely fits first, then possible (D12), each in the ranker's order. */
export async function planTracks(client: Anthropic | null, input: PlanInput, entities: Entity[], e: EventConfig, cache: FitCache, now = () => performance.now()): Promise<PlanSection<PlanTrack> | { error: string }> {
  const t0 = now();
  const cards = trackCards(entities, e);
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
  const items = ranked.map((r): PlanTrack => {
    const t = byId.get(r.track_id)!;
    return { track_id: r.track_id, name: t.name.value ?? "", sponsor: t.sponsor, fit: r.fit, reason: r.reason, quote: r.quote, source_url: t.name.source.url };
  });
  items.sort((a, b) => (a.fit === b.fit ? 0 : a.fit === "likely" ? -1 : 1));
  return { items, from, ms: Math.round(now() - t0), usage };
}
