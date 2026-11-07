import { describe, expect, test } from "bun:test";
import { boothBlocks, boothQuestions, NOT_STATED, type PlanTrack } from "./plan.ts";

// Design review 2026-11-06: a sponsor with a gap question and a reward question showed both in one paragraph. The
// board now shows one line per question; Copy still copies the block's text.
describe("Booth block lines", () => {
  const input = { idea: "Hindsight: a transfer planner.", stack: [{ name: "Apify", used_for: "scrape campus calendars" }] };
  const tr = (track_id: string, name: string, evidence: PlanTrack["evidence"], quote: string): PlanTrack => ({ track_id, name, sponsor: "Apify", evidence, label: evidence === "stated" ? null : NOT_STATED, fit: "likely", capped: false, product_names: ["Apify"], reason: "", quote, source_url: "https://e.devpost.com/", steps: [] });
  const actor = tr("actor", "[Apify] Best Actor", "stated", "Project must be using Apify in a meaningful way.");
  const use = tr("use", "[Apify] Best Use of Apify", "title", "[Apify] Best Use of Apify");
  const gap = { track_id: "actor", track: "[Apify] Best Actor", gap: "g", instead: "run Apify's prebuilt Cheerio Scraper", question: "Does Best Actor need a new Actor built this weekend?", requirement: { kind: "requirement" as const, quote: "We have a Best Actor award for building an actor for this event.", source_url: "https://e.devpost.com/" }, project: [{ quote: "Not used: Radar runs Apify's Cheerio Scraper", source: "apps/actor/README.md:7", url: "u" }] };

  test("two openings give two lines; the text is the lines joined", () => {
    const [b] = boothBlocks(boothQuestions([actor, use], input, [gap]));
    expect(b!.lines).toEqual([
      "We run Apify's prebuilt Cheerio Scraper; does Best Actor need a new Actor built this weekend?",
      "We use Apify to scrape campus calendars; what does ‘Best Use of Apify’ reward beyond that?",
    ]);
    expect(b!.text).toBe(b!.lines.join(" "));
  });

  test("a shared opening stays one line", () => {
    const [b] = boothBlocks(boothQuestions([actor, use], input));
    expect(b!.lines).toHaveLength(1);
    expect(b!.text).toBe(b!.lines[0]!);
  });
});
