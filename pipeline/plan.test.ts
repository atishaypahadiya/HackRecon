import { describe, expect, test } from "bun:test";
import { fitHash, fitRequest, fitSystemPrompt, trackCards } from "./fit.ts";
import { boothQuestions, capLikely, NOT_STATED, parseStack, planTracks, type FitCache, type PlanTrack } from "./plan.ts";
import type { TrackCard } from "./fit.ts";
import type { Entity } from "./schema.ts";

const src = { kind: "page" as const, url: "https://e.devpost.com/", quote: "", captured_at: "" };
const track = (id: string, sponsor: string, name: string): Entity => ({ id, kind: "track", sponsor, name: { value: name, source: { ...src, quote: name } }, fields: {}, history: [], origin: "page" });
const req = (t: Entity, q: string): Entity => ({ ...t, fields: { "requirements[0]": { value: q, source: { ...src, quote: q } } } });
const step = (id: string, tid: string, kind: string, text: string, block: number): Entity => ({
  id,
  kind: "entry_step",
  sponsor: "Acme",
  name: { value: id, source: src },
  fields: { track_id: { value: tid, source: src }, step_kind: { value: kind, source: src }, text: { value: text, source: { ...src, quote: text, block } } },
  history: [],
  origin: "page",
});
const ents = [req(track("t1", "Acme", "[Acme] Best Use"), "must use Acme"), req(track("t2", "Beta", "[Beta] Best Design"), "judged on design"), step("s2", "t1", "supplemental_form", "Fill in the Acme form", 9), step("s1", "t1", "opt_in", "Sign up on the Acme portal", 4)];
const e = { event: "Test Hacks", timezone: "UTC" } as never;

describe("Plan tracks", () => {
  test("cached ranking: no client needed, likely before possible, source link from canon", async () => {
    const input = { idea: "an app", stack: parseStack("Acme, Figma") };
    const hash = fitHash(fitSystemPrompt(e, trackCards(ents, e)), fitRequest(input.idea, input.stack));
    const cache: FitCache = { [hash]: { ranked: [{ track_id: "t2", fit: "possible", reason: "r2", quote: "judged on design" }, { track_id: "t1", fit: "likely", reason: "r1", quote: "must use Acme" }], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 1 } };
    const r = await planTracks(null, input, ents, e, cache);
    if ("error" in r) throw new Error(r.error);
    expect([r.from, r.items.map((t) => [t.track_id, t.fit]), r.items[0]!.source_url]).toEqual(["cache", [["t1", "likely"], ["t2", "possible"]], "https://e.devpost.com/"]);
    expect(r.items.map((t) => t.steps.map((s) => [s.id, s.step_kind, s.quote]))).toEqual([[["s1", "opt_in", "Sign up on the Acme portal"], ["s2", "supplemental_form", "Fill in the Acme form"]], []]);
  });
  test("title-tier tracks carry 'requirements not stated' and get a rep question in Booths; stated and cash_only don't", () => {
    const t = (track_id: string, name: string, evidence: PlanTrack["evidence"]): PlanTrack => ({ track_id, name, sponsor: "Fig", evidence, label: evidence === "stated" ? null : NOT_STATED, fit: "possible", capped: false, reason: "", quote: name, source_url: "https://e.devpost.com/", steps: [] });
    expect(boothQuestions([t("a", "[Fig] Best Design", "title"), t("b", "[Fig] Most Creative", "stated"), t("c", "[Mana] Best Use of Mana", "cash_only")])).toEqual([
      { track_id: "a", sponsor: "Fig", question: "What does ‘Best Design’ reward?", grounds: "Devpost states no requirements or judging criteria for [Fig] Best Design", source_url: "https://e.devpost.com/" },
    ]);
  });
  test("label rule: a title-only 'likely' stays only when the user names a product the title names (user 2026-11-06)", () => {
    const card = (name: string, evidence: TrackCard["evidence"], products: string[]): TrackCard => ({ id: "t", sponsor: "S", name, evidence, products, lines: [], context: [] });
    const likely = { track_id: "t", fit: "likely" as const, reason: "", quote: "" };
    const claude = card("[Anthropic] Claude for Public Benefit", "title", ["Claude"]);
    expect(capLikely(likely, claude, { idea: "a planner", stack: ["FastAPI", "Claude API"] })).toEqual({ fit: "likely", capped: false });
    expect(capLikely(likely, claude, { idea: "built with Claude", stack: null })).toEqual({ fit: "likely", capped: false });
    expect(capLikely(likely, claude, { idea: "a planner", stack: ["FastAPI"] })).toEqual({ fit: "possible", capped: true });
    expect(capLikely(likely, card("[Figma] Best Design", "title", []), { idea: "UI designed in Figma", stack: ["Figma"] })).toEqual({ fit: "possible", capped: true });
    expect(capLikely(likely, card("[Acme] Best Use", "stated", ["Acme"]), { idea: "x", stack: null })).toEqual({ fit: "likely", capped: false });
    expect(capLikely({ ...likely, fit: "possible" }, claude, { idea: "x", stack: null })).toEqual({ fit: "possible", capped: false });
  });
  test("an unranked idea without an API key is an error, never an empty plan", async () => {
    expect(await planTracks(null, { idea: "new", stack: null }, ents, e, {})).toEqual({ error: "no API key, and this idea hasn't been ranked before" });
    expect(parseStack(" , ")).toBeNull();
  });
});
