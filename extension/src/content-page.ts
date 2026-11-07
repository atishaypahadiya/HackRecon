// Injected into the open tab by the popup's "Capture this page" (v2 D11). Reads the rendered page once,
// in reading order, and downloads it as <host>-<path>.page.json. No requests, nothing sent anywhere.
// The popup sets window.__hackreconPageAccess first: the user's answer to "can anyone open this page
// without logging in?" (D12). It decides redaction downstream; it's never inferred from the domain.
import { pageFileName, type PageAccess } from "../../pipeline/schema.ts";
import { snapshotPage } from "./page.ts";

declare global {
  interface Window {
    __hackreconPageAccess?: PageAccess;
  }
}

const snap = snapshotPage(document, {
  url: location.href,
  captured_at: new Date().toISOString(),
  access: window.__hackreconPageAccess ?? null,
  captured_by: "extension",
});
const url = URL.createObjectURL(new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" }));
const a = document.createElement("a");
a.href = url;
a.download = pageFileName(location.href);
document.body.append(a);
a.click();
a.remove();
setTimeout(() => URL.revokeObjectURL(url), 10_000);
