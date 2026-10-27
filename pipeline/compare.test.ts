import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareChannel } from "./compare.ts";
import { DEFAULT_EXPORT_DIR, expectedAuthorNames, isChannelVisible, loadExport, readChannel, rowClass, type ExportMessage } from "./export.ts";
import { messageId, type CaptureFile, type Message } from "./schema.ts";

const CID = "C0TEST";
const ORIGIN = "https://w.slack.com";

function fakeExport(day: ExportMessage[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hr-export-"));
  writeFileSync(join(dir, "channels.json"), JSON.stringify([{ id: CID, name: "spons-x" }]));
  writeFileSync(
    join(dir, "users.json"),
    JSON.stringify([{ id: "U2", name: "bob2", real_name: "Bob Real", profile: { display_name: "[Figma] Bob", real_name: "Bob Real" } }]),
  );
  mkdirSync(join(dir, "spons-x"));
  writeFileSync(join(dir, "spons-x", "2026-10-24.json"), JSON.stringify(day));
  return dir;
}

function msg(ts: string, author: string, text = "hi"): Message {
  return {
    id: messageId(CID, ts),
    channel_id: CID,
    channel_name: "spons-x",
    ts,
    author_name: author,
    text,
    links: [],
    permalink: `${ORIGIN}/archives/${CID}/p${ts.replace(".", "")}`,
    captured_at: "2026-10-27T12:00:00.000Z",
    run_id: "r",
  };
}

function cap(messages: Message[], seconds = 60): CaptureFile {
  return {
    schema_version: 1,
    run_id: "r",
    source: "extension",
    channel_id: CID,
    channel_name: "spons-x",
    started_at: "2026-10-27T12:00:00.000Z",
    finished_at: new Date(Date.parse("2026-10-27T12:00:00.000Z") + seconds * 1000).toISOString(),
    stop_reason: "channel_start",
    scroll_steps: 4,
    system_rows_skipped: 1,
    unresolved_authors: [],
    messages,
  };
}

const CUTOFF = Date.parse("2026-10-27T03:17:00-07:00") / 1000;

describe("compareChannel (synthetic export)", () => {
  const exp = loadExport(
    fakeExport([
      { ts: "1792400000.000001", user: "U1", user_profile: { display_name: "Ada", real_name: "Ada L" }, text: "real 1" },
      { ts: "1792400000.000002", user: "U2", text: "real 2, profile only in users.json" },
      { ts: "1792400000.000003", user: "U1", user_profile: { display_name: "Ada" }, text: "real 3, missed" },
      { ts: "1792400000.000004", subtype: "channel_join", user: "U3", text: "<@U3> has joined the channel" },
      { ts: "1792400000.000005", subtype: "bot_message", user: "USLACKBOT", username: "slackbot", text: "X from Moss was added" },
      { ts: "1792400000.000006", thread_ts: "1792400000.000001", user: "U2", text: "a reply" },
    ]),
  );
  const r = compareChannel(
    cap([
      msg("1792400000.000001", "Ada"),
      msg("1792400000.000002", "[Figma] Bob"),
      msg("1792400000.000004", "Cy"),
      msg("1792400000.000005", "Slackbot"),
      msg("1792400000.000006", "[Figma] Bob"),
      msg("1793200000.000001", "Ada", "after the export"),
      msg("1792300000.000001", "Ada", "unknown"),
    ]),
    exp,
    CUTOFF,
  );

  test("keyed recall counts only real top-level posts", () => {
    expect(r.export_top_level).toEqual({ real: 3, bot: 1, system: 1 });
    expect(r.matched_real).toBe(2);
    expect(r.keyed_recall).toBeCloseTo(2 / 3);
    expect(r.pass.recall).toBe(false);
  });

  test("missed messages come with their permalink", () => {
    expect(r.missed).toEqual([
      { ts: "1792400000.000003", class: "real", permalink: `${ORIGIN}/archives/${CID}/p1792400000000003`, author: "Ada", text: "real 3, missed" },
    ]);
  });

  test("bot posts are matched separately from recall", () => {
    expect(r.bot_captured).toBe(1);
  });

  test("extras are classified", () => {
    expect(r.extras.map((e) => [e.ts, e.why, e.subtype])).toEqual([
      ["1792400000.000004", "system_leak", "channel_join"],
      ["1792400000.000006", "thread_reply", undefined],
      ["1793200000.000001", "after_export", undefined],
      ["1792300000.000001", "not_in_export", undefined],
    ]);
  });

  test("author match uses message profile, users.json, and bot username", () => {
    expect(r.author).toMatchObject({ checked: 3, matched: 3, rate: 1, mismatches: [] });
  });

  test("author mismatches are listed with what the export expected", () => {
    const bad = compareChannel(cap([msg("1792400000.000001", "Someone Else")]), exp, CUTOFF);
    expect(bad.author.mismatches).toEqual([{ ts: "1792400000.000001", captured: "Someone Else", expected: ["Ada", "Ada L"] }]);
    expect(bad.pass.author).toBe(false);
  });

  test("posters the export can't name are unverifiable, but must get one consistent name", () => {
    const e = loadExport(
      fakeExport([
        { ts: "1792400000.000001", user: "UEXT", text: "slack connect 1" },
        { ts: "1792400000.000002", user: "UEXT", text: "slack connect 2" },
      ]),
    );
    const one = compareChannel(cap([msg("1792400000.000001", "[Moss] Kim"), msg("1792400000.000002", "[Moss] Kim")]), e, CUTOFF);
    expect(one.author).toMatchObject({ checked: 0, unverifiable: [{ user: "UEXT", posts: 2, captured_names: ["[Moss] Kim"] }] });
    expect(one.pass.author).toBe(true);
    const split = compareChannel(cap([msg("1792400000.000001", "[Moss] Kim"), msg("1792400000.000002", "Ada")]), e, CUTOFF);
    expect(split.pass.author).toBe(false);
  });

  test("broadcasts are their own class: found, author-checked, and flagged if unmarked", () => {
    const e = loadExport(
      fakeExport([
        { ts: "1792400000.000001", user: "U2", text: "parent" },
        { ts: "1792400000.000002", thread_ts: "1792400000.000001", subtype: "thread_broadcast", user: "U2", text: "also sent" },
        { ts: "1792400000.000003", thread_ts: "1792400000.000001", subtype: "thread_broadcast", user: "U2", text: "missed" },
      ]),
    );
    const marked = { ...msg("1792400000.000002", "[Figma] Bob"), thread_ts: "1792400000.000001", subtype: "thread_broadcast" as const };
    const r = compareChannel(cap([msg("1792400000.000001", "[Figma] Bob"), marked]), e, CUTOFF);
    expect(r).toMatchObject({ export_broadcasts: 2, broadcast_captured: 1, keyed_recall: 1, extras: [] });
    expect(r.missed.map((m) => [m.ts, m.class])).toEqual([["1792400000.000003", "broadcast"]]);
    expect(r.author.checked).toBe(2);
    const unmarked = compareChannel(cap([msg("1792400000.000002", "[Figma] Bob")]), e, CUTOFF);
    expect(unmarked.extras.map((x) => x.why)).toEqual(["broadcast_unmarked"]);
  });

  test("time over 2 minutes is flagged but separate", () => {
    expect(compareChannel(cap([], 150), exp, CUTOFF).pass.time).toBe(false);
  });
});

// Against the real baseline: a capture built from the export itself, minus two posts.
describe.skipIf(!existsSync(DEFAULT_EXPORT_DIR))("compareChannel (real export, spons-convex)", () => {
  test("recall and authors line up when the capture is the export minus two posts", () => {
    const exp = loadExport();
    const cid = [...exp.channelsById].find(([, n]) => n === "spons-convex")![0];
    const top = readChannel(exp, "spons-convex").filter(isChannelVisible).filter((m) => rowClass(m) !== "system");
    const keep = top.slice(2);
    const c = cap(
      keep.map((m) => ({
        ...msg(m.ts, expectedAuthorNames(exp, m)[0]!),
        id: messageId(cid, m.ts),
        channel_id: cid,
        ...(rowClass(m) === "broadcast" ? { thread_ts: m.thread_ts, subtype: "thread_broadcast" as const } : {}),
      })),
    );
    c.channel_id = cid;
    const r = compareChannel(c, exp, CUTOFF);
    const real = top.filter((m) => rowClass(m) === "real").length;
    expect(r.missed.map((m) => m.ts)).toEqual(top.slice(0, 2).map((m) => m.ts));
    expect(r.matched_real).toBe(real - top.slice(0, 2).filter((m) => rowClass(m) === "real").length);
    expect(r.broadcast_captured).toBe(r.export_broadcasts);
    expect(r.author.rate).toBe(1);
    expect(r.extras).toEqual([]);
  });
});
