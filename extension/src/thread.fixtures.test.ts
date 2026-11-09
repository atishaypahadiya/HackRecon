// Thread-pane samples saved by "Sync this event" (fixtures/slack-dom/<channel>--thread-<ts>-{top,end,more}.html,
// gitignored), checked against the export: the pane is found, every reply read is a real reply of that parent,
// with the export's author. Skipped until a sync has saved samples; the first sync's samples back SEL.threadPane.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { findThreadPane, paneRows, ThreadRecorder, threadRunFromRaw, type HtmlToRows } from "./thread.ts";
import { expectedAuthorNames, loadExport, normName, readChannel } from "../../pipeline/export.ts";
import { CALHACKS_EXPORT_DIR, EVENTS_DIR, SLACK_DOM_FIXTURES_DIR } from "../../pipeline/event.ts";

const CUTOFF = Date.parse("2026-10-27T03:17:00-07:00") / 1000;
const DIR = join(EVENTS_DIR, "calhacks-13", SLACK_DOM_FIXTURES_DIR);
const SAMPLE = /^(.+)--thread-(\d{10})(\d{6})-(top|end|more|empty)\.html$/;
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => SAMPLE.test(f)).sort() : [];
const exp = files.length && existsSync(CALHACKS_EXPORT_DIR) ? loadExport(CALHACKS_EXPORT_DIR) : null;
const rowsOf: HtmlToRows = (html) => [...(parseHTML(`<html><body><div id="r">${html}</div></body></html>`).document.getElementById("r")?.children ?? [])] as unknown as Element[];

describe.skipIf(!exp)("thread pane samples vs the export", () => {
  for (const f of files) {
    const [, channel, a, b, at] = SAMPLE.exec(f)!;
    const parent = `${a}.${b}`;
    test(`${f}: pane found; replies are this parent's, with the export's authors`, () => {
      const doc = parseHTML(`<html><body>${readFileSync(join(DIR, f), "utf8")}</body></html>`).document as unknown as Document;
      const pane = findThreadPane(doc, parent);
      expect(pane).not.toBeNull();
      const rec = new ThreadRecorder();
      rec.record(paneRows(pane!.root));
      const cid = [...exp!.channelsById].find(([, n]) => n === channel)?.[0] ?? "";
      const run = threadRunFromRaw({ thread_ts: parent, reply_count_shown: null, stop_reason: "parent_seen", batches: rec.batches, rows: rec.rows }, { channelId: cid, channelName: channel!, runId: "fixture", capturedAt: "2026-11-06T00:00:00.000Z", base: "https://app.slack.com/" }, rowsOf);
      const byTs = new Map(readChannel(exp!, channel!).map((m) => [m.ts, m]));
      if (at !== "empty") expect(run.replies.length).toBeGreaterThan(0);
      for (const r of run.replies) {
        if (Number(r.ts) > CUTOFF) continue; // posted after the export
        const e = byTs.get(r.ts);
        expect([r.ts, e?.thread_ts]).toEqual([r.ts, parent]);
        const names = e ? expectedAuthorNames(exp!, e) : [];
        // A blank author is a header whose name Slack hadn't loaded: unknown, never someone else's name.
        if (names.length && r.author_name) expect(names.map(normName)).toContain(normName(r.author_name));
      }
    });
  }
});
