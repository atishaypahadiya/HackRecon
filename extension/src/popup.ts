export {};

const button = document.getElementById("capture") as HTMLButtonElement;
const status = document.getElementById("status")!;

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
