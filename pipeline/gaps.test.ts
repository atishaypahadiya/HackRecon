import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGaps, copies, gapHash, gapRequest, gapRequirements, shortTrack, inputFacts, planGaps, teamFacts, teamGapLine, type GapCache } from "./gaps.ts";
import { NOT_STATED, type PlanTrack } from "./plan.ts";
import { parseRepoUrl, repoFacts, repoTexts } from "./repo.ts";
import type { Entity } from "./schema.ts";

const src = { kind: "page" as const, url: "https://e.devpost.com/", quote: "", captured_at: "" };
const actor: Entity = {
  id: "actor",
  kind: "track",
  sponsor: "Apify",
  name: { value: "[Apify] Best Actor", source: src },
  fields: {
    "requirements[0]": { value: "We have a Best Actor award for building an actor for this event.", source: src },
    "requirements[1]": { value: "Project must be using Apify in a meaningful way.", source: src },
  },
  history: [],
  origin: "page",
};
const pt = (track_id: string, name: string, fit: PlanTrack["fit"], evidence: PlanTrack["evidence"], steps: PlanTrack["steps"] = []): PlanTrack => ({ track_id, name, sponsor: "Apify", fit, capped: false, product_names: ["Apify"], reason: "", evidence, label: evidence === "stated" ? null : NOT_STATED, quote: "", source_url: "https://e.devpost.com/", steps });
const step = { id: "s1", track_id: "actor", track: "[Apify] Best Actor", step_kind: "description_mention", label: "Building an actor", quote: "We have a Best Actor award for building an actor for this event.", source_url: "https://e.devpost.com/" };
const tracks = [pt("actor", "[Apify] Best Actor", "likely", "stated", [step]), pt("other", "[Apify] Best Use", "possible", "stated")];
const input = { idea: "Hindsight: a transfer planner. It has an Ask assistant.", stack: [{ name: "Apify", used_for: "scrape campus calendars" }] };
const repoLine = { id: "", kind: "repo" as const, source: "api/scan.py:3", url: "https://github.com/o/r/blob/abc/api/scan.py#L3", text: 'ACTOR = "apify/cheerio-scraper"' };

