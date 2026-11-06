// Real Cal Hacks Slack DOM samples (events/calhacks-13/fixtures/slack-dom/*.html, gitignored: they hold workspace data),
// checked against the slackdump export rather than hand-typed expectations.
// How to save samples: extension/README.md.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { Accumulator, type RawRow } from "./accumulate.ts";
import { parseRows } from "./parse.ts";
import { channelFromPermalink, tsFromAttr, tsFromPermalink } from "./permalink.ts";
import { SEL } from "./selectors.ts";
import {
  expectedAuthorNames,
  isTopLevel,
  loadExport,
  normName,
  readChannel,
  rowClass,
  type ExportMessage,
} from "../../pipeline/export.ts";
import { DEFAULT_EXPORT_DIR, EVENTS_DIR, SLACK_DOM_FIXTURES_DIR } from "../../pipeline/event.ts";

const DIR = join(EVENTS_DIR, "calhacks-13", SLACK_DOM_FIXTURES_DIR);
const CUTOFF = Date.parse("2026-10-27T03:17:00-07:00") / 1000;
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".html")).sort() : [];

test("calhacks-13 fixtures/slack-dom has samples", () => {
  if (!files.length) throw new Error(`no .html samples in ${DIR}; see extension/README.md "Saving DOM samples"`);
});

type Parsed = { file: string; doc: Document; rows: RawRow[]; channelId: string; byTs: Map<string, ExportMessage> };

const exp = files.length && existsSync(DEFAULT_EXPORT_DIR) ? loadExport() : null;
const parsed: Parsed[] = files.map((file) => {
  const { document } = parseHTML(readFileSync(join(DIR, file), "utf8"));
  const doc = document as unknown as Document;
  const rows = parseRows(doc, "https://app.slack.com/");
  const href = [...doc.querySelectorAll(SEL.timestamp)].map((a) => a.getAttribute("href") ?? "").find(channelFromPermalink);
  const channelId = (href && channelFromPermalink(href)) || "";
  const name = exp?.channelsById.get(channelId);
  const byTs = new Map(name && exp ? readChannel(exp, name).map((m) => [m.ts, m]) : []);
  return { file, doc, rows, channelId, byTs };
});

