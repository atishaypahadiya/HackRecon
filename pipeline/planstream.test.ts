import { describe, expect, test } from "bun:test";
import type { GapResult } from "./gaps.ts";
import type { BoothBlock, PlanSection, PlanTrack } from "./plan.ts";
import { planStream, type PlanEvent, type PlanSteps } from "./planstream.ts";
import type { Repo } from "./repo.ts";

// A fake clock: each step resolves after the given virtual ms, in the order a real run would.
function clock() {
  let t = 0;
  const waits: { at: number; go: () => void }[] = [];
  return {
    now: () => t,
    after<T>(ms: number, v: T): Promise<T> {
      return new Promise((go) => waits.push({ at: t + ms, go: () => go(v) }));
    },
    async run() {
      for (;;) {
        await new Promise((r) => setTimeout(r, 0));
        if (!waits.length) return;
        waits.sort((a, b) => a.at - b.at);
        const w = waits.shift()!;
        t = w.at;
        w.go();
      }
    },
  };
}

const track = (id: string, fit: "likely" | "possible" = "likely") => ({ track_id: id, fit, product_names: ["Apify"] }) as unknown as PlanTrack;
const tracksOk = (from: "cache" | "model"): PlanSection<PlanTrack> => ({ items: [track("t1"), track("t2", "possible")], from, ms: 0, usage: null });
const gapsOk = (repo: number): GapResult => ({ gaps: [], checked: 3, facts: { description: 1, stack: 2, repo }, from: "model", ms: 0, usage: null });
const repo: Repo = { url: "https://github.com/a/b", dir: "/x", sha: "abc1234" };

async function collect(steps: PlanSteps, c: ReturnType<typeof clock>): Promise<PlanEvent[]> {
  const out: PlanEvent[] = [];
  const reading = (async () => {
    for await (const e of planStream({ ...steps, now: c.now })) out.push(e);
  })();
  await c.run();
  await reading;
  return out;
}

describe("planStream (P2, D4: sections stream in when ready)", () => {
  test("tracks and booths go out before the gap check finishes; the repo clones during the ranking", async () => {
    const c = clock();
    const calls: string[] = [];
    const events = await collect(
      {
        tracks: () => (calls.push("tracks"), c.after(4000, tracksOk("model"))),
        repo: () => (calls.push("repo"), c.after(3000, repo)),
        repoLines: (_r, ts) => (calls.push(`lines:${ts.length}`), [{ id: "R1", kind: "repo", source: "a.ts:1", quote: "apify" }] as never),
        gaps: (_ts, lines) => (calls.push(`gaps:${lines.length}`), c.after(5000, gapsOk(lines.length))),
        booths: (_ts, g) => [{ sponsor: g ? "after gaps" : "from tracks" }] as unknown as BoothBlock[],
      },
      c,
    );
    expect(calls.slice(0, 2).sort()).toEqual(["repo", "tracks"]);
    expect(events.map((e) => [e.section, e.ms])).toEqual([["tracks", 4000], ["booths", 4000], ["gaps", 9000], ["booths", 9000], ["done", 9000]]);
    expect(events.at(-1)).toEqual({ section: "done", ms: 9000, first: { section: "tracks", ms: 4000 } });
    expect(events[2]).toMatchObject({ facts: { repo: 1 }, repo: { url: repo.url, commit: "abc1234" } });
  });

  test("a failed gap check or repo leaves the tracks standing; a failed ranking settles every section", async () => {
    const c = clock();
    const logs: string[] = [];
    const a = await collect(
      { tracks: () => c.after(10, tracksOk("cache")), repo: () => c.after(5, { error: "private repo" }), repoLines: () => [], gaps: (_t, lines) => c.after(10, lines.length ? gapsOk(1) : { error: "model down" }), booths: () => [], log: (l) => logs.push(l) },
      c,
    );
    expect(a.map((e) => [e.section, "error" in e])).toEqual([["tracks", false], ["booths", false], ["gaps", true], ["done", false]]);
    expect(logs[0]).toContain("private repo");
    const d = clock();
    const b = await collect({ tracks: () => d.after(10, { error: "no key" }), repo: null, repoLines: () => [], gaps: () => { throw new Error("unreachable"); }, booths: () => [] }, d);
    expect(b.map((e) => [e.section, "error" in e])).toEqual([["tracks", true], ["booths", true], ["gaps", true], ["done", false]]);
    expect(b.at(-1)).toMatchObject({ first: null });
  });

  test("a step that throws still settles the sections it owed", async () => {
    const c = clock();
    const ev = await collect({ tracks: () => c.after(1, tracksOk("cache")), repo: null, repoLines: () => [], gaps: () => Promise.reject(new Error("boom")), booths: () => [] }, c);
    expect(ev.map((e) => e.section)).toEqual(["tracks", "booths", "gaps", "done"]);
    expect(ev[2]).toMatchObject({ error: "failed" });
  });

  test("P3–P5 come after gaps, each on its own; a failed ranking settles them too", async () => {
    const c = clock();
    const joins = {
      credits: () => ({ sponsors: [], credits: [], dropped: 0 }),
      sessions: () => ({ deadline: null, sessions: [] }),
      people: () => {
        throw new Error("boom");
      },
    };
    const base = { repo: null, repoLines: () => [], booths: () => [], joins };
    const ok = await collect({ ...base, tracks: () => c.after(10, tracksOk("cache")), gaps: () => c.after(10, { error: "model down" }) }, c);
    expect(ok.map((e) => [e.section, "error" in e])).toEqual([["tracks", false], ["booths", false], ["gaps", true], ["credits", false], ["sessions", false], ["people", true], ["done", false]]);
    const d = clock();
    const bad = await collect({ ...base, tracks: () => d.after(10, { error: "no key" }), gaps: () => d.after(1, gapsOk(0)) }, d);
    expect(bad.filter((e) => "error" in e).map((e) => e.section)).toEqual(["tracks", "booths", "gaps", "credits", "sessions", "people"]);
  });
});
