// Injected into the open Slack tab by the popup. Reads only what the web client renders while it
// scrolls the visible message pane: no Slack API calls, no profile cards, nothing sent anywhere.
// The result downloads as <channel_id>.json; nothing is kept in a service worker.
import type { CaptureFile } from "../../pipeline/schema.ts";
import { autoPageTargets } from "./autopages.ts";
import { captureChannelFile } from "./channel.ts";
import { overlay } from "./ui.ts";

declare global {
  interface Window {
    __hackreconCapture?: boolean;
  }
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

async function capture(): Promise<void> {
  const ui = overlay();
  let userStopped = false;
  ui.onStop(() => (userStopped = true));
  const r = await captureChannelFile(ui.set, () => userStopped);
  if (!r.file) {
    ui.set(`Donna: ${r.error}.`);
    ui.done();
    return;
  }
  const file = r.file;
  download(file);
  // "Sync this event" (user 2026-11-06): an announcement channel's capture also reads the event's Devpost pages
  // (and, when Slack restricts posting there, its schedule pages) in background tabs, with no click.
  const targets = autoPageTargets(file);
  if (targets.length) chrome.runtime.sendMessage({ type: "capture-pages", urls: targets }).then((r: string[] | undefined) => r && console.log("[hackrecon] pages:", r.join("; ")));
  ui.set(`Donna: ${r.summary} Saved ${file.channel_id}.json.`);
  ui.done();
}

if (!window.__hackreconCapture) {
  window.__hackreconCapture = true;
  capture()
    .catch((e) => console.error("[hackrecon] capture failed", e))
    .finally(() => (window.__hackreconCapture = false));
}
