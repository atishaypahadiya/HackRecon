// Injected into the open Slack tab by the popup. Reads only what the web client renders while it
// scrolls the visible message pane: no Slack API calls, no profile cards, nothing sent anywhere.
// The result downloads as <channel_id>.json; nothing is kept in a service worker.
import { SCHEMA_VERSION, messageId, type CaptureFile, type Message, type StopReason } from "../../pipeline/schema.ts";
import { Accumulator, STEP_WAIT_MS, StopRule } from "./accumulate.ts";
import { parseRows } from "./parse.ts";
import { SEL, TEXT } from "./selectors.ts";

const MAX_STEPS = 3000;
const STEP_FRACTION = 0.8;

declare global {
  interface Window {
    __hackreconCapture?: boolean;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function channelIdFromUrl(): string | null {
  return /\/client\/[A-Z0-9]+\/([CG][A-Z0-9]+)/.exec(location.pathname)?.[1] ?? null;
}

/** true: Slack shows a "who can post" notice; false: a composer and no notice; null: neither found. */
function postingRestricted(): boolean | null {
  const footer = document.querySelector(SEL.footer);
  if (!footer) return null;
  if (TEXT.postingRestricted.test(footer.textContent ?? "")) return true;
  return document.querySelector(SEL.composer) ? false : null;
}

function channelName(): string {
  const fromHeader = document.querySelector(SEL.channelName)?.textContent?.trim();
  if (fromHeader) return fromHeader.replace(/^#\s*/, "");
  // Title looks like "spons-convex (Channel) - Cal Hacks - Slack".
  return document.title.split(" (")[0]?.replace(/^[*!]\s*/, "").trim() ?? "";
}

function overlay(): { set(msg: string): void; onStop(fn: () => void): void; done(): void } {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;background:#1a1d21;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:320px";
  const text = document.createElement("div");
  const stop = document.createElement("button");
  stop.textContent = "Stop and download";
  stop.style.cssText = "margin-top:8px;font:inherit;cursor:pointer";
  box.append(text, stop);
  document.body.append(box);
  return {
    set: (msg) => (text.textContent = msg),
    onStop: (fn) => stop.addEventListener("click", fn, { once: true }),
    done: () => {
      stop.remove();
      setTimeout(() => box.remove(), 8000);
    },
  };
}

function download(file: CaptureFile): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${file.channel_id}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function scrollToNewest(scroller: Element): Promise<void> {
  let last = -1;
  for (let i = 0; i < 10 && scroller.scrollHeight !== last; i++) {
    last = scroller.scrollHeight;
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(STEP_WAIT_MS);
  }
}

async function capture(): Promise<void> {
  const ui = overlay();
  const channelId = channelIdFromUrl();
  const scroller = document.querySelector(SEL.scroller);
  if (!channelId || !scroller) {
    ui.set(`HackRecon: ${!channelId ? "open a channel in app.slack.com first" : "message pane not found (selectors.ts needs updating)"}.`);
    ui.done();
    return;
  }
  const started = new Date();
  const runId = `${channelId}-${started.getTime()}`;
  const acc = new Accumulator();
  const rule = new StopRule();
  const ingest = () => acc.ingest(parseRows(document, location.href));

  let userStopped = false;
  ui.onStop(() => (userStopped = true));

  const listEl = document.querySelector(SEL.list) ?? scroller;
  const observer = new MutationObserver(ingest);
  observer.observe(listEl, { childList: true, subtree: true });

  ui.set("HackRecon: jumping to the newest message…");
  await scrollToNewest(scroller);

  let steps = 0;
  let stop: StopReason | null = null;
  while (!stop) {
    ingest();
    stop = userStopped ? "user_stopped" : steps >= MAX_STEPS ? "max_steps" : rule.step(acc.size, acc.sawChannelStart);
    if (stop) break;
    ui.set(`HackRecon: ${acc.size} messages · step ${steps} · scrolling up…`);
    scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * STEP_FRACTION);
    steps++;
    await sleep(STEP_WAIT_MS);
  }
  observer.disconnect();
  ingest();

  const finished = new Date();
  const name = channelName();
  const { messages, systemRowsSkipped, nonPostsSkipped, unresolvedAuthors } = acc.finalize();
  const file: CaptureFile = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    source: "extension",
    channel_id: channelId,
    channel_name: name,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    stop_reason: stop,
    scroll_steps: steps,
    system_rows_skipped: systemRowsSkipped,
    non_posts_skipped: nonPostsSkipped,
    unresolved_authors: unresolvedAuthors,
    posting_restricted: postingRestricted(),
    messages: messages.map((m): Message => {
      const out: Message = {
        id: messageId(channelId, m.ts),
        channel_id: channelId,
        channel_name: name,
        ts: m.ts,
        author_name: m.sender.name,
        text: m.text,
        links: m.links,
        permalink: m.permalink,
        captured_at: finished.toISOString(),
        run_id: runId,
      };
      if (m.threadTs) {
        out.thread_ts = m.threadTs;
        out.subtype = "thread_broadcast";
      }
      if (m.sender.title) out.author_title = m.sender.title;
      if (m.sender.id) out.author_id = m.sender.id;
      out.author_kind = m.sender.bot ? "bot" : "user";
      if (m.sender.external) out.author_external = true;
      return out;
    }),
  };
  download(file);
  const secs = Math.round((finished.getTime() - started.getTime()) / 1000);
  ui.set(
    `HackRecon: ${messages.length} messages in ${secs}s, stop: ${stop}, system rows skipped: ${systemRowsSkipped}` +
      (unresolvedAuthors.length ? `, ${unresolvedAuthors.length} without an author` : "") +
      `. Saved ${channelId}.json.`,
  );
  ui.done();
}

if (!window.__hackreconCapture) {
  window.__hackreconCapture = true;
  capture()
    .catch((e) => console.error("[hackrecon] capture failed", e))
    .finally(() => (window.__hackreconCapture = false));
}
