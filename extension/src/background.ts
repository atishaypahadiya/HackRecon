// Service worker: automatic page capture for "Sync this event" (v2, user 2026-11-06). The content script sends
// the pages to read; each opens in a background tab (never focused), is read once its text settles, saved to
// ~/Downloads/hackrecon/pages/<file>.page.json for `hr sync`, and the tab is closed. One load per page per sync.
// UNVERIFIED in Chrome until step 5's Slack session: the settle timing and the Cloudflare wait are untested.
import { scrubTokens } from "../../pipeline/domscrub.ts";
import { pageFileName } from "../../pipeline/schema.ts";
import { refuseLoad } from "../../pipeline/urlsafety.ts";
import { pull, type PullState } from "./apipull.ts";
import { DEVPOST_EVENT_URL } from "./autopages.ts";
import { fromSlackTab, isKnown, pullDue, remember, type KnownWorkspace, type SlackSession } from "./handoff.ts";
import { ApiError, SlackApi, WORKSPACE_ORIGIN } from "./slackapi.ts";
import type { SyncConfig } from "./thread.ts";
import { base64, splitParts, SYNC_FILE } from "./ui.ts";

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
  const action = refuseLoad(url);
  if (action) return `${url}: ${action}`;
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
    if (refuseLoad(at.href)) return `${url}: redirected to ${at.pathname}, which ${refuseLoad(at.href)}; not saved`;
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

// The background API pull (user 2026-11-07). The popup hands over the Slack session it read from the open Slack
// tab; it is kept in chrome.storage.session (memory only, cleared when the browser closes, unreadable by content
// scripts) and used only by SlackApi. A pull runs now and then every PULL_EVERY_MIN minutes from chrome.alarms, with
// no tab or window. Files land in ~/Downloads/hackrecon/sync/<stamp>/pull/ for `hr sync-ingest`; a pull that found
// nothing new saves nothing. Cursors (ts and reply counts, no text) are kept in chrome.storage.local.
// UNVERIFIED in Chrome until the first pull: that the service worker's requests carry Slack's session cookie.
const ALARM = "hackrecon-pull";
const PULL_EVERY_MIN = 30;
/** A running pull beats on every Slack call; one silent this long died with its worker, and the next alarm or
 *  Sync starts another (cursors are kept per channel, so it resumes). */
const STALE_LOCK_MS = 2 * 60_000;
/** Chrome stops an extension service worker after 30 s without an event or an extension API call, and fetch
 *  doesn't count (first live pull, 2026-11-07: killed in the third channel, 14 calls in a row). Every Slack call
 *  and every KEEPALIVE_MS of a wait makes one. */
const KEEPALIVE_MS = 20_000;
const keepAlive = () => chrome.runtime.getPlatformInfo().then(() => {});
async function wakefulSleep(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= KEEPALIVE_MS) {
    await new Promise((r) => setTimeout(r, Math.min(left, KEEPALIVE_MS)));
    await keepAlive();
  }
}

const status = (text: string) => chrome.storage.session.set({ pull_status: `${new Date().toLocaleTimeString()}: ${text}` });

/** Every pull's outcome, overwritten each time: times, counts and channel errors, never content or the session, so
 *  a pull that found nothing new still leaves a record outside the browser (live check, 2026-11-07). */
const PULL_STATUS_FILE = "hackrecon/pull-status.json";

async function download(path: string, text: string): Promise<string | null> {
  if ((path !== PULL_STATUS_FILE && !SYNC_FILE.test(path)) || path.includes("..")) return `${path}: refused: not a sync file`;
  for (const part of splitParts(path, new TextEncoder().encode(text))) {
    try {
      await chrome.downloads.download({ url: `data:application/json;base64,${base64(part.bytes)}`, filename: part.name, conflictAction: "overwrite", saveAs: false });
    } catch (e) {
      return `${part.name}: ${(e as Error).message}`;
    }
  }
  return null;
}

