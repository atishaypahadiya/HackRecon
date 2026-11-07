// "Sync this event" against the real spons-moss samples (gitignored) and the export: the reply bar, the sidebar,
// and the thread pane reader on a pane built from the sample's own rows (no thread-pane sample exists yet).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { parseReplyBar, parseRows } from "./parse.ts";
import { SEL } from "./selectors.ts";
import { findThreadPane, paneRows, sidebarChannels, syncConfigFrom, syncTargets, threadRunFromRaw, ThreadRecorder, type HtmlToRows, type ThreadRaw } from "./thread.ts";
import { loadExport, readChannel } from "../../pipeline/export.ts";
import { DEFAULT_EXPORT_DIR, EVENTS_DIR, SLACK_DOM_FIXTURES_DIR } from "../../pipeline/event.ts";

const DIR = join(EVENTS_DIR, "calhacks-13", SLACK_DOM_FIXTURES_DIR);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^spons-moss--.*\.html$/.test(f)).sort() : [];
const exp = files.length && existsSync(DEFAULT_EXPORT_DIR) ? loadExport() : null;
const load = (f: string) => parseHTML(readFileSync(join(DIR, f), "utf8")).document as unknown as Document;
const linkedomRows: HtmlToRows = (html) => [...(parseHTML(`<html><body><div id="r">${html}</div></body></html>`).document.getElementById("r")?.children ?? [])] as unknown as Element[];

