// Shared data shapes for the extension capture and the pipeline.
// Source of truth: docs/designs/hackrecon-demo-scope.md, "Schema".
// `items` live apart from `messages`, so reclassifying never touches captured data.

export const SCHEMA_VERSION = 1;

/** Slack message timestamp, e.g. "1791591648.310369". Unique per channel. */
export type Ts = string;

export const TS_RE = /^\d{10}\.\d{6}$/;

export interface Message {
  /** `<channel_id>:<ts>` */
  id: string;
  channel_id: string;
  channel_name: string;
  ts: Ts;
  /** Set only for thread replies; top-level messages leave it unset. */
  thread_ts?: Ts;
  /** A thread reply also sent to the channel (thread_ts = its parent). Plain posts leave it unset. */
  subtype?: "thread_broadcast";
  author_name: string;
  /** Only when Slack renders it inline (D6). Profile cards are never opened. */
  author_title?: string;
  /** Slack user ID, only if the DOM exposes it (TODOS: organizers.json → user IDs only). */
  author_id?: string;
  /** "bot" for app/bot posts (kept, never skipped). */
  author_kind?: "user" | "bot";
  /** Slack Connect / external-organization badge on the sender (A5 rep signal). */
  author_external?: boolean;
  /** Anchors serialized as `label <href>` (OV7). */
  text: string;
  /** Every href in the message body, in order (OV7, needed for URL merge). */
  links: string[];
  permalink: string;
  /** ISO 8601 */
  captured_at: string;
  run_id: string;
}

export const ITEM_KINDS = ["credit", "job", "prize", "workshop", "deadline", "other"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const AMOUNT_UNITS = ["USD", "credits", "tokens", "hours", "other"] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

export const AMOUNT_BASES = ["per_person", "per_team", "pool", "up_to", "unknown"] as const;
export type AmountBasis = (typeof AMOUNT_BASES)[number];

export const DEADLINE_STATUSES = ["explicit", "resolved_relative", "unresolved", "none"] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

export interface Item {
  message_id: string;
  item_index: number;
  kind: ItemKind;
  /** Normalized via config/sponsors.json; "event" when no sponsor applies. */
  sponsor: string;
  offer_key: string;
  amount_text: string;
  amount_value?: number;
  amount_unit: AmountUnit;
  amount_basis: AmountBasis;
  /** Set only when amount_unit = USD and amount_basis = per_person. Never estimated. */
  amount_usd_per_person?: number;
  /** ISO 8601 with an explicit offset. */
  deadline_iso?: string;
  deadline_status: DeadlineStatus;
  urls: string[];
  model: string;
  classified_at: string;
}

export interface Rep {
  /** `<sponsor>|<author_name>` */
  rep_key: string;
  sponsor: string;
  author_name: string;
  author_title?: string;
  sample_message_id: string;
  opener: string;
  confirmed: boolean;
  model: string;
  generated_at: string;
}

export interface Run {
  run_id: string;
  started_at: string;
  channels: string[];
  message_count: number;
  source: "extension";
}

export const STOP_REASONS = ["channel_start", "no_new_keys", "user_stopped", "max_steps"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** What the extension downloads as `<channel_id>.json`, one per channel. */
export interface CaptureFile {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  source: "extension";
  channel_id: string;
  channel_name: string;
  started_at: string;
  finished_at: string;
  /** Which stop fired (D3). */
  stop_reason: StopReason;
  scroll_steps: number;
  /** Joins, renames, topic changes etc. seen and not captured (D8). Includes non_posts_skipped. */
  system_rows_skipped: number;
  /** Rows with a ts that aren't posts, by reason (pipeline/rows.ts). Absent in captures made before 2026-10-27 cleanup. */
  non_posts_skipped?: Partial<Record<"list_top" | "tombstone" | "slack_ui_notice", number>>;
  /** ts of messages whose grouped author never resolved to a rendered header. */
  unresolved_authors: Ts[];
  messages: Message[];
}

export function messageId(channelId: string, ts: Ts): string {
  return `${channelId}:${ts}`;
}

/** Throws with a path-qualified reason if `v` isn't a CaptureFile. */
export function parseCaptureFile(v: unknown, where = "capture"): CaptureFile {
  const o = obj(v, where);
  if (o.schema_version !== SCHEMA_VERSION) fail(`${where}.schema_version`, `expected ${SCHEMA_VERSION}`);
  if (o.source !== "extension") fail(`${where}.source`, 'expected "extension"');
  for (const k of ["run_id", "channel_id", "channel_name", "started_at", "finished_at"]) str(o[k], `${where}.${k}`);
  if (!STOP_REASONS.includes(o.stop_reason as StopReason)) fail(`${where}.stop_reason`, `not one of ${STOP_REASONS.join("|")}`);
  num(o.scroll_steps, `${where}.scroll_steps`);
  num(o.system_rows_skipped, `${where}.system_rows_skipped`);
  arr(o.unresolved_authors, `${where}.unresolved_authors`).forEach((t, i) => tsStr(t, `${where}.unresolved_authors[${i}]`));
  arr(o.messages, `${where}.messages`).forEach((m, i) => checkMessage(m, `${where}.messages[${i}]`, o.channel_id as string));
  return o as unknown as CaptureFile;
}

function checkMessage(v: unknown, where: string, channelId: string): void {
  const m = obj(v, where);
  for (const k of ["channel_name", "author_name", "text", "permalink", "captured_at", "run_id"]) str(m[k], `${where}.${k}`);
  if (m.channel_id !== channelId) fail(`${where}.channel_id`, `expected ${channelId}`);
  tsStr(m.ts, `${where}.ts`);
  if (m.id !== messageId(channelId, m.ts as Ts)) fail(`${where}.id`, "expected <channel_id>:<ts>");
  if (m.thread_ts !== undefined) tsStr(m.thread_ts, `${where}.thread_ts`);
  if (m.subtype !== undefined && (m.subtype !== "thread_broadcast" || m.thread_ts === undefined)) {
    fail(`${where}.subtype`, 'expected "thread_broadcast" with thread_ts set');
  }
  arr(m.links, `${where}.links`).forEach((l, i) => str(l, `${where}.links[${i}]`));
}

function fail(path: string, why: string): never {
  throw new Error(`${path}: ${why}`);
}
function obj(v: unknown, p: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p, "expected an object");
  return v as Record<string, unknown>;
}
function arr(v: unknown, p: string): unknown[] {
  if (!Array.isArray(v)) fail(p, "expected an array");
  return v;
}
function str(v: unknown, p: string): void {
  if (typeof v !== "string") fail(p, "expected a string");
}
function num(v: unknown, p: string): void {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(p, "expected a number");
}
function tsStr(v: unknown, p: string): void {
  if (typeof v !== "string" || !TS_RE.test(v)) fail(p, "expected a Slack ts like 1791591648.310369");
}