for (const p of parsed) {
  describe(p.file, () => {
    const msgs = p.rows.filter((r) => r.kind === "message" || r.kind === "system") as Extract<RawRow, { ts: string }>[];

    test("selectors find rows and a channel id", () => {
      expect(msgs.length).toBeGreaterThan(0);
      expect(p.channelId).toMatch(/^[CG][A-Z0-9]+$/);
      expect(p.byTs.size).toBeGreaterThan(0);
    });

    test("ts from the permalink equals every other ts attribute on the row", () => {
      for (const a of p.doc.querySelectorAll(SEL.timestamp)) {
        const fromHref = tsFromPermalink(a.getAttribute("href") ?? "");
        const fromAttr = tsFromAttr(a.getAttribute("data-ts"));
        if (fromHref && fromAttr) expect(fromAttr).toBe(fromHref);
        const row = a.closest(SEL.row);
        const key = tsFromAttr(row?.getAttribute("data-item-key"));
        if (fromHref && key) expect(key).toBe(fromHref);
      }
    });

    test("kept rows are real or bot posts in the export; skipped rows are system rows", () => {
      for (const r of msgs) {
        const e = p.byTs.get(r.ts);
        if (!e) {
          // Not in the export is only fine for posts made after it was taken.
          expect({ ts: r.ts, posted_after_export: Number(r.ts) > CUTOFF }).toEqual({ ts: r.ts, posted_after_export: true });
          continue;
        }
        const cls = rowClass(e);
        const want = cls === "broadcast" ? "message" : !isTopLevel(e) ? "reply" : cls === "system" ? "system" : "message";
        if (cls === "broadcast") expect({ ts: r.ts, threadTs: r.threadTs }).toEqual({ ts: r.ts, threadTs: e.thread_ts });
        expect({ ts: r.ts, kind: r.kind, text: r.text.slice(0, 60) }).toEqual({ ts: r.ts, kind: want as never, text: r.text.slice(0, 60) });
      }
    });

    test("plain posts serialize to exactly the export's text", () => {
      let compared = 0;
      for (const r of msgs) {
        const raw = p.byTs.get(r.ts)?.text;
        if (r.kind !== "message" || !raw) continue;
        // Trailing spaces before a newline are trimmed by the serializer on purpose.
        const want = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n");
        // Only posts with no mrkdwn markup: links, mentions and formatting render differently by design.
        if (/[<*_`~•]|^>|^\d+\. /m.test(want)) continue;
        compared++;
        expect({ ts: r.ts, text: r.text }).toEqual({ ts: r.ts, text: want.trim() });
      }
      expect(compared).toBeGreaterThan(0);
    });

    test("grouped posts get the export's author after carry-forward", () => {
      const acc = new Accumulator();
      acc.ingest(p.rows);
      const { messages, unresolvedAuthors } = acc.finalize();
      // Only grouped posts above the first rendered header may stay unresolved (their header is off-sample).
      const firstHeader = msgs.findIndex((r) => r.sender);
      const topEdge = new Set(msgs.slice(0, Math.max(firstHeader, 0)).map((r) => r.ts));
      expect(unresolvedAuthors.filter((t) => !topEdge.has(t))).toEqual([]);
      for (const m of messages) {
        const e = p.byTs.get(m.ts);
        if (!e || unresolvedAuthors.includes(m.ts)) continue;
        const want = exp ? expectedAuthorNames(exp, e) : [];
        if (!want.length) continue; // Slack Connect poster: the export has no name to check against.
        expect({ ts: m.ts, author: m.sender.name, ok: want.some((n) => normName(n) === normName(m.sender.name)) }).toEqual({
          ts: m.ts,
          author: m.sender.name,
          ok: true,
        });
      }
    });

    test(`channel-start header: detected in "channel-start" samples, and only ever next to the channel's oldest row`, () => {
      const detected = p.rows.some((r) => r.kind === "channel_start");
      if (p.file.includes("channel-start")) expect(detected).toBe(true);
      if (detected) {
        const oldest = [...p.byTs.values()].filter(isTopLevel).map((m) => m.ts).sort()[0];
        expect(msgs.some((r) => r.ts === oldest)).toBe(true);
      }
    });

    test("Slack Connect badge iff the export doesn't know the poster (users.json)", () => {
      for (const r of msgs) {
        const e = p.byTs.get(r.ts);
        if (!r.sender || !e?.user || !exp) continue;
        expect({ ts: r.ts, name: r.sender.name, external: !!r.sender.external }).toEqual({
          ts: r.ts,
          name: r.sender.name,
          external: !exp.users.has(e.user),
        });
      }
    });
  });
}

describe("sample coverage (each case must appear in at least one sample)", () => {
  if (!parsed.length) return;
  const all = parsed.flatMap((p) => p.rows.map((r) => ({ p, r })));
  const has = (f: (x: { p: Parsed; r: RawRow }) => boolean) => all.some(f);
  test("a grouped post (no author header)", () => expect(has(({ r }) => r.kind === "message" && !r.sender)).toBe(true));
  test("a Slack Connect poster flagged external", () => expect(has(({ r }) => r.kind === "message" && !!r.sender?.external)).toBe(true));
  test("a bot post kept", () =>
    expect(has(({ p, r }) => r.kind === "message" && p.byTs.get(r.ts)?.subtype === "bot_message")).toBe(true));
  test("a system row skipped", () => expect(has(({ r }) => r.kind === "system")).toBe(true));
  test("a channel-start header", () => expect(has(({ r }) => r.kind === "channel_start")).toBe(true));
  test("a labeled link serialized as `label <href>`", () =>
    expect(has(({ r }) => r.kind === "message" && r.links.some((l) => r.text.includes(`<${l}>`)))).toBe(true));
});
