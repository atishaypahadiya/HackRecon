// "Sync this event" (user 2026-11-06): one click. Lists the sidebar's sponsor channels (spons-, partner-, cohost-)
// and announcement channels, opens each the way the user would (a sidebar click), captures it by scrolling, then
// opens every thread it found ("N replies"), longest first, and reads the pane top to bottom. A few panes are kept
// as scrubbed HTML samples for selectors.ts. Paced: 1.5 s per scroll step, 1.5 s between threads, 3 s between
// channels. It never posts, reacts or messages, makes no Slack API calls and opens no profile cards.
//
// Everything lands under ~/Downloads/hackrecon/sync/<stamp>/ for `hr sync-ingest`:
//   captures/<channel_id>.json, .threads.json, .threads.raw.json   slack-dom/<channel>--thread-*.html   sync.json
// UNVERIFIED in Chrome until the first run: sidebar clicks, the thread pane, its scroller and close button.
import { SCHEMA_VERSION, type Message, type ThreadCaptureFile, type ThreadStopReason, type Ts } from "../../pipeline/schema.ts";
import { STEP_WAIT_MS, NO_NEW_KEYS_STEPS } from "./accumulate.ts";
import { autoPageTargets } from "./autopages.ts";
import { captureChannelFile, channelIdFromUrl, sleep } from "./channel.ts";
import { replyButton } from "./parse.ts";
import { tsFromAttr } from "./permalink.ts";
import { SEL } from "./selectors.ts";
import {
  browserRows,
  cleanHtml,
  findThreadPane,
  moreRepliesControls,
  paneRows,
  parentRendered,
  sidebarChannels,
  syncTargets,
  threadRunFromRaw,
  ThreadRecorder,
  type PaneFound,
  type SidebarChannel,
  type SyncConfig,
  type ThreadRaw,
} from "./thread.ts";
import { overlay, saveFile } from "./ui.ts";

const CHANNEL_PAUSE_MS = 3000;
const THREAD_PAUSE_MS = 1500;
const LOCATE_WAIT_MS = 600;
const PANE_WAIT_MS = 8000;
const MAX_THREAD_STEPS = 200;
const MAX_MORE_CLICKS = 10;
/** Pane samples (D5 fixtures): the first thread opened, threads with at least this many replies, panes with a
 *  "more replies" control, and panes that rendered but gave no replies. Each saves its top and its end. */
const SAMPLE_MIN_REPLIES = 8;
const SAMPLE_CAP = { long: 6, more: 2, empty: 2, not_found: 2 };

declare global {
  interface Window {
    __hackreconSync?: boolean;
    __hackreconSyncConfig?: SyncConfig;
  }
}

interface ThreadLog {
  ts: Ts;
  shown: number | null;
  stop: ThreadStopReason;
  replies: number;
  steps: number;
  secs: number;
  pane_how?: PaneFound["how"];
  scroller: boolean;
  more_clicks: number;
  /** The SEL.threadClose candidate that closed the pane, or "escape" (user 2026-11-06: log it). */
  close?: string;
  note?: string;
}

interface ChannelLog {
  id: string;
  name: string;
  opened: boolean;
  error?: string;
  messages?: number;
  stop?: string;
  secs?: number;
  threads?: ThreadLog[];
  saved: string[];
}

interface SyncLog {
  kind: "sync";
  stamp: string;
  started_at: string;
  finished_at?: string;
  origin: string;
  stopped_by_user: boolean;
  sidebar: SidebarChannel[];
  targets: string[];
  /** Selection source (user 2026-11-06): config channels, those missing from the sidebar, and prefix finds. */
  config?: { event: string | null; channels: number; missing: string[]; discovered: string[] };
  channels: ChannelLog[];
  samples: { file: string; why: string }[];
  save_errors: string[];
}

const fire = (el: Element, type: string, Ctor: typeof MouseEvent) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
};

/** A user's click as the page sees it: pointer and mouse down/up, then click. */
function press(el: Element): void {
  (el as HTMLElement).scrollIntoView?.({ block: "center" });
  fire(el, "pointerdown", PointerEvent);
  fire(el, "mousedown", MouseEvent);
  fire(el, "pointerup", PointerEvent);
  fire(el, "mouseup", MouseEvent);
  fire(el, "click", MouseEvent);
}