describe.skipIf(!exp)("reply bar (spons-moss samples vs the export)", () => {
  test("every rendered reply bar has the export's reply_count and latest_reply", () => {
    // The samples are named spons-moss but show other channels too; each row carries its own channel id.
    const byTs = new Map([...exp!.channelsById.values()].flatMap((n) => readChannel(exp!, n)).map((m) => [m.ts, m]));
    let checked = 0;
    for (const f of files) {
      for (const r of parseRows(load(f), "https://app.slack.com/")) {
        if (!("ts" in r) || !r.replies) continue;
        const e = byTs.get(r.ts);
        if (!e) continue;
        expect([r.ts, r.replies.count]).toEqual([r.ts, e.reply_count!]);
        if (r.replies.last) expect(r.replies.last).toBe(e.latest_reply!);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  test("falls back to the button text when data-qa is gone", () => {
    const doc = load(files[0]!);
    const bar = doc.querySelector(SEL.replyCount)!;
    const row = bar.closest(".c-virtual_list__item")!;
    const want = parseReplyBar(row)!.count;
    bar.removeAttribute("data-qa");
    expect(parseReplyBar(row)?.count).toBe(want);
  });
});

describe.skipIf(!exp)("sidebar", () => {
  const doc = files.length ? load(files[0]!) : null;
  test("channel ids and names match the export's channels.json", () => {
    const found = sidebarChannels(doc!);
    expect(found.length).toBeGreaterThan(50);
    let known = 0;
    for (const c of found) {
      const name = exp!.channelsById.get(c.id);
      if (name) expect(c.name).toBe(name), known++;
    }
    expect(known).toBeGreaterThan(50);
  });
  const sponsors = JSON.parse(readFileSync(join(EVENTS_DIR, "calhacks-13", "config", "sponsors.json"), "utf8")) as Record<string, { stretch?: boolean; sponsor?: string; aliases?: string[] }>;
  const event = JSON.parse(readFileSync(join(EVENTS_DIR, "calhacks-13", "config", "event.json"), "utf8"));

  test("every locked channel is selected from the config, 2-opportunities included, in config order", () => {
    const config = syncConfigFrom(sponsors, event);
    const pick = syncTargets(sidebarChannels(doc!), config.channels);
    const names = pick.targets.map((c) => c.name);
    const locked = Object.keys(sponsors).filter((k) => !sponsors[k]!.stretch);
    expect(locked).toHaveLength(25);
    for (const ch of locked) expect(names).toContain(ch);
    expect(names).toContain("2-opportunities");
    expect(names.slice(0, locked.length)).toEqual(locked.filter((c) => names.includes(c)));
    expect(pick.missing).toEqual([]);
  });

  test("prefixes only discover what the config doesn't list; nothing else is picked", () => {
    const pick = syncTargets(sidebarChannels(doc!), ["0-announcements", "spons-moss"]);
    expect(pick.targets.slice(0, 2).map((c) => c.name)).toEqual(["0-announcements", "spons-moss"]);
    expect(pick.discovered).toContain("spons-apify");
    expect(pick.discovered).not.toContain("spons-moss");
    expect(pick.targets.map((c) => c.name).filter((n) => !/^(spons|partner|cohost)-|announce|(^|[-_])(team[-_]?formation|introductions?)$/.test(n) && !["0-announcements"].includes(n))).toEqual([]);
    expect(syncTargets(sidebarChannels(doc!), ["no-such-channel"]).missing).toEqual(["no-such-channel"]);
  });

  test("hacker-only channels are captured normally, with text (user 2026-11-07); none is authors-only", () => {
    const found = sidebarChannels(doc!);
    const pick = syncTargets(found, ["0-announcements"]);
    const hacker = found.map((c) => c.name).filter((n) => /(^|[-_])(team[-_]?formation|introductions?)$/i.test(n));
    for (const n of hacker) expect(pick.targets.map((c) => c.name)).toContain(n);
    expect(pick.authors).toEqual([]);
    // event.json's list replaces the name pattern.
    const own = syncTargets(found, [], ["1-introductions"]);
    expect(own.targets.map((c) => c.name)).toContain("1-introductions");
    expect(own.targets.map((c) => c.name)).not.toContain("1-team-formation");
  });
});

describe.skipIf(!files.length)("thread pane reader (pane built from the sample's own rows)", () => {
  const doc = files.length ? load("spons-moss--grouped.html") : (null as unknown as Document);
  const pane = doc && doc.querySelector(SEL.messagePane)!;
  const rows = pane ? [...pane.querySelectorAll(".c-virtual_list__item")].filter((r) => r.querySelector(SEL.messageContainer)) : [];
  const parent = rows.find((r) => r.querySelector(SEL.replyCount))!;
  const p = parent?.getAttribute("data-item-key") ?? "";
  const header = rows.find((r) => r !== parent && r.querySelector(SEL.sender))!;
  const grouped = rows.find((r) => r !== parent && !r.querySelector(SEL.sender) && r.querySelector(SEL.body))!;
  const cid = parent?.querySelector(SEL.messageContainer)?.getAttribute("data-msg-channel-id") ?? "";

  /** A reply: the template row with its ts rewritten and a reply permalink. */
  const asReply = (tpl: Element, ts: string) => {
    const old = tpl.getAttribute("data-item-key")!;
    return tpl.outerHTML
      .replaceAll(old, ts)
      .replaceAll(`p${old.replace(".", "")}`, `p${ts.replace(".", "")}`)
      .replace(new RegExp(`(/archives/${cid}/p${ts.replace(".", "")})"`), `$1?thread_ts=${p}&amp;cid=${cid}"`);
  };
  const r1 = (Number(p) + 10).toFixed(6), r2 = (Number(p) + 20).toFixed(6), r3 = (Number(p) + 30).toFixed(6);
  const paneHtml = parent ? `${parent.outerHTML.replace(SEL.replyCount.slice(1, -1), "")}${asReply(header, r1)}${asReply(grouped, r2)}${asReply(header, r3)}` : "";

  test("the sample has a parent with replies, a header row and a grouped row to build from", () => {
    expect([!!parent, !!header, !!grouped, cid]).toEqual([true, true, true, expect.stringMatching(/^C/)]);
  });

  test("finds the pane outside the message pane, never the channel's own row", () => {
    expect(findThreadPane(doc, p)).toBeNull();
    const side = doc.createElement("div");
    side.setAttribute("data-qa", "some_secondary_view");
    side.innerHTML = `<div><div class="list">${paneHtml}</div></div>`;
    doc.body.append(side);
    const found = findThreadPane(doc, p)!;
    expect(found.how).toBe("outside_message_pane");
    expect(found.root).toBe(side);
    expect(paneRows(found.root).map((r) => r.getAttribute("data-item-key"))).toEqual([p, r1, r2, r3]);
    side.remove();
  });

  test("a pane opened at its end (parent not rendered) is found by its reply permalinks", () => {
    const side = doc.createElement("div");
    side.innerHTML = `<div>${asReply(header, r1)}${asReply(grouped, r2)}</div>`;
    doc.body.append(side);
    expect(findThreadPane(doc, p)).toMatchObject({ how: "reply_links", root: side });
    side.remove();
  });

  test("a selector candidate wins when it holds the parent", () => {
    const side = doc.createElement("div");
    side.setAttribute("data-qa", "threads_flexpane");
    side.innerHTML = paneHtml;
    doc.body.append(side);
    expect(findThreadPane(doc, p)).toMatchObject({ how: "selector", root: side });
    side.remove();
  });

  test("raw rows rebuild as replies under the parent, the grouped one under the row above it", () => {
    const side = doc.createElement("div");
    side.innerHTML = paneHtml;
    const rec = new ThreadRecorder();
    rec.record(paneRows(side));
    const raw: ThreadRaw = { thread_ts: p, reply_count_shown: 3, stop_reason: "parent_seen", batches: rec.batches, rows: rec.rows };
    const run = threadRunFromRaw(raw, { channelId: cid, channelName: "sample", runId: "t", capturedAt: "2026-11-06T00:00:00.000Z", base: "https://app.slack.com/" }, linkedomRows);
    const who = header.querySelector(SEL.sender)!.textContent!.trim();
    expect(run.replies.map((m) => [m.ts, m.thread_ts, m.author_name])).toEqual([
      [r1, p, who],
      [r2, p, who],
      [r3, p, who],
    ]);
    expect(run.replies[0]!.permalink).toContain(`thread_ts=${p}`);
    expect(JSON.stringify(rec.rows)).not.toContain("<path");
  });
});
