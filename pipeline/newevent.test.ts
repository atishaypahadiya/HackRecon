// A brand-new event (Iterate, 2026-11-08): config only, no posts, no organizer list, no tracks yet. `hr plan` must
// save the Plan (idea, stack, no tracks) without a model call, so Donna can answer from it before the event starts.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function newEvent(dir: string, extra: Record<string, unknown> = {}): string {
  const ev = join(dir, "new-event");
  mkdirSync(join(ev, "config"), { recursive: true });
  writeFileSync(join(ev, "config/event.json"), JSON.stringify({ event: "New Event", timezone: "America/Los_Angeles", hacking_start: null, hacking_end: null, schedule: [], ...extra }));
  writeFileSync(join(ev, "config/sponsors.json"), "{}");
  return ev;
}

test("hr sync on an event with no Slack posts runs from event.json's pages instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hr-new-event-"));
  try {
    const ev = newEvent(dir, { canon_pages: ["https://luma.com/abc"], schedule_pages: ["https://luma.com/abc"] });
    const r = spawnSync("bun", [join(import.meta.dir, "hr.ts"), "sync", "--offline", "--event", ev], { cwd: dir, encoding: "utf8" });
    expect(r.stderr).not.toContain("messages.json not found");
    expect(r.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hr plan on an event with no posts and no tracks saves the Plan with no model call", () => {
  const dir = mkdtempSync(join(tmpdir(), "hr-new-event-"));
  try {
    const ev = newEvent(dir);
    // No API key, and run from a directory with no .env: any model call would fail the command.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ANTHROPIC_API_KEY"));
    const r = spawnSync("bun", [join(import.meta.dir, "hr.ts"), "plan", "--idea", "agents that run experiments", "--event", ev], { cwd: dir, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Tracks to target: none yet");
    const plan = JSON.parse(readFileSync(join(ev, "data/plan.json"), "utf8"));
    expect([plan.input, plan.tracks]).toEqual([{ idea: "agents that run experiments", stack: null }, []]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
