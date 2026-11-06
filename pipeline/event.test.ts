import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { eventDir, REPO_ROOT, takeEventArg, UNTRACKED_EVENT_PATHS } from "./event.ts";

const git = (...args: string[]) => spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
const inRepo = git("rev-parse", "--is-inside-work-tree").stdout.trim() === "true";

// D10: workspace content (captures, review, data, fixtures, organizers.json) must never be tracked.
describe.skipIf(!inRepo)("workspace data is never tracked by git", () => {
  const sensitive = (p: string) =>
    /^events\/current(\/|$)/.test(p) ||
    UNTRACKED_EVENT_PATHS.some((u) => {
      const rel = p.match(/^events\/[^/]+\/(.*)$/)?.[1] ?? p; // also covers the pre-v2 root layout
      return u.endsWith("/") ? rel.startsWith(u) : rel === u;
    });

  test("no tracked path under events/*/{captures,review,data,fixtures}/, organizers.json or events/current", () => {
    const tracked = git("ls-files", "-z").stdout.split("\0").filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked.filter(sensitive)).toEqual([]);
  });

  test(".gitignore covers every per-event workspace path", () => {
    const samples = [...UNTRACKED_EVENT_PATHS.map((u) => `events/some-event/${u}${u.endsWith("/") ? "x.json" : ""}`), "events/current"];
    const notIgnored = samples.filter((s) => git("check-ignore", "-q", "--no-index", s).status !== 0);
    expect(notIgnored).toEqual([]);
  });

  test("tracked event config stays tracked-able (event.json, sponsors.json are not ignored)", () => {
    for (const s of ["events/some-event/config/event.json", "events/some-event/config/sponsors.json"]) {
      expect(git("check-ignore", "-q", "--no-index", s).status).not.toBe(0);
    }
  });
});

describe("takeEventArg", () => {
  test("defaults to current and passes other args through", () => {
    expect(takeEventArg(["board", "--build-only"])).toEqual({ slug: "current", rest: ["board", "--build-only"] });
  });
  test("takes --event <slug> and --event=<slug> anywhere", () => {
    expect(takeEventArg(["--event", "calhacks-13", "board"])).toEqual({ slug: "calhacks-13", rest: ["board"] });
    expect(takeEventArg(["board", "--event=treehacks"])).toEqual({ slug: "treehacks", rest: ["board"] });
  });
  test("a bare --event is an error", () => {
    expect(() => takeEventArg(["board", "--event"])).toThrow(/--event needs a slug/);
  });
});

test("eventDir names the fix when the event directory is missing", () => {
  expect(() => eventDir("no-such-event-xyz")).toThrow(/events\/no-such-event-xyz not found/);
});
