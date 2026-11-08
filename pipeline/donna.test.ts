// Donna's question routing and her read-only view of the hacker's past events (user 2026-11-08).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, CHAT_DEEP_MODEL, CHAT_MODEL, chatRequest, pastLines, readPastEvents, routeQuestion, type AgentData } from "./agent.ts";
import { callOf, COST_LIMIT_USD, estimateUsd } from "./costguard.ts";

describe("routeQuestion", () => {
  test("short factual questions stay on the quick model", () => {
    for (const q of ["when is judging?", "where is the Modal workshop", "what hackathons have I done?", "what am I building?", "is there food tonight", "what's the submission deadline"]) expect([q, routeQuestion(q)]).toEqual([q, "quick"]);
  });
  test("strategy, planning and judgment go deep", () => {
    for (const q of ["which track should I enter?", "help me plan the next 6 hours", "what's my best bet for a prize?", "should I add Exa to the stack?", "compare Modal vs Tinker for the training runs", "what did I learn from Cal Hacks that I should do differently?", "how can I win the Exa challenge"]) expect([q, routeQuestion(q)]).toEqual([q, "deep"]);
  });
  test("a long question goes deep whatever its words", () => {
    expect(routeQuestion(Array(30).fill("word").join(" "))).toBe("deep");
  });
  test("the request uses the routed model, and a deep answer's estimate still fits the session limit many times over", () => {
    const base = { history: [], context: "x".repeat(60_000), eventName: "Iterate", tz: "America/Los_Angeles" };
    expect(chatRequest({ ...base, question: "when is judging?" }).model).toBe(CHAT_MODEL);
    const deep = chatRequest({ ...base, question: "which track should I enter?" });
    expect(deep.model).toBe(CHAT_DEEP_MODEL);
    expect(estimateUsd([callOf(deep)]) * 8).toBeLessThan(COST_LIMIT_USD);
    expect(chatRequest({ ...base, question: "which track should I enter?", route: "quick" }).model).toBe(CHAT_MODEL);
  });
});

describe("readPastEvents: the hacker's own history, read-only", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "hr-past-"));
    const ev = (slug: string, cfg: object) => {
      mkdirSync(join(root, slug, "config"), { recursive: true });
      writeFileSync(join(root, slug, "config/event.json"), JSON.stringify(cfg));
      return join(root, slug);
    };
    const old = ev("calhacks-13", { event: "Cal Hacks 13.0", timezone: "America/Los_Angeles", schedule: [{ what: "Submissions due", at: "2026-10-25T09:00:00-07:00", source: "x" }] });
    mkdirSync(join(old, "fixtures/dogfood"), { recursive: true });
    writeFileSync(
      join(old, "fixtures/dogfood/hindsight.json"),
      JSON.stringify({ idea: "Hindsight: a transfer planner.", stack: [{ name: "Apify", used_for: "scrape calendars" }, { name: "Figma", used_for: null }], targeted: ["Apify"], entered: ["[Apify] Best Use of Apify"], entered_source: "user, 2026-11-06: Figma was selected but not submitted", result: "no track prizes", repo: "https://github.com/x/Hindsight" }),
    );
    writeFileSync(join(old, "fixtures/dogfood/broken.json"), "{not json");
    const cur = ev("iterate-2026", { event: "Iterate", timezone: "America/Los_Angeles", schedule: [] });
    symlinkSync("iterate-2026", join(root, "current"));
    return { root, old, cur };
  };

  test("every event but the current one (by path or through the current symlink), with its project record", () => {
    const { root, cur } = setup();
    try {
      for (const here of [cur, join(root, "current")]) {
        const past = readPastEvents(root, here);
        expect(past.map((e) => [e.slug, e.event, e.when])).toEqual([["calhacks-13", "Cal Hacks 13.0", "October 2026"]]);
        expect(past[0]!.projects).toEqual([{ name: "Hindsight", idea: "Hindsight: a transfer planner.", stack: ["Apify (scrape calendars)", "Figma"], targeted: ["Apify"], entered: ["[Apify] Best Use of Apify"], entered_note: "Figma was selected but not submitted", result: "no track prizes", devpost: null, repo: "https://github.com/x/Hindsight" }]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reading writes nothing: the past event's files are unchanged after a read", () => {
    const { root, old, cur } = setup();
    try {
      const snap = () => readdirSync(old, { recursive: true }).map((f) => `${f}:${statSync(join(old, String(f))).mtimeMs}`).sort();
      const before = snap();
      readPastEvents(root, cur);
      expect(snap()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the context keeps past events in their own block, labeled as history, apart from this event's data", () => {
    const { root, cur } = setup();
    try {
      const d: AgentData = { nowMs: Date.parse("2026-11-14T18:00:00Z"), tz: "America/Los_Angeles", event: null, plan: null, messages: [], items: [], alerts: [], slackAuthority: new Set(), guildNames: {}, redact: (t) => ({ text: t, replaced: 0 }), past: readPastEvents(root, cur) };
      const ctx = buildContext(d, "b");
      const lines = pastLines(d.past!);
      expect(lines[0]).toContain("never a source for this event's schedule, tracks, prizes or rules");
      expect(lines[1]).toBe("- Cal Hacks 13.0 (October 2026): built Hindsight. Hindsight: a transfer planner. Stack: Apify (scrape calendars); Figma. Sponsors targeted: Apify. Tracks entered: [Apify] Best Use of Apify (your note: Figma was selected but not submitted). Result: no track prizes. Repo: https://github.com/x/Hindsight");
      expect(ctx).toContain(lines.join("\n"));
      expect(ctx.indexOf(lines[0]!)).toBeLessThan(ctx.indexOf("Posts, newest first"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
