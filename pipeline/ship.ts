// Ship's "Recheck gaps" item (user 2026-11-06): rerun the gap check for the tracks the user plans to enter against
// the linked repo's latest commit. It records the commit and when it was checked; when the latest commit is the one
// already checked, the stored result is reused with no model call. Open gaps go above Ship's checklist with their
// quotes. Same rules as Plan's gaps: facts from both sides, each with its source; never a verdict.
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { EventConfig } from "./classify.ts";
import { trackCards, type SponsorAliases } from "./fit.ts";
import { planGaps, type Gap, type GapCache } from "./gaps.ts";
import { entrySteps, type PlanInput, type PlanStep } from "./plan.ts";
import { checkoutRepo, remoteHead, repoFacts, type Repo } from "./repo.ts";
import type { Entity } from "./schema.ts";

/** One stored recheck, keyed by the repo, the entered tracks and the description and stack (shipKey). */
export interface ShipGapRecord {
  repo: string;
  commit: string;
  /** When the gap check ran on this commit (ISO). */
  checked_at: string;
  tracks: string[];
  gaps: Gap[];
  /** Requirements and entry steps checked; 0 means the entered tracks state none. */
  checked: number;
  repo_lines: number;
}
export type ShipGapStore = Record<string, ShipGapRecord>;

export interface ShipGapCheck extends ShipGapRecord {
  /** "reused": the latest commit is the one already checked. "checked": the check ran on it now. */
  from: "reused" | "checked";
  /** When the latest commit was looked up (ISO): the check is current as of then. */
  latest_at: string;
}

/** An entered track as the gap check and Ship's checklist need it. */
export interface ShipTrack {
  track_id: string;
  name: string;
  sponsor: string;
  fit: "likely" | "possible";
  steps: PlanStep[];
  source_url: string;
  product_names: string[];
}

/** The entered tracks from canon, in the order given; unknown ids are reported, not guessed. */
export function shipTracks(entities: Entity[], ids: string[], e: EventConfig, aliases: SponsorAliases = {}): { tracks: ShipTrack[]; unknown: string[] } {
  const cards = new Map(trackCards(entities, e, aliases).map((c) => [c.id, c]));
  const byId = new Map(entities.filter((x) => x.kind === "track").map((x) => [x.id, x]));
  const tracks: ShipTrack[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) {
      unknown.push(id);
      continue;
    }
    const products = [...new Set([...(cards.get(id)?.products ?? []), t.sponsor, ...(aliases[t.sponsor] ?? [])])].filter((n) => n && n !== "event");
    tracks.push({ track_id: id, name: t.name.value ?? "", sponsor: t.sponsor, fit: "possible", steps: entrySteps(entities, [id]), source_url: t.name.source.url, product_names: products });
  }
  return { tracks, unknown };
}

export function shipKey(repo: string, trackIds: string[], input: PlanInput): string {
  return createHash("sha256").update(JSON.stringify([repo, [...trackIds].sort(), input.idea, input.stack ?? []])).digest("hex").slice(0, 16);
}

export interface Git {
  remoteHead: (url: string) => string | { error: string };
  checkout: (url: string) => Repo | { error: string };
}
const realGit: Git = { remoteHead, checkout: (url) => checkoutRepo(url, { latest: true }) };

export async function recheckGaps(
  client: Anthropic | null,
  input: PlanInput & { repo: string },
  tracks: ShipTrack[],
  entities: Entity[],
  gapCache: GapCache,
  store: ShipGapStore,
  opts: { now?: () => Date; git?: Git } = {},
): Promise<ShipGapCheck | { error: string }> {
  const now = opts.now ?? (() => new Date());
  const git = opts.git ?? realGit;
  const ids = tracks.map((t) => t.track_id);
  const key = shipKey(input.repo, ids, input);
  const head = git.remoteHead(input.repo);
  if (typeof head !== "string") return head;
  const latest_at = now().toISOString();
  const stored = store[key];
  if (stored && stored.commit === head) return { ...stored, from: "reused", latest_at };
  const repo = git.checkout(input.repo);
  if ("error" in repo) return repo;
  const lines = repoFacts(repo, tracks.flatMap((t) => t.product_names));
  const g = await planGaps(client, tracks, entities, input, lines, gapCache, undefined, "all");
  if ("error" in g) return g;
  const record: ShipGapRecord = { repo: repo.url, commit: repo.sha, checked_at: now().toISOString(), tracks: ids, gaps: g.gaps, checked: g.checked, repo_lines: lines.length };
  store[key] = record;
  return { ...record, from: "checked", latest_at };
}