describe("Plan gaps", () => {
  test("Ship's scope checks every entered track, possible ones too", () => {
    expect(gapRequirements(tracks, [actor, { ...actor, id: "other" }], "all").map((r) => r.track_id)).toEqual(["actor", "actor", "other", "other"]);
  });
  test("a rep's requirement is checked on its track whatever its fit, after the page's lines, labeled as told", () => {
    const note = { id: "rep:other#1", track_id: "other", kind: "requirement" as const, text: "the Actor has to be published on the Store", rep: "Sam at the Apify booth", told: { source: "chat" as const, at: "2026-11-14T19:00:00.000Z", quote: "x" } };
    const crit = { ...note, id: "rep:other#2", kind: "criterion" as const, text: "judged on how many runs it gets" };
    expect(gapRequirements(tracks, [actor, { ...actor, id: "other" }], "likely", [note, crit]).map((r) => [r.track_id, r.kind, r.text, r.told_by ?? null])).toEqual([
      ["actor", "requirement", "We have a Best Actor award for building an actor for this event.", null],
      ["actor", "requirement", "Project must be using Apify in a meaningful way.", null],
      ["other", "requirement", "We have a Best Actor award for building an actor for this event.", null],
      ["other", "requirement", "Project must be using Apify in a meaningful way.", null],
      ["other", "told", "the Actor has to be published on the Store", "told to Donna by Sam at the Apify booth"],
    ]);
  });
  test("Plan's scope: likely tracks, plus entered or earlier-checked ones whatever their fit; never every possible track", () => {
    const ents = [actor, { ...actor, id: "other" }, { ...actor, id: "third" }];
    const three = [...tracks, pt("third", "[Apify] 1st Customer", "possible", "stated")];
    const ids = (also: string[]) => [...new Set(gapRequirements(three, ents, "likely", [], new Set(also)).map((r) => r.track_id))];
    expect(ids([])).toEqual(["actor"]);
    // "other" is entered (or was checked when it was likely, and has fallen to possible): it stays checked.
    expect(ids(["other"])).toEqual(["actor", "other"]);
    expect(ids(["other", "unranked-track"])).toEqual(["actor", "other"]);
  });
  test("requirements: likely tracks only, each sentence once (an entry step repeating a requirement isn't asked twice)", () => {
    expect(gapRequirements(tracks, [actor]).map((r) => [r.id, r.kind, r.text])).toEqual([
      ["R1", "requirement", "We have a Best Actor award for building an actor for this event."],
      ["R2", "requirement", "Project must be using Apify in a meaningful way."],
    ]);
  });
  test("project facts: description sentences, then stack lines with their use", () => {
    expect(inputFacts(input).map((f) => [f.id, f.source, f.text])).toEqual([
      ["F1", "your description", "Hindsight: a transfer planner."],
      ["F2", "your description", "It has an Ask assistant."],
      ["F3", "your stack: Apify", "Apify: scrape campus calendars"],
    ]);
  });
  const reqs = gapRequirements(tracks, [actor]);
  const facts = [...inputFacts(input), { ...repoLine, id: "F4" }];
  const ok = { requirement_id: "R1", facts: [{ fact_id: "F4", quote: "apify/cheerio-scraper" }], gap: "Best Actor asks for building an actor; the repository runs Apify's prebuilt Cheerio Scraper.", instead: "run Apify's prebuilt Cheerio Scraper.", question: "Does Best Actor need a new Actor built this weekend?" };
  test("a gap keeps the page's quote from canon and the project's quote with its source and link", () => {
    expect(checkGaps({ gaps: [ok] }, reqs, facts)).toEqual([
      { track_id: "actor", track: "[Apify] Best Actor", gap: ok.gap, instead: "run Apify's prebuilt Cheerio Scraper", question: "Does Best Actor need a new Actor built this weekend?", requirement: { kind: "requirement", quote: "We have a Best Actor award for building an actor for this event.", source_url: "https://e.devpost.com/" }, project: [{ quote: "apify/cheerio-scraper", source: "api/scan.py:3", url: repoLine.url }] },
    ]);
  });
  test("rejected: a quote not in its fact, an unknown id, no project fact, a verdict or advice", () => {
    const err = (g: object) => (checkGaps({ gaps: [{ ...ok, ...g }] }, reqs, facts) as { error?: string }).error ?? "";
    expect(err({ facts: [{ fact_id: "F4", quote: "apify/web-scraper" }] })).toContain("not in F4");
    expect(err({ requirement_id: "R9" })).toContain("not a requirement id");
    expect(err({ facts: [{ fact_id: "F9", quote: "x" }] })).toContain("not a project fact id");
    expect(err({ facts: [] })).toContain("cite 1 to 3");
    for (const gap of ["So it doesn't qualify for Best Actor.", "This won't count as an Actor.", "The project fails the requirement.", "You should build an Actor.", "It isn't eligible."]) expect(err({ gap })).toContain("judges eligibility");
    expect(err({ instead: "We run a scraper" })).toContain("without the");
    expect(err({ instead: "" })).toContain("verb phrase");
    expect(err({ instead: "run a scraper, which doesn't qualify" })).toContain("judges eligibility");
    expect(err({ question: "Does it need a new Actor?" })).toContain('name the track as "Best Actor"');
    expect(err({ question: "Does Best Actor need a new Actor" })).toContain('ending with "?"');
    expect(err({ question: "Best Actor: is it a Best Actor award for building an actor for this event?" })).toContain("own words");
    expect(err({ question: "Does Best Actor still count?" })).toContain("judges eligibility");
  });
  test("nothing to check (no likely track states a requirement): no model call", async () => {
    const r = await planGaps(null, [pt("t", "[X] Best Use of X", "likely", "title")], [actor], input, [], {});
    expect(r).toMatchObject({ gaps: [], checked: 0, from: "none" });
  });
  test("not cached and no API key: an error, never an empty \"no gaps\"", async () => {
    const cache: GapCache = {};
    const first = await planGaps(null, tracks, [actor], input, [repoLine], cache);
    expect("error" in first).toBe(true);
  });
});

test("a track's spoken name, and the copy check", () => {
  expect(["[Apify] Best Actor sponsored by Apify", "[Factory] Best Use of the Factory Droid SDK", "[Figma] Best Design"].map(shortTrack)).toEqual(["Best Actor", "Best Use of the Factory Droid SDK", "Best Design"]);
  expect(copies("does it need building an actor for this event?", "We have a Best Actor award for building an actor for this event.")).toBe(true);
  expect(copies("does Best Actor need a new Actor built this weekend?", "We have a Best Actor award for building an actor for this event.")).toBe(false);
});

