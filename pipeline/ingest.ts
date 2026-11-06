// Pages the extension captured on its own (v2, user 2026-11-06): inside "Sync this event" it opens the event's
// Devpost pages in a background tab, because Devpost's Cloudflare refuses most plain fetches, and saves each
// snapshot under ~/Downloads/hackrecon/pages/. `hr sync` ingests them here. Pure decisions; hr.ts does the I/O.
//
// Access (D12: the flag decides redaction, never the domain). Nobody answers "is this public?" for an automatic
// capture, and the background tab carries the user's cookies. So a page counts as public only if HackRecon's own
// cookie-less fetch has reached it with HTTP 200 at least once (data/fetch_log.json); otherwise "authenticated",
// which is redacted before any model sees it.
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

/** URL key → ISO time of the last cookie-less HTTP 200 for it. */
export type PublicSeen = Record<string, string>;

export function decideIngest(snap: PageSnapshot, wanted: Set<string>, current: { hash: string; captured_at: string } | undefined, seen: PublicSeen): IngestDecision {
  const key = pageKey(snap.url);
  const access = seen[key] ? "public" : "authenticated";
  if (!wanted.has(key)) return { url: snap.url, action: "not_wanted", access, detail: "not one of this event's canon or schedule pages; ignored" };
  const s: PageSnapshot = { ...snap, access, captured_by: "extension" };
  const hash = snapshotHash(s);
  if (current && current.hash === hash) return { url: snap.url, action: "same", access, detail: `same text as the current snapshot (${hash})` };
  if (current && Date.parse(current.captured_at) >= Date.parse(snap.captured_at)) return { url: snap.url, action: "older", access, detail: `captured ${snap.captured_at}, the current snapshot is newer (${current.captured_at})` };
  const why = access === "public" ? `public: a cookie-less fetch got 200 on ${seen[key]!.slice(0, 10)}` : "authenticated: no cookie-less fetch has reached it yet, so it is redacted";
  return { url: snap.url, action: "saved", access, detail: `${current ? "changed" : "new"} (${hash}); ${why}`, snapshot: s };
}
