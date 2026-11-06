// Which pages "Sync this event" opens in a background tab (v2, user 2026-11-06). DOM-free so it can be tested.
// Only the event's Devpost root and /rules, from an announcement channel's capture. Devpost is the one site the
// user asked for (its Cloudflare refuses most plain fetches); other pages a post links (schedule sites) are never
// opened automatically with the user's cookies (security review 2026-11-06).
import { devpostCanonPages, discoverUrls } from "../../pipeline/discover.ts";
import type { CaptureFile } from "../../pipeline/schema.ts";

export const ANNOUNCE_NAME = /announce/i;
/** An event's own Devpost site: https, one label under devpost.com, not Devpost's own subdomains. */
export const DEVPOST_EVENT_URL = /^https:\/\/(?!(?:www|help|info|secure|api)\.)[a-z0-9-]+\.devpost\.com\/(?:rules)?$/;

export function autoPageTargets(file: Pick<CaptureFile, "channel_name" | "posting_restricted" | "messages">): string[] {
  if (file.posting_restricted !== true && !ANNOUNCE_NAME.test(file.channel_name)) return [];
  const found = discoverUrls(file.messages, new Set([file.channel_name]));
  return found.devpost ? devpostCanonPages(found.devpost.url).filter((u) => DEVPOST_EVENT_URL.test(u)) : [];
}
