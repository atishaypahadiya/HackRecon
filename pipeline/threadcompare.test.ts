import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareThreads, threadTotals } from "./compare.ts";
import { DEFAULT_EXPORT_DIR } from "./event.ts";
import { loadExport, readChannel, type ExportMessage } from "./export.ts";
import { messageId, parseThreadCaptureFile, type Message, type ThreadCaptureFile, type ThreadRun } from "./schema.ts";

const CID = "C0TEST";
const P1 = "1761300000.000100", P2 = "1761300100.000100", P3 = "1761300200.000100";

function fakeExport(day: ExportMessage[], other: ExportMessage[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "hr-threads-"));
  writeFileSync(join(dir, "channels.json"), JSON.stringify([{ id: CID, name: "spons-x" }, { id: "C0OTHER", name: "spons-y" }]));
  writeFileSync(join(dir, "users.json"), JSON.stringify([{ id: "U1", name: "ann", real_name: "Ann Lee", profile: { display_name: "Ann", real_name: "Ann Lee" } }]));
  for (const [ch, rows] of [["spons-x", day], ["spons-y", other]] as const) {
    mkdirSync(join(dir, ch));
    writeFileSync(join(dir, ch, "2026-10-24.json"), JSON.stringify(rows));
  }
  return dir;
}

const reply = (ts: string, parent: string, extra: Partial<ExportMessage> = {}): ExportMessage => ({ ts, thread_ts: parent, user: "U1", text: `r ${ts}`, ...extra });

function msg(ts: string, parent: string, author = "Ann", subtype?: "thread_broadcast"): Message {
  return { id: messageId(CID, ts), channel_id: CID, channel_name: "spons-x", ts, thread_ts: parent, ...(subtype ? { subtype } : {}), author_name: author, text: "x", links: [], permalink: "https://w.slack.com/x", captured_at: "2026-11-06T12:00:00.000Z", run_id: "t" };
}

function file(threads: ThreadRun[]): ThreadCaptureFile {
  return { schema_version: 1, kind: "threads", run_id: "t", source: "extension", channel_id: CID, channel_name: "spons-x", started_at: "2026-11-06T12:00:00.000Z", finished_at: "2026-11-06T12:01:30.000Z", budget: "uncapped", threads };
}

const CUTOFF = Date.parse("2026-10-27T03:17:00-07:00") / 1000;

