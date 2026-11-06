// Which pages "Sync this event" opens in a background tab (v2, user 2026-11-06). DOM-free so it can be tested.
// From an announcement channel's capture: the event's Devpost root and /rules, always (host-limited by the
// manifest to *.devpost.com). Schedule candidates only when Slack's restricted-posting flag is set on that
// capture: a page opened with the user's cookies must come from a post only organizers could make.
import { devpostCanonPages, discoverUrls } from "../../pipeline/discover.ts";
import type { CaptureFile } from "../../pipeline/schema.ts";

export const ANNOUNCE_NAME = /announce/i;

export function autoPageTargets(file: Pick<CaptureFile, "channel_name" | "posting_restricted" | "messages">): string[] {
  const restricted = file.posting_restricted === true;
  if (!restricted && !ANNOUNCE_NAME.test(file.channel_name)) return [];
  const found = discoverUrls(file.messages, new Set([file.channel_name]));
  const out = found.devpost ? devpostCanonPages(found.devpost.url) : [];
  if (restricted) out.push(...found.schedule.map((f) => f.url));
  return out;
}
