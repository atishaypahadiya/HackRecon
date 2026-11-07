import { describe, expect, test } from "bun:test";
import { splitParts, SYNC_FILE } from "../extension/src/ui.ts";
import { summarizeSync, wholeFiles } from "./syncbundle.ts";

describe("split files", () => {
  test("parts rejoin to the same bytes; one part keeps the plain name", () => {
    const bytes = new TextEncoder().encode("é".repeat(1000));
    const parts = splitParts("C1.threads.raw.json", bytes, 333);
    expect(parts.map((p) => p.name)).toEqual(Array.from({ length: 7 }, (_, i) => `C1.threads.raw.json.part-${i + 1}-of-7`));
    const files = wholeFiles(parts.map((p) => p.name).reverse());
    expect(files).toEqual([{ name: "C1.threads.raw.json", parts: parts.map((p) => p.name) }]);
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.bytes.length, 0));
    let o = 0;
    for (const p of parts) joined.set(p.bytes, (o += p.bytes.length) - p.bytes.length);
    expect(new TextDecoder().decode(joined)).toBe("é".repeat(1000));
    expect(splitParts("C1.json", bytes).map((p) => p.name)).toEqual(["C1.json"]);
  });
  test("a missing part is reported, not half-joined", () => {
    expect(wholeFiles(["a.json.part-1-of-3", "a.json.part-3-of-3", "b.json"])).toEqual([
      { name: "a.json", parts: [], missing: [2] },
      { name: "b.json", parts: ["b.json"] },
    ]);
  });
});

test("the service worker saves only plain names under hackrecon/sync/<stamp>/", () => {
  const ok = ["hackrecon/sync/2026-11-06T20-11-03-123Z/sync.json", "hackrecon/sync/2026-11-06T20-11-03-123Z/captures/C0C6X7ADPRU.threads.raw.json.part-1-of-2", "hackrecon/sync/2026-11-06T20-11-03-123Z/slack-dom/spons-moss--thread-1792800724071639-top.html"];
  const bad = ["hackrecon/sync/x/../../.zshrc", "hackrecon/pages/a.json", "/etc/passwd", "hackrecon/sync/2026-11-06T20-11-03-123Z/other/a.json", "hackrecon/sync/2026-11-06T20-11-03-123Z/captures/.hidden"];
  for (const p of ok) expect(SYNC_FILE.test(p)).toBe(true);
  for (const p of bad) expect(SYNC_FILE.test(p)).toBe(false);
});

test("summarizeSync names failures, stops, how the pane was found and the samples", () => {
  const lines = summarizeSync({
    stamp: "s",
    stopped_by_user: false,
    targets: ["a", "b"],
    channels: [
      { name: "a", opened: true, threads: [{ stop: "parent_seen", replies: 3, pane_how: "outside_message_pane" }, { stop: "not_opened", replies: 0, note: "no pane" }] },
      { name: "b", opened: false, error: "not in the sidebar" },
    ],
    samples: [{ file: "slack-dom/a--thread-1-top.html", why: "first thread of the sync; pane at its top" }],
    save_errors: [],
  });
  expect(lines).toEqual([
    "channels: 1/2 opened",
    "threads: 2 tried, 3 replies read; stops: parent_seen 1, not_opened 1",
    "pane found by: outside_message_pane 1",
    "  #b: not in the sidebar",
    "thread notes: no pane 1",
    "sample slack-dom/a--thread-1-top.html: first thread of the sync; pane at its top",
  ]);
});
