// Pages the extension captured on its own (v2, user 2026-11-06): inside "Sync this event" it opens the event's
// Devpost pages in a background tab, because Devpost's Cloudflare refuses most plain fetches, and saves each
// snapshot under ~/Downloads/hackrecon/pages/. `hr sync` ingests them here. Pure decisions; hr.ts does the I/O.
//
// Access (D12: the flag decides redaction, never the domain). Nobody answers "is this public?" for an automatic
// capture, and the background tab carries the user's cookies, so any part of it (text, links, title) could be
// a logged-in view. It is always "authenticated": redacted before any model sees it (security review
// 2026-11-06). Public text still arrives unredacted through hr sync's own cookie-less fetch whenever that works.
import { pageKey, snapshotHash } from "./pages.ts";
import type { PageSnapshot } from "./schema.ts";

export type IngestAction = "saved" | "same" | "older" | "not_wanted";

export interface IngestDecision {
  url: string;
  action: IngestAction;
  detail: string;
  /** The snapshot to write when action is "saved", marked authenticated. */
  snapshot?: PageSnapshot;
}

export function decideIngest(snap: PageSnapshot, wanted: Set<string>, current: { hash: string; captured_at: string } | undefined): IngestDecision {
  if (!wanted.has(pageKey(snap.url))) return { url: snap.url, action: "not_wanted", detail: "not one of this event's canon or schedule pages; ignored" };
  const s: PageSnapshot = { ...snap, access: "authenticated", captured_by: "extension" };
  const hash = snapshotHash(s);
  if (current && current.hash === hash) return { url: snap.url, action: "same", detail: `same text as the current snapshot (${hash}); nothing written` };
  if (current && Date.parse(current.captured_at) >= Date.parse(snap.captured_at)) return { url: snap.url, action: "older", detail: `captured ${snap.captured_at}, the current snapshot is newer (${current.captured_at})` };
  return { url: snap.url, action: "saved", detail: `${current ? "changed" : "new"} (${hash}); authenticated, so it is redacted`, snapshot: s };
}