async function waitFor<T>(get: () => T | null | undefined | false, ms: number, every = 250): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

function scrollable(el: Element): boolean {
  const oy = getComputedStyle(el).overflowY;
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4;
}

function scrollableAncestor(el: Element, stopAt?: Element): Element | null {
  for (let cur: Element | null = el.parentElement; cur; cur = cur.parentElement) {
    if (scrollable(cur)) return cur;
    if (cur === stopAt) break;
  }
  return null;
}

/** The pane's scrolling element: above its rows, else the largest scrolling element inside it. */
function paneScroller(root: Element): Element | null {
  const row = paneRows(root)[0];
  const up = row && scrollableAncestor(row, root);
  if (up && root.contains(up)) return up;
  let best: Element | null = null;
  for (const el of root.querySelectorAll("*")) if (scrollable(el) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
  return best;
}

const atBottom = (s: Element | null) => !s || s.scrollTop + s.clientHeight >= s.scrollHeight - 4;

async function sync(): Promise<void> {
  const ui = overlay("Stop sync");
  let stopped = false;
  ui.onStop(() => (stopped = true));
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const dir = `hackrecon/sync/${stamp}`;
  const log: SyncLog = { kind: "sync", stamp, started_at: started.toISOString(), origin: location.origin, stopped_by_user: false, sidebar: [], targets: [], channels: [], samples: [], save_errors: [] };
  const counts = { long: 0, more: 0, empty: 0, not_found: 0 };
  let firstThread = true;

  const save = async (rel: string, text: string, mime?: string): Promise<boolean> => {
    const err = await saveFile(`${dir}/${rel}`, text, mime);
    if (err) log.save_errors.push(err);
    return !err;
  };
  const saveLog = () => save("sync.json", JSON.stringify(log, null, 2));
  const sample = async (name: string, html: string, why: string) => {
    const file = `slack-dom/${name}.html`;
    if (await save(file, cleanHtml(html), "text/html")) log.samples.push({ file, why });
  };

  // 1. The sidebar's channels, scrolled top to bottom (it may render only what's visible).
  ui.set("HackRecon: reading the sidebar…");
  const sideScroller = (() => {
    const item = document.querySelector(SEL.sidebarChannel);
    return item ? scrollableAncestor(item) : null;
  })();
  const seen = new Map<string, SidebarChannel>();
  const readSidebar = () => sidebarChannels(document).forEach((c) => seen.has(c.id) || seen.set(c.id, c));
  if (sideScroller) {
    sideScroller.scrollTop = 0;
    await sleep(500);
    for (let i = 0; i < 100; i++) {
      readSidebar();
      if (atBottom(sideScroller)) break;
      sideScroller.scrollTop += sideScroller.clientHeight * 0.8;
      await sleep(500);
    }
    sideScroller.scrollTop = 0;
  } else readSidebar();
  log.sidebar = [...seen.values()];
  const config = window.__hackreconSyncConfig;
  const pick = syncTargets(log.sidebar, config?.channels ?? []);
  const targets = pick.targets;
  log.targets = targets.map((c) => c.name);
  log.config = { event: config?.event ?? null, channels: config?.channels.length ?? 0, missing: pick.missing, discovered: pick.discovered };
  if (!targets.length) {
    ui.set(`HackRecon: none of the config's ${config?.channels.length ?? 0} channels, and no spons-, partner-, cohost- or announcement channels, in the sidebar (${log.sidebar.length} channels read).`);
    await saveLog();
    ui.done();
    return;
  }

  /** Opens a channel with a sidebar click and waits until the pane renders its messages. */
  const openChannel = async (ch: SidebarChannel): Promise<string | null> => {
    const ready = () => channelIdFromUrl() === ch.id && document.querySelector(SEL.scroller) && (document.querySelector(`${SEL.messagePane} [data-msg-channel-id="${ch.id}"]`) || document.querySelector(SEL.channelStart));
    if (ready()) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let item = document.querySelector(`[${SEL.sidebarChannelIdAttr}="${ch.id}"]`);
      if (!item && sideScroller) {
        sideScroller.scrollTop = 0;
        for (let i = 0; i < 100 && !item && !atBottom(sideScroller); i++) {
          sideScroller.scrollTop += sideScroller.clientHeight * 0.8;
          await sleep(400);
          item = document.querySelector(`[${SEL.sidebarChannelIdAttr}="${ch.id}"]`);
        }
      }
      if (!item) return "not in the sidebar";
      press(attempt === 0 ? item : (item.querySelector(SEL.sidebarChannelName) ?? item));
      if (await waitFor(ready, 12_000)) {
        await sleep(STEP_WAIT_MS);
        return null;
      }
    }
    return `clicked the sidebar item twice; the URL shows ${channelIdFromUrl() ?? "no channel"}`;
  };

  /** Scrolls the channel pane until the parent's row renders; null if it never does. */
  const locate = async (ts: Ts): Promise<Element | null> => {
    const scroller = document.querySelector(SEL.scroller);
    if (!scroller) return null;
    const find = () => document.querySelector(`${SEL.messagePane} ${SEL.messageContainer}[${SEL.messageTsAttr}="${ts}"]`)?.closest(".c-virtual_list__item") ?? null;
    let stuck = 0;
    for (let i = 0; i < 400 && stuck < 5; i++) {
      const row = find();
      if (row) {
        (row as HTMLElement).scrollIntoView({ block: "center" });
        await sleep(LOCATE_WAIT_MS);
        return find();
      }
      const keys = [...document.querySelectorAll(SEL.row)].map((r) => tsFromAttr(r.getAttribute("data-item-key"))).filter((k): k is Ts => !!k);
      const before = scroller.scrollTop;
      const up = keys.length ? Number(ts) < Number(keys[0]) : true;
      scroller.scrollTop = before + (up ? -1 : 1) * scroller.clientHeight * 0.8;
      await sleep(LOCATE_WAIT_MS);
      stuck = scroller.scrollTop === before ? stuck + 1 : 0;
    }
    return null;
  };

  /** Closes the pane; returns which SEL.threadClose candidate matched, or "escape" (logged per thread). */
  const closePane = async (root: Element | null): Promise<string> => {
    const sel = SEL.threadClose.split(/,\s*(?![^\[]*\])/).find((c) => root?.querySelector(c));
    if (sel) press(root!.querySelector(sel)!);
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(500);
    return sel ?? "escape";
  };

  /** Opens one thread, reads its pane top to bottom, and returns the raw rows. */
  const readThread = async (ch: SidebarChannel, parent: Message): Promise<{ raw: ThreadRaw; tl: ThreadLog }> => {
    const t0 = Date.now();
    const raw: ThreadRaw = { thread_ts: parent.ts, reply_count_shown: parent.reply_count ?? null, stop_reason: "not_opened", batches: [], rows: {} };
    if (parent.latest_reply) raw.latest_reply_shown = parent.latest_reply;
    const tl: ThreadLog = { ts: parent.ts, shown: raw.reply_count_shown, stop: "not_opened", replies: 0, steps: 0, secs: 0, scroller: false, more_clicks: 0 };
    const done = (note?: string) => {
      if (note) raw.note = tl.note = note;
      tl.stop = raw.stop_reason;
      tl.secs = Math.round((Date.now() - t0) / 1000);
      return { raw, tl };
    };
    const first = firstThread;
    firstThread = false;

    const row = await locate(parent.ts);
    if (!row) return done("the parent row never rendered in the channel pane");
    const button = replyButton(row);
    if (!button) return done("no reply button on the parent row");
    let pane: PaneFound | null = null;
    for (let attempt = 0; attempt < 2 && !pane; attempt++) {
      press(button);
      pane = await waitFor(() => findThreadPane(document, parent.ts), PANE_WAIT_MS);
    }
    if (!pane) {
      if (counts.not_found < SAMPLE_CAP.not_found) {
        counts.not_found++;
        // No pane to save, so the page: the only way to see what the pane looks like.
        await sample(`${ch.name}--thread-notfound-${parent.ts.replace(".", "")}`, cleanHtml(document.body.outerHTML, { dropSvg: true }), "clicked N replies; no pane rendered the parent");
      }
      return done(`clicked "N replies" twice; no pane rendered the parent within ${PANE_WAIT_MS / 1000} s`);
    }
    raw.pane_how = tl.pane_how = pane.how;
    const rec = new ThreadRecorder();
    const root = () => findThreadPane(document, parent.ts)?.root ?? pane!.root;
    let scroller = paneScroller(root());
    tl.scroller = !!scroller;
    rec.record(paneRows(root()));
    const want = raw.reply_count_shown ?? 0;
    const replies = () => rec.size - (parent.ts in rec.rows ? 1 : 0);

    // Top: until the parent renders.
    for (let i = 0; i < 40 && scroller && !parentRendered(root(), parent.ts); i++) {
      scroller.scrollTop = 0;
      await sleep(STEP_WAIT_MS);
      rec.record(paneRows(root()));
      scroller = paneScroller(root()) ?? scroller;
    }
    const sawParent = parentRendered(root(), parent.ts) || parent.ts in rec.rows;
    const why = first ? "first thread of the sync" : want >= SAMPLE_MIN_REPLIES && counts.long < SAMPLE_CAP.long ? `${want} replies` : "";
    if (why && !first) counts.long++;
    const tag = `${ch.name}--thread-${parent.ts.replace(".", "")}`;
    if (why) await sample(`${tag}-top`, root().outerHTML, `${why}; pane at its top`);

    // Down to the end.
    let quiet = 0;
    let sawMore = false;
    let stop: ThreadStopReason | null = null;
    while (!stop) {
      if (stopped) {
        stop = "user_stopped";
        break;
      }
      if (tl.steps >= MAX_THREAD_STEPS) {
        stop = "max_steps";
        break;
      }
      const more = moreRepliesControls(root())[0];
      if (more && tl.more_clicks < MAX_MORE_CLICKS) {
        if (!sawMore && counts.more < SAMPLE_CAP.more) {
          counts.more++;
          await sample(`${tag}-more`, root().outerHTML, `pane shows "${(more.textContent ?? "").trim().slice(0, 40)}"`);
        }
        sawMore = true;
        press(more);
        tl.more_clicks++;
        await sleep(STEP_WAIT_MS);
        rec.record(paneRows(root()));
        // The revealed replies can render above wherever the pane lands, so read down again from the top.
        scroller = paneScroller(root()) ?? scroller;
        if (scroller) {
          scroller.scrollTop = 0;
          await sleep(STEP_WAIT_MS);
          rec.record(paneRows(root()));
        }
        quiet = 0;
        continue;
      }
      const fresh = rec.record(paneRows(root()));
      quiet = fresh ? 0 : quiet + 1;
      scroller = paneScroller(root()) ?? scroller;
      // At the end: one quiet step once every shown reply is in, else three (the count includes sent-to-channel copies).
      if (atBottom(scroller) && quiet >= (replies() >= want ? 1 : 3)) stop = sawParent ? "parent_seen" : "no_new_keys";
      else if (quiet >= NO_NEW_KEYS_STEPS) stop = "no_new_keys";
      if (stop) break;
      if (scroller) scroller.scrollTop += scroller.clientHeight * 0.8;
      tl.steps++;
      ui.set(`HackRecon: #${ch.name} · thread ${parent.ts} · ${replies()}/${want} replies · step ${tl.steps}`);
      await sleep(STEP_WAIT_MS);
    }
    raw.stop_reason = stop;
    raw.batches = rec.batches;
    raw.rows = rec.rows;
    tl.replies = replies();
    if (why) await sample(`${tag}-end`, root().outerHTML, `${why}; pane at its end`);
    if (!tl.replies && counts.empty < SAMPLE_CAP.empty) {
      counts.empty++;
      await sample(`${tag}-empty`, root().outerHTML, "pane rendered the parent but no replies were read");
    }
    tl.close = await closePane(root());
    return done(sawParent ? undefined : "the parent never rendered at the top of the pane");
  };

  // 2. Each channel, then its threads.
  for (const [i, ch] of targets.entries()) {
    if (stopped) break;
    const cl: ChannelLog = { id: ch.id, name: ch.name, opened: false, saved: [] };
    log.channels.push(cl);
    ui.set(`HackRecon: opening #${ch.name} (${i + 1}/${targets.length})…`);
    const err = await openChannel(ch);
    if (err) {
      cl.error = err;
      continue;
    }
    cl.opened = true;
    const t0 = Date.now();
    const r = await captureChannelFile(ui.set, () => stopped, ch.name);
    if (!r.file) {
      cl.error = r.error;
      continue;
    }
    const file = r.file;
    cl.messages = file.messages.length;
    cl.stop = file.stop_reason;
    if (await save(`captures/${file.channel_id}.json`, JSON.stringify(file, null, 2))) cl.saved.push(`${file.channel_id}.json`);
    const pages = autoPageTargets(file);
    if (pages.length) chrome.runtime.sendMessage({ type: "capture-pages", urls: pages });

    // Threads: longest first (D17's order); the one-time fixture capture is uncapped.
    // Deleted parents aren't posts, but their threads are; readThread needs only ts, reply_count and latest_reply.
    const deleted = r.deletedParents.map((d): Message => ({ id: `${file.channel_id}:${d.ts}`, channel_id: file.channel_id, channel_name: file.channel_name, ts: d.ts, author_name: "", text: "", links: [], permalink: "", captured_at: file.finished_at, run_id: file.run_id, reply_count: d.count, ...(d.last ? { latest_reply: d.last } : {}) }));
    const parents = [...file.messages.filter((m) => (m.reply_count ?? 0) > 0 && !m.thread_ts), ...deleted].sort((a, b) => b.reply_count! - a.reply_count! || a.ts.localeCompare(b.ts));
    const threadStart = new Date();
    const raws: ThreadRaw[] = [];
    cl.threads = [];
    for (const p of parents) {
      if (stopped) break;
      const { raw, tl } = await readThread(ch, p);
      raws.push(raw);
      cl.threads.push(tl);
      await sleep(THREAD_PAUSE_MS);
    }
    if (parents.length) {
      const finished = new Date().toISOString();
      const runId = `${file.channel_id}-threads-${threadStart.getTime()}`;
      const ctx = { channelId: file.channel_id, channelName: file.channel_name, runId, capturedAt: finished, base: location.href };
      const tf: ThreadCaptureFile = {
        schema_version: SCHEMA_VERSION,
        kind: "threads",
        run_id: runId,
        source: "extension",
        channel_id: file.channel_id,
        channel_name: file.channel_name,
        started_at: threadStart.toISOString(),
        finished_at: finished,
        budget: "uncapped",
        threads: raws.map((x) => threadRunFromRaw(x, ctx, browserRows)),
      };
      if (await save(`captures/${file.channel_id}.threads.json`, JSON.stringify(tf, null, 2))) cl.saved.push(`${file.channel_id}.threads.json`);
      const rawFile = { kind: "threads_raw", schema_version: SCHEMA_VERSION, run_id: runId, channel_id: file.channel_id, channel_name: file.channel_name, started_at: tf.started_at, finished_at: finished, base: location.href, threads: raws };
      if (await save(`captures/${file.channel_id}.threads.raw.json`, JSON.stringify(rawFile))) cl.saved.push(`${file.channel_id}.threads.raw.json`);
    }
    cl.secs = Math.round((Date.now() - t0) / 1000);
    await saveLog();
    await sleep(CHANNEL_PAUSE_MS);
  }

  log.stopped_by_user = stopped;
  log.finished_at = new Date().toISOString();
  await saveLog();
  const opened = log.channels.filter((c) => c.opened).length;
  const threads = log.channels.flatMap((c) => c.threads ?? []);
  const replies = threads.reduce((n, t) => n + t.replies, 0);
  const secs = Math.round((Date.now() - started.getTime()) / 1000);
  ui.set(
    `HackRecon: ${stopped ? "stopped. " : ""}${opened}/${targets.length} channels, ${threads.length} threads (${threads.filter((t) => t.stop !== "not_opened").length} opened), ${replies} replies in ${Math.round(secs / 60)} min. ` +
      `Saved to Downloads/hackrecon/sync/${stamp}/${log.save_errors.length ? `; ${log.save_errors.length} files failed to save` : ""}.`,
  );
  ui.done();
}

if (!window.__hackreconSync) {
  window.__hackreconSync = true;
  sync()
    .catch((e) => console.error("[hackrecon] sync failed", e))
    .finally(() => (window.__hackreconSync = false));
}
