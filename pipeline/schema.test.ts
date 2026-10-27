import { describe, expect, test } from "bun:test";
import { parseCaptureFile, type CaptureFile } from "./schema.ts";

function capture(): CaptureFile {
  return {
    schema_version: 1,
    run_id: "C1-1793000000000",
    source: "extension",
    channel_id: "C1",
    channel_name: "spons-x",
    started_at: "2026-10-27T12:00:00.000Z",
    finished_at: "2026-10-27T12:01:00.000Z",
    stop_reason: "channel_start",
    scroll_steps: 3,
    system_rows_skipped: 2,
    unresolved_authors: [],
    messages: [
      {
        id: "C1:1791591648.310369",
        channel_id: "C1",
        channel_name: "spons-x",
        ts: "1791591648.310369",
        author_name: "Ada",
        text: "Use this link <https://x.dev/claim>",
        links: ["https://x.dev/claim"],
        permalink: "https://w.slack.com/archives/C1/p1791591648310369",
        captured_at: "2026-10-27T12:00:30.000Z",
        run_id: "C1-1793000000000",
      },
    ],
  };
}

describe("parseCaptureFile", () => {
  test("accepts a valid capture", () => {
    expect(parseCaptureFile(capture()).messages).toHaveLength(1);
  });

  test("rejects an id that isn't <channel_id>:<ts>", () => {
    const c = capture();
    c.messages[0]!.id = "C1:1";
    expect(() => parseCaptureFile(c)).toThrow("capture.messages[0].id");
  });

  test("rejects a malformed ts", () => {
    const c = capture();
    c.messages[0]!.ts = "p1791591648310369";
    expect(() => parseCaptureFile(c)).toThrow("capture.messages[0].ts");
  });

  test("rejects an unknown stop_reason", () => {
    const c = capture() as unknown as Record<string, unknown>;
    c.stop_reason = "timeout";
    expect(() => parseCaptureFile(c)).toThrow("capture.stop_reason");
  });
});
