import { describe, expect, test } from "bun:test";
import { fitHash, fitRequest, fitSystemPrompt, trackCards } from "./fit.ts";
import { boothQuestions, capLikely, entryUse, NOT_STATED, projectLead, stackForRanker, stackProduct, statedUse, useClause, parseStack, planTracks, type FitCache, type PlanTrack } from "./plan.ts";
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
    const hash = fitHash(fitSystemPrompt(e, trackCards(ents, e)), fitRequest(input.idea, stackForRanker(input.stack)));
    const cache: FitCache = { [hash]: { ranked: [{ track_id: "t2", fit: "possible", reason: "r2", quote: "judged on design" }, { track_id: "t1", fit: "likely", reason: "r1", quote: "must use Acme" }], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 1 } };
    const r = await planTracks(null, input, ents, e, cache);
    if ("error" in r) throw new Error(r.error);
    expect([r.from, r.items.map((t) => [t.track_id, t.fit]), r.items[0]!.source_url]).toEqual(["cache", [["t1", "likely"], ["t2", "possible"]], "https://e.devpost.com/"]);
    expect(r.items.map((t) => t.steps.map((s) => [s.id, s.step_kind, s.quote]))).toEqual([[["s1", "opt_in", "Sign up on the Acme portal"], ["s2", "supplemental_form", "Fill in the Acme form"]], []]);
  });
  const H = { idea: "Hindsight: a transfer planner for community-college transfer students. It shows which transferred credits count, what's left, an every-term plan to graduation with schedule and free time, campus opportunities, and an Ask assistant.", stack: parseStack("web app on Vercel, Python FastAPI backend, Claude API, Apify, Factory Droid SDK, UI designed in Figma") };
  const t = (track_id: string, name: string, evidence: PlanTrack["evidence"], product_names: string[], quote = name): PlanTrack => ({ track_id, name, sponsor: product_names[0] ?? "S", evidence, label: evidence === "stated" ? null : NOT_STATED, fit: "possible", capped: false, product_names, reason: "", quote, source_url: "https://e.devpost.com/", steps: [] });
  test("Booths questions are built from the plan item: the user's stack entry, their description, the page's quote or title", () => {
    const q = boothQuestions(
      [
        t("actor", "[Apify] Best Actor sponsored by Apify", "stated", ["Apify"], "Project must be using Apify in a meaningful way."),
        t("claude", "[Anthropic] Claude for Public Benefit", "title", ["Claude", "Anthropic"]),
        t("figma", "[Figma] Best Design", "title", ["Figma"]),
        t("mana", "[Mana] Best Use of Mana", "title", ["Mana"]),
        t("conv", "[Convex] Best use of Convex", "stated", ["Convex"], "Build it on Convex"),
        t("visa", "[Visa] Best use of Reimagining Shopping sponsored by Visa", "cash_only", ["Visa"]),
      ],
      H,
    );
    expect(q.map((b) => [b.track_id, b.question])).toEqual([
      ["actor", "We use Apify for a transfer planner for community-college transfer students; does that count as ‘Project must be using Apify in a meaningful way’?"],
      ["claude", "We use Claude API for a transfer planner for community-college transfer students; what does ‘Claude for Public Benefit’ reward beyond that?"],
      ["figma", "We designed the UI in Figma; what does ‘Best Design’ reward beyond that?"],
      ["mana", "What does ‘Best Use of Mana’ reward?"],
    ]);
    expect(q[2]!.grounds).toBe("your stack lists “UI designed in Figma”; Devpost states no requirements or judging criteria for [Figma] Best Design");
  });
  test("a use is stated only when the description states it; the user's words, never invented", () => {
    const idea = "Catalog: a course planner. It uses Apify to scrape course catalogs every night.";
    expect(statedUse(["Apify"], idea)).toBe("to scrape course catalogs every night");
    expect(statedUse(["Apify"], H.idea)).toBeNull();
    expect(projectLead(H.idea)).toBe("a transfer planner for community-college transfer students");
    expect(projectLead("An app that helps nurses: triage at a glance.")).toBe("An app that helps nurses: triage at a glance");
    const [b] = boothQuestions([t("actor", "[Apify] Best Actor sponsored by Apify", "stated", ["Apify"], "Project must be using Apify in a meaningful way.")], { idea, stack: null });
    expect(b!.question).toBe("We use Apify to scrape course catalogs every night; does that count as ‘Project must be using Apify in a meaningful way’?");
    expect(b!.grounds).toContain("your description names Apify; your description says “to scrape course catalogs every night”");
    expect(stackProduct(["Claude"], parseStack("Claude API"))).toEqual({ phrase: "Claude API", entry: "Claude API", used_for: null });
    expect(stackProduct(["Mana"], parseStack("manage state with Redux"))).toBeNull();
  });
  test("a stack item's used_for drives the opening; an entry that says its use replaces the description fallback (user 2026-11-06)", () => {
    const stack = parseStack("Apify: pull course catalogs from university sites, Claude API: the Ask assistant, UI designed in Figma, ASI:One");
    expect(stack).toEqual([
      { name: "Apify", used_for: "pull course catalogs from university sites" },
      { name: "Claude API", used_for: "the Ask assistant" },
      { name: "UI designed in Figma", used_for: null },
      { name: "ASI:One", used_for: null },
    ]);
    const q = boothQuestions(
      [t("actor", "[Apify] Best Actor sponsored by Apify", "stated", ["Apify"], "Project must be using Apify in a meaningful way."), t("claude", "[Anthropic] Claude for Public Benefit", "title", ["Claude", "Anthropic"]), t("figma", "[Figma] Best Design", "title", ["Figma"])],
      { idea: H.idea, stack },
    );
    expect(q.map((b) => b.question)).toEqual([
      "We use Apify to pull course catalogs from university sites; does that count as ‘Project must be using Apify in a meaningful way’?",
      "We use Claude API for the Ask assistant; what does ‘Claude for Public Benefit’ reward beyond that?",
      "We designed the UI in Figma; what does ‘Best Design’ reward beyond that?",
    ]);
    expect(q[0]!.grounds).toBe("your stack lists “Apify”, used for “pull course catalogs from university sites”; the page's requirement “Project must be using Apify in a meaningful way”");
    expect([useClause("scraping catalogs"), useClause("UI design"), useClause("to host the API"), useClause("store sessions.")]).toEqual(["for scraping catalogs", "for UI design", "to host the API", "to store sessions"]);
    expect([entryUse("frontend built with React", "React"), entryUse("web app on Vercel", "Vercel"), entryUse("UI designed in Figma", "Claude")]).toEqual(["We built the frontend with React", null, null]);
  });
  test("the ranker sees used_for only when given; a plain stack renders as before, so eval cache keys hold", () => {
    expect(stackForRanker(parseStack("Apify, Claude API"))).toEqual(["Apify", "Claude API"]);
    expect(fitRequest("x", stackForRanker(parseStack("Apify, Claude API")))).toBe(fitRequest("x", ["Apify", "Claude API"]));
    expect(stackForRanker(parseStack("Apify: pull course catalogs"))).toEqual(["Apify (used for: pull course catalogs)"]);
  });
  test("label rule: a title-only 'likely' stays only when the user names a product the title names (user 2026-11-06)", () => {
    const card = (name: string, evidence: TrackCard["evidence"], products: string[]): TrackCard => ({ id: "t", sponsor: "S", name, evidence, products, lines: [], context: [] });
    const likely = { track_id: "t", fit: "likely" as const, reason: "", quote: "" };
    const claude = card("[Anthropic] Claude for Public Benefit", "title", ["Claude"]);
    expect(capLikely(likely, claude, { idea: "a planner", stack: parseStack("FastAPI, Claude API") })).toEqual({ fit: "likely", capped: false });
    expect(capLikely(likely, claude, { idea: "built with Claude", stack: null })).toEqual({ fit: "likely", capped: false });
    expect(capLikely(likely, claude, { idea: "a planner", stack: parseStack("FastAPI") })).toEqual({ fit: "possible", capped: true });
    expect(capLikely(likely, card("[Figma] Best Design", "title", []), { idea: "UI designed in Figma", stack: parseStack("Figma") })).toEqual({ fit: "possible", capped: true });
    expect(capLikely(likely, card("[Acme] Best Use", "stated", ["Acme"]), { idea: "x", stack: null })).toEqual({ fit: "likely", capped: false });
    expect(capLikely({ ...likely, fit: "possible" }, claude, { idea: "x", stack: null })).toEqual({ fit: "possible", capped: false });
  });
  test("an unranked idea without an API key is an error, never an empty plan", async () => {
    expect(await planTracks(null, { idea: "new", stack: null }, ents, e, {})).toEqual({ error: "no API key, and this idea hasn't been ranked before" });
    expect(parseStack(" , ")).toBeNull();
  });
});
