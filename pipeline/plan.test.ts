import { describe, expect, test } from "bun:test";
import { fitHash, fitRequest, fitSystemPrompt, trackCards } from "./fit.ts";
import { boothBlocks, boothQuestions, capLikely, entryUse, NOT_STATED, PLAN_LIMITS, parsePlanBody, planMeta, trackDetail, projectLead, stackForRanker, stackProduct, statedUse, useClause, parseStack, planTracks, type FitCache, type PlanTrack } from "./plan.ts";
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
    expect(q[2]!.grounds).toBe("your stack lists “UI designed in Figma”; the event's page states no requirements or judging criteria for [Figma] Best Design");
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
  test("no tracks announced yet: an empty ranking from no model call, never a call to rank nothing (Iterate, 2026-11-08)", async () => {
    const never = { messages: { create: () => Promise.reject(new Error("called")) } } as never;
    const r = await planTracks(never, { idea: "AI research labs that compete", stack: null }, [], e, {});
    expect(r).toMatchObject({ items: [], from: "none", usage: null });
  });
  describe("a stack change told to Donna re-ranks only the tracks it affects", () => {
    const three = [...ents, track("t3", "Gamma", "[Gamma] Best Use of Gamma")];
    const before = { idea: "an app", stack: parseStack("Acme") };
    const prior = [
      { track_id: "t1", fit: "likely" as const, reason: "your stack lists Acme", quote: "must use Acme" },
      { track_id: "t2", fit: "possible" as const, reason: "a designed UI could suit it", quote: "judged on design" },
    ];
    const seeded = (): FitCache => ({ [fitHash(fitSystemPrompt(e, trackCards(three, e)), fitRequest(before.idea, stackForRanker(before.stack)))]: { ranked: prior, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 1 } });
    // A fake model that records which tracks it was asked to rank and ranks each "likely".
    const fake = (asked: string[][]) =>
      ({
        messages: {
          stream: (p: { system: { text: string }[]; messages: { content: string }[] }) => ({
            finalMessage: async () => {
              const rr = /<rerank>[^:]*: ([^<]*)<\/rerank>/.exec(p.messages[0]!.content)?.[1];
              const ids = rr ? rr.split(", ") : ["t1", "t2", "t3"].filter((id) => p.system[0]!.text.includes(`id="${id}"`));
              asked.push(ids);
              const q = (id: string) => ({ t1: "must use Acme", t2: "judged on design", t3: "[Gamma] Best Use of Gamma" })[id]!;
              return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: "text", text: JSON.stringify({ ranked: ids.map((id) => ({ track_id: id, fit: id === "t3" ? "possible" : "likely", reason: `new ${id}`, quote: q(id) })) }) }] };
            },
          }),
        },
      }) as never;
    test("affectedTracks: the changed item's sponsor or product, or a track whose last reason leaned on it", async () => {
      const { affectedTracks } = await import("./plan.ts");
      const cards = trackCards(three, e);
      expect([...affectedTracks(cards, prior, ["Gamma"])]).toEqual(["t3"]);
      expect([...affectedTracks(cards, prior, ["acme sdk"])]).toEqual(["t1"]);
      expect([...affectedTracks(cards, prior, ["PyTorch"])]).toEqual([]);
    });
    test("adding Gamma ranks only Gamma's track; the others keep their ranking; the merge is cached for the board", async () => {
      const cache = seeded(), asked: string[][] = [];
      const input = { idea: "an app", stack: parseStack("Acme, Gamma") };
      const r = await planTracks(fake(asked), input, three, e, cache, {}, undefined, { before, changed: ["Gamma"] });
      if ("error" in r) throw new Error(r.error);
      expect(asked).toEqual([["t3"]]);
      expect([r.from, r.items.map((t) => [t.track_id, t.fit, t.reason])]).toEqual(["partial", [["t1", "likely", "your stack lists Acme"], ["t2", "possible", "a designed UI could suit it"], ["t3", "possible", "new t3"]]]);
      const again = await planTracks(null, input, three, e, cache);
      expect("error" in again ? again.error : again.from).toBe("cache");
    });
    test("an item no track names makes no model call", async () => {
      const asked: string[][] = [];
      const r = await planTracks(fake(asked), { idea: "an app", stack: parseStack("Acme, PyTorch") }, three, e, seeded(), {}, undefined, { before, changed: ["PyTorch"] });
      expect([asked, "error" in r ? r.error : [r.from, r.usage]]).toEqual([[], ["partial", null]]);
    });
    test("a rep's note re-ranks its own track with the note as context, never a quotable line; the others keep their ranking", async () => {
      const { withRepNotes } = await import("./plan.ts");
      const told = { source: "chat" as const, at: "2026-11-14T19:00:00.000Z", quote: "Sam at Gamma said it has to use Gamma Flows" };
      const note = { id: "rep:t2#1", track_id: "t2", kind: "requirement" as const, text: "it has to use Gamma Flows", rep: "Sam", told };
      const card = withRepNotes(trackCards(three, e), [note]).find((c) => c.id === "t2")!;
      expect([card.lines.some((l) => l.includes("Gamma Flows")), card.context.at(-1)]).toEqual([false, 'a rep told the hacker (not on the page; the page wins where they differ), requirement: "it has to use Gamma Flows"']);
      const cache = seeded(), asked: string[][] = [];
      const r = await planTracks(fake(asked), before, three, e, cache, {}, undefined, { before, changed: [], beforeNotes: [], tracks: ["t2"] }, [note]);
      if ("error" in r) throw new Error(r.error);
      expect(asked).toEqual([["t2"]]);
      expect(r.items.map((t) => [t.track_id, t.reason])).toEqual([["t1", "your stack lists Acme"], ["t2", "new t2"]]);
      // The board's own run afterwards reads the same notes, so it hits the cached merge.
      const again = await planTracks(null, before, three, e, cache, {}, undefined, undefined, [note]);
      expect("error" in again ? again.error : again.from).toBe("cache");
    });
    test("a new idea, or no last ranking to start from, ranks everything", async () => {
      const asked: string[][] = [];
      await planTracks(fake(asked), { idea: "a different app", stack: parseStack("Acme, Gamma") }, three, e, seeded(), {}, undefined, { before, changed: ["Gamma"] });
      expect(asked).toEqual([["t1", "t2", "t3"]]);
    });
  });
  test("an unranked idea without an API key is an error, never an empty plan", async () => {
    expect(await planTracks(null, { idea: "new", stack: null }, ents, e, {})).toEqual({ error: "no API key, and this idea hasn't been ranked before" });
    expect(parseStack(" , ")).toBeNull();
  });
  test("POST /plan bodies: trimmed, empty items dropped, limits enforced", () => {
    expect(parsePlanBody({ idea: "  an app ", stack: [{ name: " Apify ", used_for: " pull catalogs " }, { name: "", used_for: "x" }, { name: "Vercel" }] })).toEqual({ idea: "an app", stack: [{ name: "Apify", used_for: "pull catalogs" }, { name: "Vercel", used_for: null }] });
    expect(parsePlanBody({ idea: "x", stack: [] })).toEqual({ idea: "x", stack: null });
    expect(parsePlanBody({ idea: " " })).toEqual({ error: "describe your project first" });
    expect(parsePlanBody({ idea: "x", stack: "Apify" })).toEqual({ error: "stack must be a list" });
    expect(parsePlanBody({ idea: "x", repo: " https://github.com/o/r " })).toEqual({ idea: "x", stack: null, repo: "https://github.com/o/r" });
    for (const repo of ["http://github.com/o/r", "https://evil.test/o/r", "https://github.com/o/r/tree/main", "file:///etc/passwd"]) expect("error" in parsePlanBody({ idea: "x", repo })).toBe(true);
    expect("error" in parsePlanBody({ idea: "x".repeat(PLAN_LIMITS.idea + 1) })).toBe(true);
    expect("error" in parsePlanBody({ idea: "x", stack: Array.from({ length: PLAN_LIMITS.items + 1 }, () => ({ name: "a" })) })).toBe(true);
  });
  test("plan meta: track count and times; the schedule's live items win over canon deadlines", () => {
    const rule = { id: "r1", kind: "rule", sponsor: "event", name: { value: "Submit your hack", source: src }, fields: { deadline: { value: "2026-10-25T09:00-07:00", source: { ...src, quote: "October 25th @ 9 AM" } } }, history: [], origin: "page" } as Entity;
    const ev = { ...(e as object), hacking_start: null, schedule: [] } as never;
    const m = planMeta([...ents, rule], ev);
    expect([m.track_count, m.deadlines.map((d) => [d.name, d.at])]).toEqual([2, [["Submit your hack", "2026-10-25T09:00-07:00"]]]);
    const withSchedule = { ...(e as object), hacking_start: null, schedule: [{ what: "Deadline", at: "2026-10-25T09:00:00-07:00", superseded_by: "Extended", source: "s1" }, { what: "Extended", at: "2026-10-25T09:30:00-07:00", source: "s2" }] } as never;
    expect(planMeta([...ents, rule], withSchedule).deadlines.map((d) => [d.name, d.url])).toEqual([["Extended", "s2"]]);
  });
  test("plan meta at a review clock: nothing before its post; a superseded time holds until the post replacing it", () => {
    const rule = { id: "r1", kind: "rule", sponsor: "event", name: { value: "Submit your hack", source: src }, fields: { deadline: { value: "2026-10-25T09:00-07:00", source: { ...src, quote: "October 25th @ 9 AM" } } }, history: [], origin: "page" } as Entity;
    // Cal Hacks: "due 9:00" posted Sun 1:50 AM, "extended to 9:30" posted Sun 8:59 AM.
    const p = (ts: string) => `https://x.slack.com/archives/C1/p${ts.replace(".", "")}`;
    const ev = { ...(e as object), hacking_start: null, schedule: [{ what: "Final Devpost submissions due", at: "2026-10-25T09:00:00-07:00", superseded_by: "Devpost submission deadline extended", source: p("1792918203.114859") }, { what: "Devpost submission deadline extended", at: "2026-10-25T09:30:00-07:00", source: p("1792943981.782739") }] } as never;
    const at = (iso: string) => planMeta([...ents, rule], ev, Date.parse(iso)).deadlines.map((d) => [d.name, d.at]);
    expect(at("2026-10-24T12:00:00-07:00")).toEqual([["Submit your hack", "2026-10-25T09:00-07:00"]]);
    expect(at("2026-10-25T02:00:00-07:00")).toEqual([["Final Devpost submissions due", "2026-10-25T09:00:00-07:00"]]);
    expect(at("2026-10-25T09:05:00-07:00")).toEqual([["Devpost submission deadline extended", "2026-10-25T09:30:00-07:00"]]);
  });
  test("a track's drawer detail: requirements, criteria, prizes, verbatim", () => {
    const crit = { id: "c1", kind: "criterion", sponsor: "Acme", name: { value: "Depth", source: src }, fields: { track_id: { value: "t1", source: src }, description: { value: "How deep", source: src } }, history: [], origin: "page" } as Entity;
    const prize = { id: "p1", kind: "prize", sponsor: "Acme", name: { value: "1st", source: src }, fields: { track_id: { value: "t1", source: src }, place: { value: "1st place", source: src }, award_text: { value: "$500", source: src } }, history: [], origin: "page" } as Entity;
    expect(trackDetail([...ents, crit, prize], "t1")).toEqual({ requirements: ["must use Acme"], criteria: [{ name: "Depth", description: "How deep" }], descriptions: [], prizes: [{ place: "1st place", award: "$500" }] });
  });
  test("Booths: a track with a gap asks from the gap; a sponsor's questions merge into one block, a shared opening said once", () => {
    const input = { idea: "Hindsight: a transfer planner.", stack: [{ name: "Apify", used_for: "scrape campus calendars" }] };
    const tr = (track_id: string, name: string, evidence: PlanTrack["evidence"], quote: string): PlanTrack => ({ track_id, name, sponsor: "Apify", evidence, label: evidence === "stated" ? null : NOT_STATED, fit: "likely", capped: false, product_names: ["Apify"], reason: "", quote, source_url: "https://e.devpost.com/", steps: [] });
    const actor = tr("actor", "[Apify] Best Actor", "stated", "Project must be using Apify in a meaningful way.");
    const use = tr("use", "[Apify] Best Use of Apify", "title", "[Apify] Best Use of Apify");
    const gap = { track_id: "actor", track: "[Apify] Best Actor", gap: "g", instead: "run Apify's prebuilt Cheerio Scraper", question: "Does Best Actor need a new Actor built this weekend?", requirement: { kind: "requirement" as const, quote: "We have a Best Actor award for building an actor for this event.", source_url: "https://e.devpost.com/" }, project: [{ quote: "Not used: Radar runs Apify's Cheerio Scraper", source: "apps/actor/README.md:7", url: "u" }] };
    const withGap = boothQuestions([actor, use], input, [gap]);
    expect(withGap.map((x) => x.question)).toEqual([
      "We run Apify's prebuilt Cheerio Scraper; does Best Actor need a new Actor built this weekend?",
      "We use Apify to scrape campus calendars; what does ‘Best Use of Apify’ reward beyond that?",
    ]);
    expect(withGap[0]!.grounds).toBe("the gap check: apps/actor/README.md:7 “Not used: Radar runs Apify's Cheerio Scraper”; the page's requirement “We have a Best Actor award for building an actor for this event”");
    expect(boothBlocks(withGap).map((b) => [b.sponsor, b.text])).toEqual([["Apify", `${withGap[0]!.question} ${withGap[1]!.question}`]]);
    expect(boothBlocks(boothQuestions([actor, use], input)).map((b) => b.text)).toEqual(["We use Apify to scrape campus calendars; does that count as ‘Project must be using Apify in a meaningful way’, and what does ‘Best Use of Apify’ reward beyond that?"]);
    const noProduct = { ...input, stack: null, idea: "a planner" };
    expect(boothBlocks(boothQuestions([{ ...use, product_names: ["Zed"] }, { ...use, track_id: "u2", name: "[Apify] Best Design", product_names: ["Zed"] }], noProduct)).map((b) => b.text)).toEqual(["What does ‘Best Use of Apify’ reward, and what does ‘Best Design’ reward?"]);
  });
});