describe("compareThreads (synthetic export)", () => {
  const exp = loadExport(
    fakeExport([
      { ts: P1, thread_ts: P1, user: "U1", text: "parent 1", reply_count: 3 },
      reply("1761300001.000100", P1),
      reply("1761300002.000100", P1),
      reply("1761300003.000100", P1, { subtype: "thread_broadcast" }),
      { ts: P2, thread_ts: P2, user: "U1", text: "parent 2", reply_count: 1 },
      reply("1761300101.000100", P2),
      { ts: P3, thread_ts: P3, user: "U1", text: "parent 3", reply_count: 1 },
      reply("1761300201.000100", P3),
      { ts: "1761300300.000100", user: "U1", text: "plain post" },
    ]),
  );

  test("recall counts replies, not sent-to-channel copies; each miss says why", () => {
    const r = compareThreads(
      file([
        { thread_ts: P1, reply_count_shown: 3, stop_reason: "parent_seen", replies: [msg("1761300001.000100", P1), msg("1761300003.000100", P1, "Ann", "thread_broadcast")] },
        { thread_ts: P2, reply_count_shown: 2, stop_reason: "not_opened", note: "pane didn't open", replies: [] },
      ]),
      exp,
      CUTOFF,
    );
    expect([r.export_replies, r.matched, r.recall]).toEqual([4, 1, 0.25]);
    expect(r.missed.map((m) => [m.ts, m.why])).toEqual([
      ["1761300002.000100", "in_pane"],
      ["1761300101.000100", "not_opened"],
      ["1761300201.000100", "not_attempted"],
    ]);
    expect([r.threads_in_export, r.threads_attempted, r.threads_opened, r.broadcasts_seen]).toEqual([3, 2, 1, 1]);
    expect(r.count_mismatches).toEqual([{ thread_ts: P2, shown: 2, export: 1 }]);
    expect(r.stop_reasons).toEqual({ parent_seen: 1, not_opened: 1 });
    expect(r.missed[0]!.permalink).toBe(`https://app.slack.com/archives/${CID}/p1761300002000100?thread_ts=${P1}&cid=${CID}`);
    expect(r.pass.recall).toBe(false);
  });

  test("extras: wrong parent, a channel post, after the export, unknown; authors checked against the export", () => {
    const r = compareThreads(
      file([
        {
          thread_ts: P1,
          reply_count_shown: null,
          stop_reason: "no_new_keys",
          replies: [msg("1761300001.000100", P1, "Someone Else"), msg("1761300002.000100", P1), msg("1761300101.000100", P1), msg("1761300300.000100", P1), msg("1799999999.000100", P1), msg("1761300999.000100", P1)],
        },
      ]),
      exp,
      CUTOFF,
    );
    expect(r.extras.map((x) => [x.ts, x.why])).toEqual([
      ["1761300101.000100", "wrong_parent"],
      ["1761300300.000100", "top_level"],
      ["1799999999.000100", "after_export"],
      ["1761300999.000100", "not_in_export"],
    ]);
    expect([r.matched, r.author.checked, r.author.matched]).toEqual([2, 2, 1]);
    expect(r.author.mismatches[0]).toMatchObject({ ts: "1761300001.000100", captured: "Someone Else" });
  });

  test("totals: a channel with no thread file counts all its replies as missed", () => {
    const exp2 = loadExport(fakeExport([{ ts: P1, thread_ts: P1, user: "U1" }, reply("1761300001.000100", P1)], [{ ts: P2, thread_ts: P2, user: "U1" }, reply("1761300101.000100", P2), reply("1761300102.000100", P2)]));
    const r = compareThreads(file([{ thread_ts: P1, reply_count_shown: 1, stop_reason: "parent_seen", replies: [msg("1761300001.000100", P1)] }]), exp2, CUTOFF);
    const t = threadTotals(exp2, ["spons-x", "spons-y"], [r]);
    expect(t).toMatchObject({ replies: 3, matched: 1, uncaptured: ["spons-y"], pass: false });
  });
});

describe("parseThreadCaptureFile", () => {
  test("accepts a valid file and rejects a reply filed under another parent", () => {
    const ok = file([{ thread_ts: P1, reply_count_shown: 1, stop_reason: "parent_seen", replies: [msg("1761300001.000100", P1)] }]);
    expect(parseThreadCaptureFile(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    const bad = file([{ thread_ts: P1, reply_count_shown: 1, stop_reason: "parent_seen", replies: [msg("1761300001.000100", P2)] }]);
    expect(() => parseThreadCaptureFile(bad)).toThrow(`threads.threads[0].replies[0].thread_ts: expected ${P1}`);
    expect(() => parseThreadCaptureFile({ ...ok, budget: "lots" })).toThrow("threads.budget");
    expect(() => parseThreadCaptureFile({ ...ok, threads: [{ ...ok.threads[0], stop_reason: "gave_up" }] })).toThrow("stop_reason");
  });
});

describe.skipIf(!existsSync(DEFAULT_EXPORT_DIR))("thread baseline (real export)", () => {
  test("the locked 25 hold 494 replies, the number the step-1 gate is measured on", () => {
    const exp = loadExport();
    const sponsors = JSON.parse(require("node:fs").readFileSync("events/calhacks-13/config/sponsors.json", "utf8")) as Record<string, { stretch?: boolean }>;
    const locked = Object.keys(sponsors).filter((k) => !sponsors[k]!.stretch);
    expect(locked).toHaveLength(25);
    expect(threadTotals(exp, locked, [])).toMatchObject({ replies: 494, matched: 0 });
    expect(readChannel(exp, "cohost-anthropic").length).toBeGreaterThan(0);
  });
});
