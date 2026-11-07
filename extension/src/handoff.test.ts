// Automatic session hand-off (user 2026-11-07): only a known workspace's Slack tab, only its own team, and the
// session only in memory.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromSlackTab, isKnown, pullDue, readSlackSession, remember } from "./handoff.ts";

const TOKEN = "xoxc-1234567890-secret-session-token";
const store = (v: unknown) => ({ getItem: (k: string) => (k === "localConfig_v2" ? JSON.stringify(v) : null) });
const config = { teams: { T0C6: { token: TOKEN, url: "https://cal-hacks-13-0.slack.com/", name: "Cal Hacks 13.0" }, T0EV: { token: TOKEN, url: "https://evil.example/" } } };

describe("readSlackSession", () => {
  test("the team in the tab's URL, from localConfig_v2", () => {
    expect(readSlackSession({ pathname: "/client/T0C6/C0C7TCNCR1N" }, store(config))).toEqual({ token: TOKEN, origin: "https://cal-hacks-13-0.slack.com", team: "T0C6", workspace: "Cal Hacks 13.0" });
  });
  test("nothing for another origin, an odd path, a missing team or broken storage", () => {
    expect(readSlackSession({ pathname: "/client/T0EV" }, store(config))).toBeNull();
    expect(readSlackSession({ pathname: "/client/../x" }, store(config))).toBeNull();
    expect(readSlackSession({ pathname: "/client/T0NONE" }, store(config))).toBeNull();
    expect(readSlackSession({ pathname: "/client/T0C6" }, { getItem: () => "{not json" })).toBeNull();
  });
});

describe("who may hand over a session", () => {
  const id = "ext-id";
  test("our own content script in a Slack client tab, nothing else", () => {
    expect(fromSlackTab({ id, origin: "https://app.slack.com", tab: { url: "https://app.slack.com/client/T0C6/C1" } }, id)).toBe(true);
    expect(fromSlackTab({ id, tab: undefined }, id)).toBe(false); // the popup uses api-start
    expect(fromSlackTab({ id: "other", tab: { url: "https://app.slack.com/client/T0C6" } }, id)).toBe(false);
    expect(fromSlackTab({ id, origin: "https://evil.example", tab: { url: "https://app.slack.com/client/T0C6" } }, id)).toBe(false);
    expect(fromSlackTab({ id, tab: { url: "https://cal-hacks-13-0.slack.com/archives/C1" } }, id)).toBe(false);
  });
  test("known: the user synced that team at that origin once", () => {
    const k = remember([], { team: "T0C6", origin: "https://cal-hacks-13-0.slack.com" });
    expect(remember(k, { team: "T0C6", origin: "https://cal-hacks-13-0.slack.com" })).toBe(k);
    expect(isKnown(k, "T0C6", "https://cal-hacks-13-0.slack.com")).toBe(true);
    expect(isKnown(k, "T0C6", "https://other.slack.com")).toBe(false);
    expect(isKnown(k, "T0XX", "https://cal-hacks-13-0.slack.com")).toBe(false);
    expect(JSON.stringify(k)).not.toContain("xox");
  });
  test("a pull is due now only if none ran or the last began a period ago", () => {
    const P = 30 * 60_000;
    expect(pullDue(undefined, 1_000_000, P)).toBe(0);
    expect(pullDue(1_000_000, 1_000_000 + P, P)).toBe(0);
    expect(pullDue(1_000_000, 1_000_000 + 10 * 60_000, P)).toBe(20 * 60_000);
  });
  test("the session is stored only in chrome.storage.session; the content script stores nothing", () => {
    const code = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const bg = code("background.ts");
    for (const m of bg.matchAll(/chrome\.storage\.local\.set\(\{([^}]*)\}/g)) expect(m[1]).not.toMatch(/slack|token/);
    expect(bg).toMatch(/chrome\.storage\.session\.set\(\{ slack: /);
    const cs = code("slack-session.ts");
    expect(cs).not.toMatch(/chrome\.storage|setItem|fetch\(|console\./);
  });
});
