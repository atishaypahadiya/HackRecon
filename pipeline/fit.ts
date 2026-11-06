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

export interface TrackCard {
  id: string;
  sponsor: string;
  name: string;
  /** Every quoted value the ranker may cite, one per line. */
  lines: string[];
}

/** A sponsor track and everything canon says about it: description, requirements, its own criteria, prizes. */
export function trackCards(entities: Entity[], e: EventConfig): TrackCard[] {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return entities
    .filter((t) => t.kind === "track" && !isEventLevel(t, e))
    .map((t) => {
      const own = Object.entries(t.fields)
        .filter(([k]) => k === "description" || k.startsWith("requirements[") || k === "eligible_with")
        .map(([, v]) => str(v.value));
      const crit = entities.filter((c) => c.kind === "criterion" && c.fields.track_id?.value === t.id).flatMap((c) => [str(c.name.value), str(c.fields.description?.value)]);
      const prizes = entities.filter((p) => p.kind === "prize" && p.fields.track_id?.value === t.id).map((p) => str(p.fields.award_text?.value));
      const lines = [...new Set([...own, ...crit, ...prizes].filter((l): l is string => !!l).map(norm))];
      return { id: t.id, sponsor: t.sponsor, name: t.name.value ?? "", lines };
    });
}

export function fitSystemPrompt(e: EventConfig, cards: TrackCard[]): string {
  const body = cards.map((c) => `<track id="${c.id}" sponsor="${c.sponsor}">\n${c.name}\n${c.lines.map((l) => `- ${l}`).join("\n")}\n</track>`).join("\n");
  return `You match a hackathon project idea to the sponsor tracks of ${e.event} it most likely fits. A hacker reads your answer to decide which tracks to enter, so rank by what each track says it wants and judges, as stated below, not by general popularity.

Return the ${FIT_TOP} best-fitting tracks, best first. For each: its id, fit ("likely" when the idea plainly meets what the track asks for, "possible" when it could with a small change), a one-line reason, and quote: a phrase copied exactly from that track's own lines below (its name, a requirement, a criterion or its description) that the fit rests on.

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

export function fitRequest(idea: string, stack: string[] | null): string {
  return `<idea>${idea}</idea>${stack?.length ? `\n<stack>${stack.join(", ")}</stack>` : ""}`;
}

export function fitHash(system: string, request: string): string {
  return createHash("sha256").update(JSON.stringify([FIT_MODEL, FIT_EFFORT, FIT_SCHEMA, system, request])).digest("hex").slice(0, 16);
}

/** Every id is a sponsor track, no track twice, every quote is in that track's card (or is its name). */
export function checkFit(parsed: unknown, cards: TrackCard[]): Ranked[] | { error: string } {
  const r = (parsed as { ranked?: Ranked[] })?.ranked;
  if (!Array.isArray(r) || !r.length) return { error: "missing ranked[]" };
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
    if (!q || ![c.name, ...c.lines].some((l) => norm(l).toLowerCase().includes(q))) errors.push(`quote "${x.quote.slice(0, 80)}" is not in ${c.name}'s lines`);
  }
  if (r.length < Math.min(FIT_TOP, cards.length)) errors.push(`ranked ${r.length} tracks, expected ${Math.min(FIT_TOP, cards.length)}`);
  return errors.length ? { error: errors.join("; ") } : r.slice(0, FIT_TOP);
}
