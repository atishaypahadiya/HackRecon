import { describe, expect, test } from "bun:test";
import type { EventConfig } from "./classify.ts";
import { checkFit, isEventLevel, isToolGated, trackCards, type Ranked, type TrackCard } from "./fit.ts";
import { scoreFit, type EvalItem } from "./fiteval.ts";
import type { Entity } from "./schema.ts";

const ev = { event: "Mini", timezone: "UTC", hacking_start: null, hacking_end: null, schedule: [], event_level_prizes: ["[MLH] Commit Fellowship"], tool_gated_prizes: ["[MLH] Best Use of *"] } as EventConfig;
const fv = (value: unknown, quote = String(value)) => ({ value, source: { kind: "page" as const, url: "u", quote, captured_at: "" } });
const ent = (id: string, kind: Entity["kind"], sponsor: string, name: string, fields: Record<string, unknown> = {}): Entity => ({
  id,
  kind,
  sponsor,
  name: { value: name, source: fv(name).source },
  fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fv(v)])),
  history: [],
  origin: "page",
});
const es: Entity[] = [
  ent("t:overall", "track", "event", "Mini Overall"),
  ent("t:commit", "track", "MLH", "[MLH] Commit Fellowship"),
  ent("t:acme", "track", "Acme", "[Acme] Best Use of Acme", { description: "Build an agent on Acme.", "requirements[0]": "must use the Acme API" }),
  ent("t:gem", "track", "MLH", "[MLH] Best Use of Gemini API", { description: "Use Gemini." }),
  ent("t:viz", "track", "Viz", "[Viz] Best Visualization"),
  ent("c:acme", "criterion", "Acme", "Agent depth", { track_id: "t:acme", description: "How autonomous the agent is" }),
  ent("p:acme", "prize", "Acme", "1st", { track_id: "t:acme", award_text: "$500 + interview" }),
];

describe("tracks for fit", () => {
  test("event-level tracks are left out; cards carry description, requirements, own criteria, prizes", () => {
    const cards = trackCards(es, ev);
    expect(cards.map((c) => c.id)).toEqual(["t:acme", "t:gem", "t:viz"]);
    expect(cards[0]!.lines).toEqual(["Build an agent on Acme.", "must use the Acme API", "Agent depth", "How autonomous the agent is", "$500 + interview"]);
    expect(isEventLevel(es[1]!, ev)).toBe(true);
    expect(isToolGated("[MLH] Best Use of Gemini API", ev)).toBe(true);
    expect(isToolGated("[Acme] Best Use of Acme", ev)).toBe(false);
  });
});

describe("checkFit", () => {
  const cards = trackCards(es, ev);
  const r = (track_id: string, quote: string): Ranked => ({ track_id, fit: "likely", reason: "", quote });
  test("accepts quotes from the track's own lines or name", () => {
    expect(checkFit({ ranked: [r("t:acme", "must use the acme API"), r("t:gem", "Use Gemini"), r("t:viz", "[Viz] Best Visualization")] }, cards)).toHaveLength(3);
  });
  test("rejects another track's quote, unknown or event-level ids, duplicates, short lists", () => {
    const out = checkFit({ ranked: [r("t:gem", "must use the Acme API"), r("t:overall", "x"), r("t:viz", "Best Visualization"), r("t:viz", "Best Visualization")] }, cards);
    expect(out).toEqual({ error: expect.stringContaining("is not in [MLH] Best Use of Gemini API's lines") });
    const e = (out as { error: string }).error;
    expect(e).toContain("t:overall is not a track id");
    expect(e).toContain("t:viz is ranked twice");
  });
});

describe("scoreFit", () => {
  const cards: TrackCard[] = trackCards(es, ev);
  const names = new Set(es.filter((e) => e.kind === "track").map((e) => e.name.value!));
  const items: EvalItem[] = [
    { slug: "p1", url: "", description: "", built_with: [], won: ["[Acme] Best Use of Acme", "Mini Overall"] },
    { slug: "p2", url: "", description: "", built_with: [], won: ["[MLH] Best Use of Gemini API", "[Viz] Best Visualization"] },
  ];
  const rk = (...ids: string[]) => ids.map((track_id) => ({ track_id, fit: "likely" as const, reason: "", quote: "" }));
  test("recall@3 over pairs, any-hit per project, event-level listed, stack rule", () => {
    const A = new Map([["p1", rk("t:gem", "t:viz", "t:acme")], ["p2", rk("t:acme", "t:gem", "t:x", "t:viz")]]);
    const B = new Map([["p1", rk("t:acme")], ["p2", rk("t:gem", "t:viz")]]);
    const r = scoreFit(items, cards, names, ev, A, B);
    expect([r.pairs, r.projects]).toEqual([3, 2]);
    expect(r.recall3).toEqual({ A: { hits: 2, n: 3 }, B: { hits: 3, n: 3 } }); // p2's Viz is 4th in A
    expect(r.best_use).toEqual({ A: { hits: 2, n: 2 }, B: { hits: 2, n: 2 }, prizes: 2 });
    expect(r.any_hit.A).toEqual({ hits: 2, n: 2 });
    expect(r.event_level).toEqual([{ project: "p1", prize: "Mini Overall" }]);
    expect(r.asks_for_stack).toBe(true); // +33.3 points overall
    expect(r.per_prize.find((p) => p.prize.includes("Gemini"))!.tool_gated).toBe(true);
  });
  test("a missing ranking counts as a miss and is listed", () => {
    const r = scoreFit(items, cards, names, ev, new Map(), new Map([["p1", rk("t:acme")]]));
    expect(r.recall3.A).toEqual({ hits: 0, n: 3 });
    expect(r.failed.A).toEqual(["p1", "p2"]);
  });
});
