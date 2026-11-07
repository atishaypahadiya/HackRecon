// Service worker: automatic page capture for "Sync this event" (v2, user 2026-11-06). The content script sends
// the pages to read; each opens in a background tab (never focused), is read once its text settles, saved to
// ~/Downloads/hackrecon/pages/<file>.page.json for `hr sync`, and the tab is closed. One load per page per sync.
// UNVERIFIED in Chrome until step 5's Slack session: the settle timing and the Cloudflare wait are untested.
import { draftStep, scrubDevpostHtml, startDraft, type DraftPage } from "../../pipeline/devpostdraft.ts";
import { pageFileName } from "../../pipeline/schema.ts";
import { DEVPOST_EVENT_URL } from "./autopages.ts";
import { SYNC_FILE } from "./ui.ts";

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
  // Same rule as the content script, checked again here: only an event's own Devpost pages, over https.
  if (!DEVPOST_EVENT_URL.test(url)) return `${url}: not an event Devpost page; not opened`;
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
    // After redirects the tab must still be on an event Devpost page (path may differ; host and scheme may not).
    const at = new URL((await chrome.tabs.get(tabId)).url ?? "about:blank");
    if (!DEVPOST_EVENT_URL.test(`${at.protocol}//${at.host}/`)) return `${url}: ended up on ${at.host || "a non-web page"}; not saved`;
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

const download = (filename: string, body: string, type: string) =>
  chrome.downloads.download({ url: `data:${type};charset=utf-8,${encodeURIComponent(body)}`, filename, conflictAction: "overwrite", saveAs: false });

/** Waits for a load to finish and the text to settle (as capturePage); false when a bot check never clears. */
async function settle(tabId: number): Promise<boolean> {
  await waitComplete(tabId);
  const start = Date.now();
  let last = -1, state = await textState(tabId);
  while (Date.now() - start < SETTLE_MAX_MS && (BOT_CHECK.test(state.title) || state.chars !== last)) {
    last = BOT_CHECK.test(state.title) ? -1 : state.chars;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    state = await textState(tabId);
  }
  return !BOT_CHECK.test(state.title);
}

/** The user's own submission for this event (user 2026-11-07), read in one background tab during a sync. Read-only:
 *  the tab only loads link addresses draftStep picks from the page it's on (GET); nothing is clicked, focused, typed
 *  or submitted. Saves one scrubbed sample of the best submission page and a log of the pages loaded (addresses and
 *  counts, no content) to ~/Downloads/hackrecon/devpost/. Once per event per worker lifetime. */
const draftDone = new Set<string>();
async function visitDraft(eventRoot: string): Promise<string> {
  let state = startDraft(eventRoot);
  if (!state || draftDone.has(state.slug)) return "devpost draft: skipped";
  draftDone.add(state.slug);
  const cfg = await fetch(chrome.runtime.getURL("dist/sync-config.json")).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const tracks: string[] = cfg?.devpost_tracks ?? [];
  // One background tab per page (never focused), so a load is never confused with the page before it.
  let tabId = (await chrome.tabs.create({ url: eventRoot, active: false })).id!;
  let best: { url: string; score: number; html: string } | null = null;
  let result = "";
  try {
    for (;;) {
      if (!(await settle(tabId))) {
        result = "a bot check never cleared";
        break;
      }
      // The worker re-checks where the tab ended up: only Devpost hosts are read.
      const at = (await chrome.tabs.get(tabId)).url ?? "";
      if (!/^https:\/\/(?:[a-z0-9-]+\.)?devpost\.com\//.test(at)) {
        result = `ended up off Devpost (${new URL(at || "about:blank").host || "no page"})`;
        break;
      }
      await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/devpost-snap.js"] });
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: (t: string[]) => window.__hackreconDevpost!.inspect(t), args: [tracks] });
      const page = r?.result as DraftPage;
      if (state.stage === "submission") {
        const score = page.prize_boxes * 1000 + page.track_mentions;
        if (score > 0 && (!best || score > best.score)) {
          const [h] = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__hackreconDevpost!.sample() });
          best = { url: page.url, score, html: scrubDevpostHtml(h?.result as string).html };
        }
      }
      const step = draftStep(state, page);
      state = step.state;
      if (!step.go) {
        result = step.why;
        break;
      }
      chrome.tabs.remove(tabId).catch(() => {});
      tabId = (await chrome.tabs.create({ url: step.go, active: false })).id!;
    }
  } catch (e) {
    result = (e as Error).message;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
  const slug = state.slug;
  if (best) await download(`hackrecon/devpost/${slug}.submission.html`, best.html, "text/html");
  await download(`hackrecon/devpost/${slug}.visit.json`, JSON.stringify({ event_root: eventRoot, finished_at: new Date().toISOString(), result, sample: best ? { url: best.url, score: best.score } : null, pages: state.log }, null, 2), "application/json");
  return `devpost draft: ${result}${best ? "; sample saved" : "; no sample"}`;
}

chrome.runtime.onMessage.addListener((msg: { type?: string; urls?: string[]; filename?: string; url?: string; draft?: boolean }, sender, reply) => {
  if (msg.type === "save-file") {
    // Only our own content script, and only data: URLs it built; the path is checked again here.
    if (sender.id !== chrome.runtime.id || !msg.filename || !SYNC_FILE.test(msg.filename) || msg.filename.includes("..") || !msg.url?.startsWith("data:")) {
      reply({ error: "refused: not a sync file" });
      return;
    }
    chrome.downloads
      .download({ url: msg.url, filename: msg.filename, conflictAction: "overwrite", saveAs: false })
      .then(() => reply({}))
      .catch((e: Error) => reply({ error: e.message }));
    return true;
  }
  if (msg.type !== "capture-pages" || !msg.urls?.length) return;
  // One page at a time, so a sync is a handful of ordinary page loads, not a burst.
  (async () => {
    const out: string[] = [];
    for (const u of [...new Set(msg.urls)]) out.push(await capturePage(u));
    // Sync only (the popup's single-channel capture never sets draft): the user's own submission, read-only.
    const root = msg.urls!.find((u) => /^https:\/\/[a-z0-9-]+\.devpost\.com\/$/.test(u));
    if (msg.draft && sender.id === chrome.runtime.id && root) out.push(await visitDraft(root));
    reply(out);
  })();
  return true;
});
