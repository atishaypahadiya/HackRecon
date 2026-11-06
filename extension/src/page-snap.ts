// Injected by the background worker into a background tab (automatic capture, "Sync this event"). Defines a
// function the worker calls once the page has settled; it reads the rendered page and returns the snapshot.
// No requests, no clicks: if the page shows a bot check, the worker waits and gives up, it never answers one.
import { snapshotPage } from "./page.ts";

declare global {
  interface Window {
    __hackreconSnap?: () => string;
  }
}

window.__hackreconSnap = () => JSON.stringify(snapshotPage(document, { url: location.href, captured_at: new Date().toISOString(), access: null, captured_by: "extension" }));
