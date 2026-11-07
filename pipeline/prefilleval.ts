// P1b's eval (user 2026-11-06): Cal Hacks 13.0's winners with a public GitHub repo. (a) How much of each project's
// Devpost Built With list the repo-drafted stack recovers. (b) Fit recall@3 and @5 with the drafted stack in place
// of Built With (run C), paired against the baseline's run B on the same pairs. Pure scoring; `hr prefill-eval` runs it.
import { fmt, mcnemarExact, type PairHit, type Rate } from "./fiteval.ts";
import { productOf, type Product } from "./prefill.ts";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim().split(" ").filter(Boolean);
const compact = (s: string) => words(s).join("");

/** How a Built With tag matches a drafted name. "same": equal once case, spaces and punctuation are dropped
 *  ("Next.js" = "nextjs"). "contains": every word of the shorter is a word of the longer ("claude" in "Claude API"),
 *  shorter side at least 3 characters. Anything else ("anthropic" vs "Claude API") is a miss: no alias table. */
export function tagMatch(tag: string, name: string): "same" | "contains" | null {
  const a = compact(tag);
  const b = compact(name);
  if (!a || !b) return null;
  if (a === b) return "same";
  const [s, l] = words(tag).length <= words(name).length ? [words(tag), words(name)] : [words(name), words(tag)];
  return s.join("").length >= 3 && s.every((w) => l.includes(w)) ? "contains" : null;
}

export interface BuiltWithScore {
  slug: string;
  built_with: string[];
  drafted: string[];
  same: string[];
  contains: string[];
  /** Matched only through the sponsor-product alias table ("anthropic" ↔ "Claude API"). */
  alias: string[];
  missed: string[];
  /** Drafted items matching no Built With tag: not errors (Built With lists are partial), shown for reading. */
  extra: string[];
}

export function scoreBuiltWith(slug: string, builtWith: string[], drafted: string[], products: Product[] = []): BuiltWithScore {
  const same: string[] = [];
  const contains: string[] = [];
  const alias: string[] = [];
  const missed: string[] = [];
  const draftedProducts = new Set(drafted.map((d) => productOf(d, products)).filter(Boolean));
  const viaAlias = (t: string) => {
    const p = productOf(t, products);
    return !!p && draftedProducts.has(p);
  };
  for (const t of builtWith) {
    const m = drafted.map((d) => tagMatch(t, d));
    if (m.includes("same")) same.push(t);
    else if (m.includes("contains")) contains.push(t);
    else if (viaAlias(t)) alias.push(t);
    else missed.push(t);
  }
  const extra = drafted.filter((d) => !builtWith.some((t) => tagMatch(t, d) || (productOf(d, products) && productOf(d, products) === productOf(t, products))));
  return { slug, built_with: builtWith, drafted, same, contains, alias, missed, extra };
}

export interface BuiltWithReport {
  projects: number;
  tags: number;
  /** Pooled over all tags: strict counts "same" only, loose adds "contains". */
  strict: Rate;
  loose: Rate;
  /** Loose plus the sponsor-product alias table. */
  aliased: Rate;
  /** Mean of per-project loose recall (each project weighs the same). */
  mean_project_loose: number;
}

export function builtWithReport(scores: BuiltWithScore[]): BuiltWithReport {
  const withTags = scores.filter((s) => s.built_with.length);
  const tags = withTags.reduce((n, s) => n + s.built_with.length, 0);
  const same = withTags.reduce((n, s) => n + s.same.length, 0);
  const loose = same + withTags.reduce((n, s) => n + s.contains.length, 0);
  const aliased = loose + withTags.reduce((n, s) => n + s.alias.length, 0);
  const mean = withTags.length ? withTags.reduce((t, s) => t + (s.same.length + s.contains.length) / s.built_with.length, 0) / withTags.length : 0;
  return { projects: withTags.length, tags, strict: { hits: same, n: tags }, loose: { hits: loose, n: tags }, aliased: { hits: aliased, n: tags }, mean_project_loose: 100 * mean };
}

export interface PairedVsB {
  k: 3 | 5;
  /** The baseline's run B on exactly these pairs. */
  B: Rate;
  C: Rate;
  /** B hit → C miss, and C hit → B miss. */
  lost: number;
  gained: number;
  p: number;
  /** C − B in points with its 95% interval (pairedDiffCI). */
  diff: { est: number; lo: number; hi: number };
}

/** 95% interval for a paired difference in proportions, C − B, from the discordant counts: Agresti–Min (2005), the
 *  Wald interval after adding ½ to each of the four cells, which keeps its coverage near 95% at small counts.
 *  In percentage points; est is the plain (gained − lost) / n. */
export function pairedDiffCI(lost: number, gained: number, n: number): { est: number; lo: number; hi: number } {
  if (!n) return { est: 0, lo: 0, hi: 0 };
  const b = lost + 0.5;
  const c = gained + 0.5;
  const m = n + 2;
  const d = (c - b) / m;
  const se = Math.sqrt(Math.max(0, b + c - (c - b) ** 2 / m)) / m;
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  return { est: (100 * (gained - lost)) / n, lo: 100 * clamp(d - 1.96 * se), hi: 100 * clamp(d + 1.96 * se) };
}

/** Run C's hits per pair key against the baseline's B on the same keys (keys absent from the baseline are skipped
 *  and counted). */
export function pairedVsBaseline(baseline: PairHit[], C: Map<string, { C3: boolean; C5: boolean }>): { paired: PairedVsB[]; pairs: number; not_in_baseline: string[] } {
  const base = new Map(baseline.map((p) => [p.key, p]));
  const keys = [...C.keys()].filter((k) => base.has(k));
  const paired = ([3, 5] as const).map((k) => {
    const b = (key: string) => (k === 3 ? base.get(key)!.B3 : base.get(key)!.B5);
    const c = (key: string) => (k === 3 ? C.get(key)!.C3 : C.get(key)!.C5);
    const lost = keys.filter((x) => b(x) && !c(x)).length;
    const gained = keys.filter((x) => !b(x) && c(x)).length;
    return { k, B: { hits: keys.filter(b).length, n: keys.length }, C: { hits: keys.filter(c).length, n: keys.length }, lost, gained, p: mcnemarExact(lost, gained), diff: pairedDiffCI(lost, gained, keys.length) };
  });
  return { paired, pairs: keys.length, not_in_baseline: [...C.keys()].filter((k) => !base.has(k)) };
}

const pts = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
export const formatPaired = (r: PairedVsB, run = "C") => `recall@${r.k}: B ${fmt(r.B)} → ${run} ${fmt(r.C)}; ${run} − B = ${pts(r.diff.est)} points, 95% CI ${pts(r.diff.lo)} to ${pts(r.diff.hi)}; ${r.lost} lost, ${r.gained} gained, McNemar p = ${r.p.toFixed(3)}`;
