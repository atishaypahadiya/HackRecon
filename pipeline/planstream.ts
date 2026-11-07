// Plan's sections as a stream (P2; D4, user: "20–40 s per fit call is too slow for a type-and-see loop"). Every
// section starts at once and is sent the moment it's ready, tracks first. Today that's tracks, booths and gaps: the
// repo is cloned while the tracks are ranked, and the gap check starts as soon as both are in. Each step reads its
// cache first (D6: input hash), so an unchanged description and stack come back without a model call. Credits,
// sessions and people join as their own tasks when they're built: each emits into the same queue, unordered.
import type { BoothBlock } from "./plan.ts";
import type { GapResult, ProjectFact } from "./gaps.ts";
import type { PlanSection, PlanTrack } from "./plan.ts";
import type { Repo } from "./repo.ts";
import type { Usage } from "./usage.ts";

export type PlanSectionName = "tracks" | "booths" | "gaps";

export type PlanEvent =
  | { section: "tracks"; ms: number; from: "cache" | "model"; tracks: PlanTrack[]; usage: Usage | null }
  | { section: "booths"; ms: number; booths: BoothBlock[] }
  | { section: "gaps"; ms: number; from: GapResult["from"]; gaps: GapResult["gaps"]; checked: number; facts: GapResult["facts"]; usage: Usage | null; repo?: { url: string; commit: string } }
  | { section: PlanSectionName; ms: number; error: string }
  | { section: "done"; ms: number; first: { section: PlanSectionName; ms: number } | null };

export interface PlanSteps {
  tracks: () => Promise<PlanSection<PlanTrack> | { error: string }>;
  /** null when no repo is linked. Started with the tracks, not after them. */
  repo: (() => Promise<Repo | { error: string }>) | null;
  /** Repo lines naming the likely tracks' products (repo.ts repoFacts). */
  repoLines: (repo: Repo, tracks: PlanTrack[]) => ProjectFact[];
  gaps: (tracks: PlanTrack[], repoLines: ProjectFact[]) => Promise<GapResult | { error: string }>;
  booths: (tracks: PlanTrack[], gaps?: GapResult["gaps"]) => BoothBlock[];
  now?: () => number;
  /** Server-side notes (a repo that couldn't be read); never sent to the page. */
  log?: (line: string) => void;
}

/** A push queue read as an async iterator: tasks emit whenever they're ready, the reader takes events in that order. */
class Queue<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(x: T) {
    this.items.push(x);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.closed) return;
      else await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

export async function* planStream(s: PlanSteps): AsyncGenerator<PlanEvent> {
  const now = s.now ?? (() => performance.now());
  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const q = new Queue<PlanEvent>();
  let first: { section: PlanSectionName; ms: number } | null = null;
  const sent = new Set<PlanSectionName>();
  const emit = (e: PlanEvent) => {
    if (e.section === "done") return;
    if (!("error" in e) && !first) first = { section: e.section, ms: e.ms };
    sent.add(e.section);
    q.push(e);
  };

  const repoP = s.repo?.() ?? null;
  const tracksChain = (async () => {
    const r = await s.tracks();
    if ("error" in r) {
      for (const section of ["tracks", "booths", "gaps"] as const) emit({ section, ms: ms(), error: r.error });
      return;
    }
    emit({ section: "tracks", ms: ms(), from: r.from as "cache" | "model", tracks: r.items, usage: r.usage });
    emit({ section: "booths", ms: ms(), booths: s.booths(r.items) });
    const repo = repoP ? await repoP : null;
    if (repo && "error" in repo) s.log?.(`plan: ${repo.error}; checking gaps against the description and stack only`);
    const lines = repo && !("error" in repo) ? s.repoLines(repo, r.items) : [];
    const g = await s.gaps(r.items, lines);
    if ("error" in g) {
      emit({ section: "gaps", ms: ms(), error: g.error });
      return;
    }
    emit({ section: "gaps", ms: ms(), from: g.from, gaps: g.gaps, checked: g.checked, facts: g.facts, usage: g.usage, ...(repo && !("error" in repo) ? { repo: { url: repo.url, commit: repo.sha } } : {}) });
    // Booths ask from a gap once one is found, so they're rebuilt with the gaps.
    emit({ section: "booths", ms: ms(), booths: s.booths(r.items, g.gaps) });
  })();

  // A step that throws (not one that returns an error) still settles every section it owed.
  const tasks = [{ p: tracksChain, owes: ["tracks", "booths", "gaps"] as const }].map(({ p, owes }) =>
    p.catch((e: unknown) => {
      s.log?.(`plan: section failed: ${(e as Error).message}`);
      for (const section of owes) if (!sent.has(section)) emit({ section, ms: ms(), error: "failed" });
    }),
  );
  void Promise.all(tasks).then(() => {
    q.push({ section: "done", ms: ms(), first });
    q.close();
  });
  yield* q.drain();
}
