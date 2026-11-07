export {};

const syncButton = document.getElementById("sync") as HTMLButtonElement;
const syncStatus = document.getElementById("sync-status")!;
const button = document.getElementById("capture") as HTMLButtonElement;
const status = document.getElementById("status")!;
const pageButton = document.getElementById("capture-page") as HTMLButtonElement;
const pageStatus = document.getElementById("page-status")!;

chrome.storage.session.get("pull_status").then((r) => {
  if (r.pull_status) syncStatus.textContent = `Last background pull ${r.pull_status}`;
});

syncButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://app.slack.com/client/")) {
    syncStatus.textContent = "Open the event's Slack at app.slack.com first.";
    return;
  }
  syncButton.disabled = true;
  // The API pull (user 2026-11-07): the open Slack tab's own session, handed to the service worker, which reads the
  // event's channels through read-only methods in the background. Without one, the tab is synced as rendered.
  const [found] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      try {
        const team = location.pathname.split("/")[2] ?? "";
        const t = (JSON.parse(localStorage.getItem("localConfig_v2") ?? "null") as { teams?: Record<string, { token?: string; url?: string; name?: string }> } | null)?.teams?.[team];
        return t?.token && t.url ? { token: t.token, origin: new URL(t.url).origin, team, workspace: t.name ?? "" } : null;
      } catch {
        return null;
      }
    },
  });
  const slack = found?.result;
  if (slack) {
    const r = (await chrome.runtime.sendMessage({ type: "api-start", slack })) as { error?: string } | undefined;
    if (!r?.error) {
      syncStatus.textContent = `Syncing ${slack.workspace || "this workspace"} in the background through Slack's read-only API, then every 30 minutes while the browser is open. Files land in Downloads/hackrecon/sync/.`;
      return;
    }
  }
  // The event's channels, written at build time from its config (extension/build-config.ts).
  const config = await fetch(chrome.runtime.getURL("dist/sync-config.json")).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (c: unknown) => void ((window as unknown as { __hackreconSyncConfig: unknown }).__hackreconSyncConfig = c), args: [config] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/sync.js"] });
  syncStatus.textContent = "Syncing in the tab as rendered (no Slack session to pull with). Its overlay shows progress; files land in Downloads/hackrecon/sync/.";
});

button.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://app.slack.com/client/")) {
    status.textContent = "Open a channel at app.slack.com first.";
    return;
  }
  button.disabled = true;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
  status.textContent = "Capturing in the tab. Watch its overlay; the file downloads when it stops.";
});

const access = () => (document.querySelector('input[name="access"]:checked') as HTMLInputElement | null)?.value as "public" | "authenticated" | undefined;
document.querySelectorAll('input[name="access"]').forEach((r) => r.addEventListener("change", () => (pageButton.disabled = !access())));

// D12: the user's answer, not the domain, decides whether the page text is redacted downstream.
pageButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const chosen = access();
  if (!tab?.id || !chosen || !/^https?:/.test(tab.url ?? "")) {
    pageStatus.textContent = "Open the page in this tab first.";
    return;
  }
  if (tab.url!.startsWith("https://app.slack.com/")) {
    pageStatus.textContent = "This is Slack: use Capture this channel.";
    return;
  }
  pageButton.disabled = true;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (a: string) => void ((window as unknown as { __hackreconPageAccess: string }).__hackreconPageAccess = a), args: [chosen] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content-page.js"] });
  pageStatus.textContent = `Saved as ${chosen}. Move the .page.json from Downloads to events/<slug>/captures/pages/.`;
});
