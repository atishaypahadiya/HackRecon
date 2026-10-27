import { describe, expect, test } from "bun:test";
import { Accumulator, NO_NEW_KEYS_STEPS, StopRule, type RawRow, type Sender } from "./accumulate.ts";
import { channelFromPermalink, permalinkFor, tsFromAttr, tsFromPermalink } from "./permalink.ts";

const origin = "https://w.slack.com";
function msg(ts: string, sender: Sender | null, text = `m${ts}`): RawRow {
  return { kind: "message", ts, sender, text, links: [], permalink: permalinkFor(origin, "C1", ts) };
}
function sys(ts: string, sender: Sender | null): RawRow {
  return { kind: "system", ts, sender, text: "joined #spons-x.", links: [], permalink: permalinkFor(origin, "C1", ts) };
}
const ada: Sender = { name: "Ada" };
const bob: Sender = { name: "[Figma] Bob", external: true };
const t = (n: number) => `17915916${String(n).padStart(2, "0")}.000000`;

describe("permalink", () => {
  test("ts from the p-form permalink (plan example)", () => {
    expect(tsFromPermalink("https://calhacks.slack.com/archives/C0C7TCNCR1N/p1791591648310369")).toBe("1791591648.310369");
  });
  test("ts survives a thread query string", () => {
    expect(tsFromPermalink("/archives/C1/p1791591648310369?thread_ts=1791591600.000100&cid=C1")).toBe("1791591648.310369");
  });
  test("non-permalinks give null", () => {
    expect(tsFromPermalink("https://x.dev/p1791591648310369")).toBeNull();
    expect(tsFromPermalink("/archives/C1/p17915916483103")).toBeNull();
  });
  test("channel id and round trip", () => {
    const p = permalinkFor(origin, "C0C7TCNCR1N", "1791591648.310369");
    expect(channelFromPermalink(p)).toBe("C0C7TCNCR1N");
    expect(tsFromPermalink(p)).toBe("1791591648.310369");
  });
  test("attribute ts must have the exact Slack shape", () => {
    expect(tsFromAttr("1791591648.310369")).toBe("1791591648.310369");
    expect(tsFromAttr("1791591648.31")).toBeNull();
    expect(tsFromAttr(null)).toBeNull();
  });
});

describe("Accumulator", () => {
  test("grouped posts carry the header author forward", () => {
    const a = new Accumulator();
    a.ingest([msg(t(1), ada), msg(t(2), null), msg(t(3), bob), msg(t(4), null)]);
    const out = a.finalize();
    expect(out.messages.map((m) => m.sender.name)).toEqual(["Ada", "Ada", "[Figma] Bob", "[Figma] Bob"]);
    expect(out.unresolvedAuthors).toEqual([]);
  });

  test("carry-forward across a scroll-batch boundary", () => {
    const a = new Accumulator();
    // Newest batch first (we scroll up): t3 is grouped, its header row t2 isn't rendered yet.
    a.ingest([msg(t(3), null), msg(t(4), bob)]);
    expect(a.finalize().unresolvedAuthors).toEqual([t(3)]);
    // The next batch renders t2 directly above t3.
    a.ingest([msg(t(1), bob), msg(t(2), ada), msg(t(3), null)]);
    const out = a.finalize();
    expect(out.messages.find((m) => m.ts === t(3))!.sender.name).toBe("Ada");
    expect(out.unresolvedAuthors).toEqual([]);
  });

  test("chains of grouped posts resolve through several rows", () => {
    const a = new Accumulator();
    a.ingest([msg(t(1), ada), msg(t(2), null)]);
    a.ingest([msg(t(2), null), msg(t(3), null), msg(t(4), null)]);
    expect(a.finalize().messages.map((m) => m.sender.name)).toEqual(["Ada", "Ada", "Ada", "Ada"]);
  });

  test("system rows are skipped and counted, but still act as author headers", () => {
    const a = new Accumulator();
    a.ingest([sys(t(1), ada), msg(t(2), null), sys(t(3), bob), sys(t(4), null)]);
    const out = a.finalize();
    expect(out.messages.map((m) => [m.ts, m.sender.name])).toEqual([[t(2), "Ada"]]);
    expect(out.systemRowsSkipped).toBe(3);
  });

  test("bot posts are kept with their bot flag", () => {
    const a = new Accumulator();
    a.ingest([msg(t(1), { name: "Slackbot", bot: true }), msg(t(2), ada)]);
    const out = a.finalize();
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]!.sender).toEqual({ name: "Slackbot", bot: true });
  });

  test("a divider breaks grouping instead of borrowing an author across it", () => {
    const a = new Accumulator();
    a.ingest([msg(t(1), ada), { kind: "divider" }, msg(t(2), null)]);
    expect(a.finalize().unresolvedAuthors).toEqual([t(2)]);
  });

  test("dedupes on ts and keeps the fullest re-render", () => {
    const a = new Accumulator();
    a.ingest([msg(t(1), ada, "short")]);
    a.ingest([msg(t(1), null, "short, now with unfurl text")]);
    const out = a.finalize();
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.sender.name).toBe("Ada");
    expect(out.messages[0]!.text).toBe("short, now with unfurl text");
    expect(a.size).toBe(1);
  });

  test("records the channel-start header", () => {
    const a = new Accumulator();
    a.ingest([{ kind: "channel_start" }, msg(t(1), ada)]);
    expect(a.sawChannelStart).toBe(true);
    expect(a.finalize().messages).toHaveLength(1);
  });
});

describe("StopRule", () => {
  test("channel start is the primary stop", () => {
    const r = new StopRule();
    expect(r.step(10, false)).toBeNull();
    expect(r.step(20, true)).toBe("channel_start");
  });

  test(`falls back after ${NO_NEW_KEYS_STEPS} steps with no new keys`, () => {
    const r = new StopRule();
    expect(r.step(10, false)).toBeNull();
    for (let i = 1; i < NO_NEW_KEYS_STEPS; i++) expect(r.step(10, false)).toBeNull();
    expect(r.step(10, false)).toBe("no_new_keys");
  });

  test("new keys reset the quiet count", () => {
    const r = new StopRule();
    r.step(10, false);
    for (let i = 1; i < NO_NEW_KEYS_STEPS; i++) r.step(10, false);
    expect(r.step(11, false)).toBeNull();
    for (let i = 1; i < NO_NEW_KEYS_STEPS; i++) expect(r.step(11, false)).toBeNull();
    expect(r.step(11, false)).toBe("no_new_keys");
  });
});
