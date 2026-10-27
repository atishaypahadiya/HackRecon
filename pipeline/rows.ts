// Which rendered rows are real channel posts. Shared by the extension parser (new captures) and
// pipeline/captures.ts (files captured before these rules existed), so both apply the same rules.
// Every rule here comes from a row observed in the day-1 capture of the locked 25 (2026-10-27).
import type { Message, Ts } from "./schema.ts";

/** The virtual list's fixed key for the slot above the oldest message (the channel intro).
 *  In 0-announcements it rendered empty, without the intro's markup. Never a post. */
export const LIST_TOP_TS = "0000000000.000001";

/** Slack client notices shown to you only (e.g. an app's ephemeral reply). Never in the export. */
const SLACK_UI_NOTICE = /^You won['’]t see this prompt again\.?$/i;

export function isSlackUiNotice(text: string): boolean {
  return SLACK_UI_NOTICE.test(text.trim());
}

/** Reply also sent to the channel: its permalink carries `?thread_ts=<parent>` (verified: all 26
 *  export thread_broadcasts in the locked 25, no false positives across 1,011 captured rows). */
export function broadcastParent(permalink: string, ts: Ts): Ts | null {
  const m = /[?&]thread_ts=(\d{10}\.\d{6})/.exec(permalink);
  return m && m[1] !== ts ? m[1]! : null;
}

export type NonPost = "list_top" | "tombstone" | "slack_ui_notice";

/** Why a row that has a ts is not a post, or null if it is one.
 *  `tombstone`: deleted parents render with no permalink and no body; every real post,
 *  grouped ones included, has a timestamp permalink. */
export function nonPostReason(row: { ts: Ts; permalink: string; text: string; hasBody: boolean }): NonPost | null {
  if (row.ts === LIST_TOP_TS) return "list_top";
  if (!row.permalink && !row.hasBody) return "tombstone";
  if (isSlackUiNotice(row.text)) return "slack_ui_notice";
  return null;
}

/** The same rules applied to an already-captured message (no DOM left; empty text stands in for no body). */
export function nonPostMessage(m: Message): NonPost | null {
  return nonPostReason({ ts: m.ts, permalink: m.permalink, text: m.text, hasBody: m.text !== "" });
}
