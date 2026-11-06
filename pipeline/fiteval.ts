// The idea-fit eval (v2 D16, D23, T7): Cal Hacks 13.0's public winners as labels. Each project's won sponsor
// tracks are the targets; the ranker sees only the project's one-line description (run A) or the description
// plus its public Built With list (run B). Pure scoring here; `hr fit-eval` runs the model.
import type { EventConfig } from "./classify.ts";
import { isToolGated, type Ranked, type TrackCard } from "./fit.ts";

export interface EvalItem {
  slug: string;
  url: string;
  description: string;
  built_with: string[] | null;
  /** Prize titles won, as Devpost lists them. */
  won: string[];
}

export const BEST_USE = /\bbest use of\b/i;

export interface Rate {
  hits: number;
  n: number;
}
const rate = (hits: number, n: number): Rate => ({ hits, n });
export const pct = (r: Rate) => (r.n ? (100 * r.hits) / r.n : 0);
export const fmt = (r: Rate) => `${pct(r).toFixed(1)}% (${r.hits}/${r.n})`;

export interface FitReport {
  pairs: number;
  projects: number;
  recall3: { A: Rate; B: Rate };
  best_use: { A: Rate; B: Rate; prizes: number };
  any_hit: { A: Rate; B: Rate };
  per_prize: { prize: string; tool_gated: boolean; A: Rate; B: Rate }[];
  /** Points of recall@3, B − A. */
  gap: { all: number; best_use: number };
  asks_for_stack: boolean;
  rule: string;
  event_level: { project: string; prize: string }[];
  unmatched: { project: string; prize: string }[];
  /** Projects whose run failed (no ranking after retries), per run: counted as misses. */
  failed: { A: string[]; B: string[] };
}

/** Rankings by project slug for runs A and B; a missing ranking counts every pair of that project as a miss. */
export function scoreFit(items: EvalItem[], cards: TrackCard[], allTrackNames: Set<string>, e: EventConfig, A: Map<string, Ranked[]>, B: Map<string, Ranked[]>): FitReport {
  const byName = new Map(cards.map((c) => [c.name, c]));
  const event_level: FitReport["event_level"] = [];
  const unmatched: FitReport["unmatched"] = [];
  const pairs: { slug: string; prize: string; id: string }[] = [];
  for (const it of items)
    for (const prize of it.won) {
      const c = byName.get(prize);
      if (c) pairs.push({ slug: it.slug, prize, id: c.id });
      else if (allTrackNames.has(prize)) event_level.push({ project: it.slug, prize });
      else unmatched.push({ project: it.slug, prize });
    }
  const top3 = (run: Map<string, Ranked[]>, slug: string) => new Set((run.get(slug) ?? []).slice(0, 3).map((r) => r.track_id));
  const hit = (run: Map<string, Ranked[]>, p: (typeof pairs)[number]) => top3(run, p.slug).has(p.id);
  const count = (run: Map<string, Ranked[]>, ps: typeof pairs) => rate(ps.filter((p) => hit(run, p)).length, ps.length);
  const best = pairs.filter((p) => BEST_USE.test(p.prize));
  const slugs = [...new Set(pairs.map((p) => p.slug))];
  const anyHit = (run: Map<string, Ranked[]>) => rate(slugs.filter((s) => pairs.some((p) => p.slug === s && hit(run, p))).length, slugs.length);
  const prizes = [...new Set(best.map((p) => p.prize))].sort();
  const recall3 = { A: count(A, pairs), B: count(B, pairs) };
  const best_use = { A: count(A, best), B: count(B, best), prizes: prizes.length };
  const gap = { all: pct(recall3.B) - pct(recall3.A), best_use: pct(best_use.B) - pct(best_use.A) };
  // User rule (2026-11-06): ask for the stack if B beats A by >= 10 points overall or >= 20 pooled on "Best Use of X".
  const asks_for_stack = gap.all >= 10 || gap.best_use >= 20;
  const rule = gap.all >= 10 ? `B − A = ${gap.all.toFixed(1)} points over ${pairs.length} pairs (≥ 10)` : gap.best_use >= 20 ? `B − A = ${gap.best_use.toFixed(1)} points over ${best.length} "Best Use of X" pairs (≥ 20)` : `neither gap reaches its bar (${gap.all.toFixed(1)} < 10 overall, ${gap.best_use.toFixed(1)} < 20 on "Best Use of X")`;
  return {
    pairs: pairs.length,
    projects: slugs.length,
    recall3,
    best_use,
    any_hit: { A: anyHit(A), B: anyHit(B) },
    per_prize: prizes.map((prize) => {
      const ps = best.filter((p) => p.prize === prize);
      return { prize, tool_gated: isToolGated(prize, e), A: count(A, ps), B: count(B, ps) };
    }),
    gap,
    asks_for_stack,
    rule,
    event_level,
    unmatched,
    failed: { A: slugs.filter((s) => !A.has(s)), B: slugs.filter((s) => !B.has(s)) },
  };
}

export function formatFitReport(r: FitReport): string {
  const L = [
    `Idea fit, Cal Hacks 13.0 winners (labels: won sponsor tracks, public Devpost). Agreement with Devpost outcomes, not accuracy.`,
    ``,
    `recall@3 over (project, won sponsor track) pairs`,
    `  run A (description only)            ${fmt(r.recall3.A)}   ← headline`,
    `  run B (description + Built With)    ${fmt(r.recall3.B)}`,
    `  "Best Use of X" pairs (${r.best_use.prizes} prizes)  A ${fmt(r.best_use.A)}   B ${fmt(r.best_use.B)}`,
    `any-hit per project (a won track in the top 3)  A ${fmt(r.any_hit.A)}   B ${fmt(r.any_hit.B)}`,
    ``,
    `Stack question: ${r.asks_for_stack ? "Build ASKS for the stack" : "Build asks only for the idea"}: ${r.rule}.`,
    ``,
    `Per "Best Use of X" prize (A, B; n = pairs)`,
    ...r.per_prize.map((p) => `  ${p.prize.padEnd(62)} ${String(p.A.hits).padStart(2)}/${p.A.n}  ${String(p.B.hits).padStart(2)}/${p.B.n}${p.tool_gated ? "  tool_gated" : ""}`),
    ``,
    `Event-level wins, not scored (${r.event_level.length}): ${r.event_level.map((x) => `${x.prize} (${x.project})`).join("; ") || "none"}`,
  ];
  if (r.unmatched.length) L.push(`Won prizes with no track in canon (${r.unmatched.length}): ${r.unmatched.map((x) => `${x.prize} (${x.project})`).join("; ")}`);
  if (r.failed.A.length || r.failed.B.length) L.push(`Failed rankings, counted as misses: A ${r.failed.A.join(", ") || "none"}; B ${r.failed.B.join(", ") || "none"}`);
  return L.join("\n");
}
