import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { GapCache } from "./gaps.ts";
import { recheckGaps, shipTracks, type Git, type ShipGapStore } from "./ship.ts";
import type { Entity } from "./schema.ts";

const src = { kind: "page" as const, url: "https://e.devpost.com/", quote: "", captured_at: "" };
const actor: Entity = {
  id: "actor",
  kind: "track",
  sponsor: "Apify",
  name: { value: "[Apify] Best Actor", source: src },
  fields: { "requirements[0]": { value: "We have a Best Actor award for building an actor for this event.", source: src } },
  history: [],
  origin: "page",
};
const e = { event: "Test Hacks", timezone: "UTC" } as never;

// A local git repo standing in for the clone: one README line names Apify.
const dir = mkdtempSync(join(tmpdir(), "hr-ship-"));
writeFileSync(join(dir, "README.md"), "# App\nWe run Apify's prebuilt Cheerio Scraper.\n");
for (const args of [["init", "-q"], ["add", "README.md"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]]) execFileSync("git", args, { cwd: dir });

// A fake model: counts calls, answers one gap citing the README line (fact F3: after 2 description sentences... see input).
function fakeClient() {
  const calls = { n: 0 };
  const client = {
    messages: {
      stream: (req: { messages: { content: string }[] }) => ({
        finalMessage: async () => {
          calls.n++;
          const factId = /\[(F\d+)\] README\.md:2/.exec(req.messages[0]!.content)![1];
          const text = JSON.stringify({ gaps: [{ requirement_id: "R1", facts: [{ fact_id: factId, quote: "prebuilt Cheerio Scraper" }], gap: "Best Actor asks for building an actor; the README says the app runs Apify's prebuilt Cheerio Scraper.", instead: "run Apify's prebuilt Cheerio Scraper", question: "Does Best Actor need a new Actor built this weekend?" }] });
          return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      }),
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe("Ship: Recheck gaps", () => {
  const input = { idea: "Hindsight: a transfer planner.", stack: [{ name: "Apify", used_for: "scrape campus calendars" }], repo: "https://github.com/o/r" };
  test("entered tracks come from canon; an unknown id is reported, not guessed", () => {
    const r = shipTracks([actor], ["actor", "nope"], e);
    expect([r.tracks.map((t) => [t.track_id, t.product_names]), r.unknown]).toEqual([[["actor", ["Apify"]]], ["nope"]]);
  });
  test("checks the latest commit, then reuses the result until the commit changes", async () => {
    const { tracks } = shipTracks([actor], ["actor"], e);
    let head = "a".repeat(40);
    const checkouts: string[] = [];
    const git: Git = { remoteHead: () => head, checkout: (url) => (checkouts.push(url), { url, dir, sha: head }) };
    const store: ShipGapStore = {};
    const gapCache: GapCache = {};
    const { client, calls } = fakeClient();
    let clock = Date.parse("2026-11-06T20:00:00Z");
    const now = () => new Date(clock);

    const first = await recheckGaps(client, input, tracks, [actor], gapCache, store, { git, now });
    if ("error" in first) throw new Error(first.error);
    expect([first.from, first.commit, first.checked_at, first.checked, first.repo_lines, calls.n, checkouts.length]).toEqual(["checked", head, "2026-11-06T20:00:00.000Z", 1, 1, 1, 1]);
    expect(first.gaps.map((g) => [g.track, g.instead, g.project[0]!.source, g.project[0]!.url])).toEqual([["[Apify] Best Actor", "run Apify's prebuilt Cheerio Scraper", "README.md:2", `https://github.com/o/r/blob/${head}/README.md#L2`]]);

    clock += 3_600_000;
    const second = await recheckGaps(client, input, tracks, [actor], gapCache, store, { git, now });
    if ("error" in second) throw new Error(second.error);
    expect([second.from, second.checked_at, second.latest_at, calls.n, checkouts.length]).toEqual(["reused", "2026-11-06T20:00:00.000Z", "2026-11-06T21:00:00.000Z", 1, 1]);

    head = "b".repeat(40);
    const third = await recheckGaps(client, input, tracks, [actor], gapCache, store, { git, now });
    if ("error" in third) throw new Error(third.error);
    expect([third.from, third.commit, third.checked_at, checkouts.length]).toEqual(["checked", head, "2026-11-06T21:00:00.000Z", 2]);
    // Same lines at the new commit: the gap check's own cache answers (no model call), with links at the new commit.
    expect([calls.n, third.gaps[0]!.project[0]!.url]).toEqual([1, `https://github.com/o/r/blob/${head}/README.md#L2`]);
  });
  test("an unreachable repo is an error, never an empty gap list", async () => {
    const git: Git = { remoteHead: () => ({ error: "couldn't reach https://github.com/o/r" }), checkout: () => ({ error: "x" }) };
    expect(await recheckGaps(null, input, shipTracks([actor], ["actor"], e).tracks, [actor], {}, {}, { git })).toEqual({ error: "couldn't reach https://github.com/o/r" });
  });
});