async function runPull(reason: "popup" | "timer" | "handoff"): Promise<void> {
  const { slack, pulling } = (await chrome.storage.session.get(["slack", "pulling"])) as { slack?: SlackSession; pulling?: number };
  if (!slack) {
    await status("no Slack session in memory: open the event's Slack tab and pulls resume");
    return void (await download(PULL_STATUS_FILE, JSON.stringify({ outcome: "no-session", reason, at: new Date().toISOString() }, null, 2)));
  }
  if (pulling && Date.now() - pulling < STALE_LOCK_MS) return;
  await chrome.storage.session.set({ pulling: Date.now() });
  // Not secret: when the last pull began, so a hand-off after a restart knows whether one is due.
  await chrome.storage.local.set({ last_pull_at: Date.now() });
  const since = new Date().toLocaleTimeString();
  let calls = 0;
  // The heartbeat is the keep-alive too: an extension API call before every Slack request.
  const beat = (method: string) => chrome.storage.session.set({ pulling: Date.now(), pull_status: `running since ${since}: call ${++calls} (${method}) at ${new Date().toLocaleTimeString()}` });
  const api = new SlackApi(slack.origin, slack.token, {
    fetch: async (u, i) => (await beat(u.slice(u.lastIndexOf("/") + 1)), fetch(u, i)),
    sleep: wakefulSleep,
    now: Date.now,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let saved = 0;
  const save = async (name: string, value: unknown): Promise<string | null> => {
    const raw = JSON.stringify(value);
    if (api.holdsToken(raw)) return `${name}: holds the session token; not saved`;
    const text = scrubTokens(raw).html; // tokens someone pasted into a post, as everywhere else
    try {
      JSON.parse(text);
    } catch {
      return `${name}: scrubbing broke the JSON; not saved`;
    }
    const err = await download(`hackrecon/sync/${stamp}/pull/${name}`, text);
    if (!err) saved++;
    return err;
  };
  try {
    const config = (await fetch(chrome.runtime.getURL("dist/sync-config.json")).then((r) => r.json())) as SyncConfig;
    const prev = ((await chrome.storage.local.get("pull_state")).pull_state as PullState | undefined) ?? { channels: {} };
    const { state, log } = await pull(api, config, prev, { save, progress: (st) => chrome.storage.local.set({ pull_state: st }), now: Date.now });
    await chrome.storage.local.set({ pull_state: state });
    if (saved) await save("pull.json", { reason, workspace: { name: slack.workspace, origin: slack.origin, team: slack.team }, ...log });
    const posts = log.channels.reduce((n, c) => n + c.history, 0);
    const replies = log.channels.reduce((n, c) => n + c.replies, 0);
    const errors = log.channels.filter((c) => c.error).length;
    const secs = Math.round((Date.parse(log.finished_at) - Date.parse(log.started_at)) / 1000);
    await status(`${saved ? `pulled ${posts} posts and ${replies} replies from` : "nothing new in"} ${log.channels.length} channels (${log.calls} calls, ${secs} s${errors ? `, ${errors} channel errors` : ""})`);
    await download(PULL_STATUS_FILE, JSON.stringify({ outcome: "done", reason, full: log.full, started_at: log.started_at, finished_at: log.finished_at, seconds: secs, calls: log.calls, retries: log.retries, channels: log.channels.length, posts, replies, threads_read: log.channels.reduce((n, c) => n + c.threads_read, 0), errors: log.channels.filter((c) => c.error).map((c) => ({ channel: c.name, error: c.error })), bundle: saved ? `hackrecon/sync/${stamp}/` : null }, null, 2));
  } catch (e) {
    const code = e instanceof ApiError ? e.code : (e as Error).message;
    // A dead session is dropped; the next Sync from the popup brings a fresh one.
    if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(code)) await chrome.storage.session.remove("slack");
    await status(`pull stopped: ${code}`);
    await download(PULL_STATUS_FILE, JSON.stringify({ outcome: "stopped", reason, error: code, at: new Date().toISOString(), calls: api.calls, retries: api.retries, bundle: saved ? `hackrecon/sync/${stamp}/` : null }, null, 2));
  } finally {
    await chrome.storage.session.remove("pulling");
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void runPull("timer");
});

/** The timer, kept on its 30-minute rhythm from the last pull (Chrome may drop alarms on an update or a restart). */
async function ensureAlarm(dueMs: number): Promise<void> {
  if (await chrome.alarms.get(ALARM)) return;
  await chrome.alarms.create(ALARM, { periodInMinutes: PULL_EVERY_MIN, delayInMinutes: Math.max(0.5, dueMs / 60_000) });
}

/** Automatic hand-off (user 2026-11-07): a Slack tab of a workspace the user already synced passes its session on
 *  load, so pulls resume after an extension reload or a browser restart without a click. Memory only. */
async function takeSession(s: SlackSession): Promise<void> {
  const { slack } = (await chrome.storage.session.get("slack")) as { slack?: SlackSession };
  if (slack?.token !== s.token || slack.origin !== s.origin) await chrome.storage.session.set({ slack: { token: s.token, origin: s.origin, team: s.team, workspace: s.workspace } });
  const { last_pull_at } = (await chrome.storage.local.get("last_pull_at")) as { last_pull_at?: number };
  const due = pullDue(last_pull_at, Date.now(), PULL_EVERY_MIN * 60_000);
  if (due > 0) return ensureAlarm(due);
  await chrome.alarms.clear(ALARM);
  await ensureAlarm(PULL_EVERY_MIN * 60_000);
  await runPull("handoff");
}

const knownWorkspaces = async () => (((await chrome.storage.local.get("known_workspaces")).known_workspaces as KnownWorkspace[] | undefined) ?? []);

/** Content scripts run only on page load: after an install, update or reload, hand-off is injected into Slack tabs
 *  already open, and on a browser restart the reopened tabs load it themselves. */
async function injectHandoff(): Promise<void> {
  for (const tab of await chrome.tabs.query({ url: "https://app.slack.com/client/*" }))
    if (tab.id !== undefined) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/slack-session.js"] }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => void injectHandoff());
chrome.runtime.onStartup.addListener(() => void injectHandoff());

chrome.runtime.onMessage.addListener((msg: { type?: string; urls?: string[]; filename?: string; url?: string; slack?: SlackSession; team?: string; origin?: string }, sender, reply) => {
  if (msg.type === "slack-known" || msg.type === "slack-session") {
    // Only our content script in a Slack client tab, and only for the team that tab shows.
    const s = msg.type === "slack-session" ? msg.slack : { team: msg.team ?? "", origin: msg.origin ?? "", token: "", workspace: "" };
    const tabTeam = (sender.tab?.url ?? "").split("/")[4] ?? "";
    if (!fromSlackTab(sender, chrome.runtime.id) || !s || s.team !== tabTeam || !WORKSPACE_ORIGIN.test(s.origin)) {
      reply({ error: "refused" });
      return;
    }
    (async () => {
      const known = isKnown(await knownWorkspaces(), s.team, s.origin);
      if (msg.type === "slack-known" || !known || !s.token) return reply({ known });
      reply({});
      await takeSession(s);
    })();
    return true;
  }
  if (msg.type === "api-start") {
    // Only the popup (an extension page, not a content script or a web page) may hand over a session.
    const s = msg.slack;
    if (sender.id !== chrome.runtime.id || sender.tab || !s?.token || !WORKSPACE_ORIGIN.test(s.origin ?? "")) {
      reply({ error: "refused" });
      return;
    }
    (async () => {
      await chrome.storage.session.set({ slack: { token: s.token, origin: s.origin, team: s.team, workspace: s.workspace } });
      // The user's own Sync makes the workspace known: its tabs may hand over their session from now on.
      await chrome.storage.local.set({ known_workspaces: remember(await knownWorkspaces(), s) });
      await chrome.alarms.create(ALARM, { periodInMinutes: PULL_EVERY_MIN, delayInMinutes: PULL_EVERY_MIN });
      reply({});
      await runPull("popup");
    })();
    return true;
  }
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
    reply(out);
  })();
  return true;
});
