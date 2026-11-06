// Pages the extension captured on its own (v2, user 2026-11-06): inside "Sync this event" it opens the event's
// Devpost pages in a background tab, because Devpost's Cloudflare refuses most plain fetches, and saves each
// snapshot under ~/Downloads/hackrecon/pages/. `hr sync` ingests them here. Pure decisions; hr.ts does the I/O.
//
// Access (D12: the flag decides redaction, never the domain). Nobody answers "is this public?" for an automatic
// capture, and the background tab carries the user's cookies, so a logged-in view could differ from the public
// one. A capture counts as public only when its text hashes exactly to a snapshot HackRecon fetched without
// cookies for that URL (data/fetch_log.json keeps those hashes); anything else is "authenticated", redacted
// before any model sees it (security review 2026-11-06).
import { pageKey, snapshotHash } from "./pages.ts";
import type { PageSnapshot } from "./schema.ts";

export type IngestAction = "saved" | "same" | "older" | "not_wanted";

export interface IngestDecision {
  url: string;
  action: IngestAction;
  access: "public" | "authenticated";
  detail: string;
  /** The snapshot to write when action is "saved", with access set. */
  snapshot?: PageSnapshot;
}

/** URL key → hashes of snapshots fetched without cookies (HTTP 200), with when each was last seen. */
export type PublicSeen = Record<string, Record<string, string>>;

export function decideIngest(snap: PageSnapshot, wanted: Set<string>, current: { hash: string; captured_at: string } | undefined, seen: PublicSeen): IngestDecision {
  const key = pageKey(snap.url);
  const hash = snapshotHash({ ...snap, captured_by: "extension" });
  const publicAt = seen[key]?.[hash];
  const access = publicAt ? "public" : "authenticated";
  if (!wanted.has(key)) return { url: snap.url, action: "not_wanted", access, detail: "not one of this event's canon or schedule pages; ignored" };
  const s: PageSnapshot = { ...snap, access, captured_by: "extension" };
  if (current && current.hash === hash) return { url: snap.url, action: "same", access, detail: `same text as the current snapshot (${hash})` };
  if (current && Date.parse(current.captured_at) >= Date.parse(snap.captured_at)) return { url: snap.url, action: "older", access, detail: `captured ${snap.captured_at}, the current snapshot is newer (${current.captured_at})` };
  const why = access === "public" ? `public: same text as a cookie-less fetch on ${publicAt!.slice(0, 10)}` : "authenticated: its text matches no cookie-less fetch, so it is redacted";
  return { url: snap.url, action: "saved", access, detail: `${current ? "changed" : "new"} (${hash}); ${why}`, snapshot: s };
}
