import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedCapture } from "./captures.ts";
import { buildRun, saveRun } from "./runs.ts";
import { messageId, type CaptureFile, type Message, type Run } from "./schema.ts";

function loaded(name: string, cid: string, started: string, ts: string[]): LoadedCapture {
  const messages: Message[] = ts.map((t) => ({
    id: messageId(cid, t),
    channel_id: cid,
    channel_name: name,
    ts: t,
    author_name: "Ada",
    text: "hi",
    links: [],
    permalink: `https://w.slack.com/archives/${cid}/p${t.replace(".", "")}`,
    captured_at: started,
    run_id: `${cid}-1`,
  }));
  const capture: CaptureFile = {
    schema_version: 1,
    run_id: `${cid}-1`,
    source: "extension",
    channel_id: cid,
    channel_name: name,
    started_at: started,
    finished_at: started,
    stop_reason: "channel_start",
    scroll_steps: 1,
    system_rows_skipped: 0,
    unresolved_authors: [],
    messages,
  };
  return { file: `${cid}.json`, capture, dropped: [] };
}

describe("runs", () => {
  const caps = [
    loaded("spons-b", "C2", "2026-10-27T12:10:00.000Z", ["1792400000.000002"]),
    loaded("spons-a", "C1", "2026-10-27T12:05:00.000Z", ["1792400000.000001", "1792400000.000003"]),
  ];

  test("run record follows sponsors.json order and the earliest start", () => {
    const { run, messages } = buildRun("day1", caps, ["spons-a", "spons-b"]);
    expect(run).toEqual({ run_id: "day1", started_at: "2026-10-27T12:05:00.000Z", channels: ["spons-a", "spons-b"], message_count: 3, source: "extension" });
    expect(new Set(messages.map((m) => m.run_id))).toEqual(new Set(["day1"]));
  });

  test("re-recording the same run id replaces it instead of duplicating", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-runs-"));
    const rp = join(dir, "runs.json");
    const mp = join(dir, "messages.json");
    const first = buildRun("day1", caps, ["spons-a", "spons-b"]);
    saveRun(first.run, first.messages, rp, mp);
    const again = buildRun("day1", caps.slice(1), ["spons-a", "spons-b"]);
    saveRun(again.run, again.messages, rp, mp);
    const other = buildRun("stretch", caps.slice(0, 1), ["spons-a", "spons-b"]);
    saveRun(other.run, other.messages, rp, mp);
    const runs = JSON.parse(readFileSync(rp, "utf8")) as Run[];
    expect(runs.map((r) => [r.run_id, r.message_count])).toEqual([
      ["day1", 2],
      ["stretch", 1],
    ]);
    expect((JSON.parse(readFileSync(mp, "utf8")) as Message[]).length).toBe(3);
  });
});