describe("Linked repo", () => {
  test("only public GitHub repo links", () => {
    expect(parseRepoUrl("https://github.com/Cal-Hacks-2026/Hindsight")).toEqual({ owner: "Cal-Hacks-2026", name: "Hindsight" });
    expect(parseRepoUrl("https://github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
    expect(["http://github.com/o/r", "https://www.github.com/o/r/"].map(parseRepoUrl)).toEqual([{ owner: "o", name: "r" }, { owner: "o", name: "r" }]);
    for (const u of ["https://gitlab.com/o/r", "https://github.com/o/r/tree/main", "file:///etc", "https://github.com/o"]) expect(parseRepoUrl(u)).toBeNull();
  });
  test("lines naming a product, read from git objects: README first, code next; tests, lockfiles, env files, secret-looking lines, symlinks and binaries skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-repo-"));
    const files: Record<string, string> = {
      "README.md": "# App\nWe scrape with Apify.\n",
      "api/scan.py": 'from apify_client import ApifyClient\nACTOR = "apify/cheerio-scraper"\nAPIFY_TOKEN = "x"\n',
      "tests/test_scan.py": "apify in a test\n",
      "package-lock.json": '"apify": "1"\n',
      ".env.example": "APIFY=1\n",
      "logo.bin": "apify\0binary",
    };
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), t);
    }
    const outside = mkdtempSync(join(tmpdir(), "hr-outside-"));
    writeFileSync(join(outside, "secret.txt"), "apify secret outside the repo\n");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.md"));
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]]) execFileSync("git", args, { cwd: dir });
    const repo = { url: "https://github.com/o/r", dir, sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() };
    const texts = repoTexts(repo);
    expect([texts.has("link.md"), texts.has("logo.bin"), texts.get("README.md")]).toEqual([false, false, "# App\nWe scrape with Apify.\n"]);
    const facts = repoFacts(repo, ["Apify"], texts);
    expect(facts.map((f) => [f.source, f.text])).toEqual([
      ["README.md:2", "We scrape with Apify."],
      ["api/scan.py:2", 'ACTOR = "apify/cheerio-scraper"'],
    ]);
    expect(facts[1]!.url).toBe(`https://github.com/o/r/blob/${repo.sha}/api/scan.py#L2`);
  });
});

describe("gaps with a team (slice 4)", () => {
  const told = { source: "chat" as const, at: "2026-11-14T19:00:00.000Z", quote: "x" };
  const team = [
    { id: "me", name: null, skills: [{ name: "Python", told }], told },
    { id: "priya", name: "Priya", skills: [{ name: "Apify Actors", told }, { name: "TypeScript", told }], told },
    { id: "lee", name: "Lee", skills: [], told },
  ];
  const reqs = gapRequirements(tracks, [actor]);
  const facts = [...inputFacts(input), ...teamFacts(team), repoLine].map((f, k) => ({ ...f, id: `F${k + 1}` }));
  const gap = (skills: { fact_id: string; quote: string }[], cite = "F3") => ({ gaps: [{ requirement_id: "R1", facts: [{ fact_id: cite, quote: "Apify: scrape campus calendars" }], skills, gap: "Best Actor asks for building an Actor; the stack scrapes calendars with Apify.", instead: "run a prebuilt scraper", question: "does Best Actor need a new Actor built this weekend?" }] });
  test("one team fact per person who lists skills; the hacker is \"your skills\"", () => {
    expect(teamFacts(team).map((f) => [f.kind, f.source, f.text])).toEqual([["team", "your skills", "Python"], ["team", "Priya's skills", "Apify Actors, TypeScript"]]);
  });
  test("a skill that covers it: we haven't done it yet, naming who", () => {
    const r = checkGaps(gap([{ fact_id: "F5", quote: "Apify Actors" }]), reqs, facts);
    if ("error" in r) throw new Error(r.error);
    expect(r[0]!.team).toEqual([{ who: "Priya", skill: "Apify Actors" }]);
    expect(teamGapLine(r[0]!.team!)).toBe("we haven't done it yet; Priya lists Apify Actors");
  });
  test("no skill covers it: nobody on the team lists one", () => {
    const r = checkGaps(gap([]), reqs, facts);
    if ("error" in r) throw new Error(r.error);
    expect([r[0]!.team, teamGapLine(r[0]!.team!)]).toEqual([[], "nobody on the team lists a skill for this"]);
  });
  test("a skill is never evidence of a gap, and must be one whole skill as told", () => {
    expect(checkGaps(gap([], "F5"), reqs, facts)).toEqual({ error: "F5 is a team fact: it says what someone can do, not what the project does; cite it in skills, not facts" });
    expect(checkGaps(gap([{ fact_id: "F5", quote: "Apify" }]), reqs, facts)).toEqual({ error: '"Apify" is not one of the skills in F5; quote one skill exactly' });
    expect(checkGaps(gap([{ fact_id: "F3", quote: "Apify" }]), reqs, facts)).toEqual({ error: "F3 is not a team fact" });
  });
  test("with no team told, gaps carry no team line and the check is the same one as before", () => {
    const solo = [...inputFacts(input), repoLine].map((f, k) => ({ ...f, id: `F${k + 1}` }));
    const r = checkGaps(gap([]), reqs, solo);
    if ("error" in r) throw new Error(r.error);
    expect(r[0]!.team).toBeUndefined();
    expect(gapHash(gapRequest(reqs, solo))).not.toBe(gapHash(gapRequest(reqs, solo), true));
  });
});
