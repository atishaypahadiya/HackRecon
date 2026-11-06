// Service worker: automatic page capture for "Sync this event" (v2, user 2026-11-06). The content script sends
// the pages to read; each opens in a background tab (never focused), is read once its text settles, saved to
// ~/Downloads/hackrecon/pages/<file>.page.json for `hr sync`, and the tab is closed. One load per page per sync.
// UNVERIFIED in Chrome until step 5's Slack session: the settle timing and the Cloudflare wait are untested.
import { pageFileName } from "../../pipeline/schema.ts";

const SETTLE_POLL_MS = 1000;
const SETTLE_MAX_MS = 25_000;
const MIN_TEXT = 200;
/** Cloudflare's interstitial title. While it shows, the worker waits; it never interacts with it. */
const BOT_CHECK = /^just a moment|attention required/i;

async function waitComplete(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve) => {
    const on = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(on);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(on);
  });
}

const textState = (tabId: number) =>
  chrome.scripting.executeScript({ target: { tabId }, func: () => ({ title: document.title, chars: document.body?.innerText.length ?? 0 }) }).then((r) => r[0]?.result as { title: string; chars: number });

async function capturePage(url: string): Promise<string> {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id!;
  try {
    await waitComplete(tabId);
    const start = Date.now();
    let last = -1;
    let state = await textState(tabId);
    // Settled: not a bot check, enough text, and the same length on two polls in a row.
    while (Date.now() - start < SETTLE_MAX_MS && (BOT_CHECK.test(state.title) || state.chars < MIN_TEXT || state.chars !== last)) {
      last = BOT_CHECK.test(state.title) ? -1 : state.chars;
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
      state = await textState(tabId);
    }
    if (BOT_CHECK.test(state.title)) return `${url}: still behind a bot check after ${SETTLE_MAX_MS / 1000}s; not saved`;
    if (state.chars < MIN_TEXT) return `${url}: under ${MIN_TEXT} characters of text after ${SETTLE_MAX_MS / 1000}s; not saved`;
    await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/page-snap.js"] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__hackreconSnap!() });
    const json = r?.result as string;
    await chrome.downloads.download({ url: `data:application/json;charset=utf-8,${encodeURIComponent(json)}`, filename: `hackrecon/pages/${pageFileName(url)}`, conflictAction: "overwrite", saveAs: false });
    return `${url}: saved`;
  } catch (e) {
    return `${url}: ${(e as Error).message}`;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg: { type?: string; urls?: string[] }, _sender, reply) => {
  if (msg.type !== "capture-pages" || !msg.urls?.length) return;
  // One page at a time, so a sync is a handful of ordinary page loads, not a burst.
  (async () => {
    const out: string[] = [];
    for (const u of [...new Set(msg.urls)]) out.push(await capturePage(u));
    reply(out);
  })();
  return true;
});
