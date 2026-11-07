export {};

const syncButton = document.getElementById("sync") as HTMLButtonElement;
const syncStatus = document.getElementById("sync-status")!;
const button = document.getElementById("capture") as HTMLButtonElement;
const status = document.getElementById("status")!;
const pageButton = document.getElementById("capture-page") as HTMLButtonElement;
const pageStatus = document.getElementById("page-status")!;

syncButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://app.slack.com/client/")) {
    syncStatus.textContent = "Open the event's Slack at app.slack.com first.";
    return;
  }
  syncButton.disabled = true;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/sync.js"] });
  syncStatus.textContent = "Syncing in the tab. Its overlay shows progress; files land in Downloads/hackrecon/sync/.";
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
