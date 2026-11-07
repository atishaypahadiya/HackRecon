// Zero setup for a new event (user 2026-11-07): `hr discover` writes event.json, sponsors.json and organizers.json from
// what the workspace and Devpost already say, with no hand-edited config. Pure; hr.ts does the reading and fetching.
//   event      the Slack workspace (its name when the extension recorded one, else its subdomain) → Devpost search
//   sponsors   Devpost prize tags matched to sidebar channel names (discover.ts sponsorsDraft)
//   organizers Slack admin and owner flags and restricted-posting posters (name tags and titles are only proposed)
//   schedule   Devpost's stated deadlines (canon rules), then organizer deadlines classified in announcement channels
// Every value carries where it came from; what discovery can't know is listed for the user, never guessed.
import type { EventConfig } from "./classify.ts";
import { firstLine } from "./planjoin.ts";
import type { Entity, Item, Message } from "./schema.ts";

/** The workspace's subdomain from the permalinks the capture holds: cal-hacks-13-0 from cal-hacks-13-0.slack.com. */
export function workspaceSubdomain(permalinks: string[]): string | null {
  const n = new Map<string, number>();
  for (const p of permalinks) {
    const m = /^https:\/\/([a-z0-9-]+)\.slack\.com\//.exec(p);
    if (m) n.set(m[1]!, (n.get(m[1]!) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** What to search Devpost for: the workspace's own name when known, else the subdomain's words. */
export function devpostQuery(workspaceName: string | null, subdomain: string | null): string | null {
  return workspaceName?.trim() || subdomain?.replace(/-/g, " ") || null;
}

/** US zone labels a Devpost deadline is written with ("October 25th @ 9 AM PST"). Others stay unknown. */
const ZONES: [RegExp, string][] = [
  [/\b(PST|PDT|PT|Pacific)\b/, "America/Los_Angeles"],
  [/\b(MST|MDT|MT|Mountain)\b/, "America/Denver"],
  [/\b(CST|CDT|CT|Central)\b/, "America/Chicago"],
  [/\b(EST|EDT|ET|Eastern)\b/, "America/New_York"],
];
export function timezoneFromQuote(quote: string): string | null {
  return ZONES.find(([re]) => re.test(quote))?.[1] ?? null;
}

/** Devpost's deadlines: canon rules that state one, earliest first; `submission` from the rule's own kind. */
export function devpostDeadlines(entities: Entity[]): { what: string; at: string; quote: string; source: string; submission: boolean }[] {
  return entities
    .filter((e) => e.kind === "rule" && typeof e.fields.deadline?.value === "string")
    .map((e) => ({ what: e.name.value ?? "Deadline", at: String(e.fields.deadline!.value), quote: e.fields.deadline!.source.quote, source: e.fields.deadline!.source.url, submission: e.fields.rule_kind?.value === "submission" }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** A post about the submission deadline itself ("extended the Devpost submission deadline", "Submit by 9:30"), not
 *  any post with "submit" in it ("submit your votes" is public voting). */
const SUBMISSION = /\bsubmissions?\s+(?:deadline|(?:are\s+|is\s+)?due)\b|\bsubmit\s+by\b/i;
/** A post's first line as a schedule label: @channel, emoji codes and markup dropped. */
const label = (text: string) =>
  firstLine(text.replace(/<!(?:channel|here|everyone)>|@(?:channel|here|everyone)\b/g, "").replace(/:[a-z0-9_+-]+:/g, "").replace(/[*_~`]/g, ""), 90).trim();

/** Organizer deadlines in announcement channels, from classified items: one entry per (post, time). A later post
 *  about submissions at a different time replaces earlier submission entries (superseded_by), as the Cal Hacks
 *  extension from 9:00 to 9:30 did. */
export type SlackDeadline = EventConfig["schedule"][number] & { submission: boolean };
export function slackDeadlines(items: Item[], messages: Message[], announcement: Set<string>, organizers: Set<string>): SlackDeadline[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: (EventConfig["schedule"][number] & { posted: number; submission: boolean })[] = [];
  for (const it of items) {
    const m = byId.get(it.message_id);
    const at = it.deadline_iso;
    if (it.kind !== "deadline" || !at || !m || !announcement.has(m.channel_name) || !m.author_id || !organizers.has(m.author_id)) continue;
    const key = `${m.id}|${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ what: label(m.text) || "Deadline", at, source: m.permalink, posted: Number(m.ts), submission: SUBMISSION.test(m.text) });
  }
  out.sort((a, b) => a.posted - b.posted);
  for (const [i, s] of out.entries()) {
    if (!s.submission) continue;
    const later = out.slice(i + 1).find((x) => x.submission && Date.parse(x.at) !== Date.parse(s.at));
    if (later) s.superseded_by = later.what;
  }
  return out.map(({ posted: _, ...s }) => s).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** "[MLH] Best Use of *" when two or more of a tag's tracks are "Best Use of" a product that isn't the tag itself:
 *  the prize is gated on using a tool, not on the tag's own product. */
export function toolGatedPatterns(tracks: Entity[]): string[] {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const by = new Map<string, number>();
  for (const t of tracks.filter((x) => x.kind === "track")) {
    const m = /^\[([^\]]+)\]\s*Best Use of\s+(.+)$/i.exec(t.name.value ?? "");
    if (m && !key(m[2]!).startsWith(key(m[1]!))) by.set(m[1]!, (by.get(m[1]!) ?? 0) + 1);
  }
  return [...by].filter(([, n]) => n >= 2).map(([tag]) => `[${tag}] Best Use of *`);
}

/** The event's name tag in display names ("CAL HACKS | Dana"): the Devpost title less its edition ("13.0", "2026"). */
export function organizerTag(eventName: string): RegExp | null {
  const words = eventName.replace(/\b(\d+(\.\d+)*|20\d\d|'\d\d)\b/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length ? new RegExp(`\\b${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")}\\b`, "i") : null;
}

export interface DiscoveredUser {
  id: string;
  is_admin?: boolean;
  is_owner?: boolean;
  deleted?: boolean;
  is_bot?: boolean;
  names: string;
  title?: string;
}
const ORG_TITLE = /director|exec|organi[sz]er|logistics/i;
type Org = { id: string; why: string[] };
/** Organizers (user IDs only), D19: only signals a hacker can't set confer authority: Slack's admin and owner flags,
 *  and posting where Slack restricts posting. A display-name tag, a profile title, or posting in a channel picked by
 *  its name are self-asserted (security review 2026-11-07): they are proposals for the user, never written. */
export function organizersFrom(
  users: DiscoveredUser[],
  tag: RegExp | null,
  restrictedPosters: string[],
  namedChannelPosters: string[] = [],
): { organizers: Org[]; proposals: Org[] } {
  const confirmed = new Map<string, string[]>();
  const proposed = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, id: string, why: string) => m.set(id, [...new Set([...(m.get(id) ?? []), why])]);
  for (const u of users) {
    if (u.deleted || u.is_bot) continue;
    if (u.is_admin) add(confirmed, u.id, "admin");
    if (u.is_owner) add(confirmed, u.id, "owner");
  }
  for (const id of restrictedPosters) add(confirmed, id, "restricted-posting channel");
  for (const u of users) {
    if (u.deleted || u.is_bot || confirmed.has(u.id)) continue;
    if (tag?.test(u.names)) add(proposed, u.id, "event name tag");
    if (ORG_TITLE.test(u.title ?? "")) add(proposed, u.id, "title");
  }
  for (const id of namedChannelPosters) if (!confirmed.has(id)) add(proposed, id, "posted in a channel named like announcements");
  const list = (m: Map<string, string[]>) => [...m].map(([id, why]) => ({ id, why }));
  return { organizers: list(confirmed), proposals: list(proposed) };
}

/** Local wall time of an instant in tz, with its offset: 2026-10-09T15:40:59-07:00. */
export function localIso(ms: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const off = p.timeZoneName === "GMT" ? "+00:00" : String(p.timeZoneName).replace("GMT", "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

export interface EventDraft {
  config: EventConfig & { oldest_message?: string; unconfirmed: string[] };
  /** Where each field came from. */
  sources: Record<string, string>;
}

/** event.json from the Devpost hit, canon and the captured posts. Hacking start and end are never guessed. */
export function eventDraft(o: {
  title: string;
  root: string;
  why: string;
  entities: Entity[];
  slackSchedule: SlackDeadline[];
  oldestTs: number | null;
  authority: { channels: string[]; source: string } | null;
}): EventDraft {
  const dl = devpostDeadlines(o.entities);
  const zone = dl.map((d) => timezoneFromQuote(d.quote)).find(Boolean) ?? null;
  const tz = zone ?? "UTC";
  const unconfirmed = [
    "hacking_start: discovery never guesses it; fill it in from the event's schedule if a post states it.",
    "hacking_end: discovery never guesses it; the submission deadline is listed in schedule.",
  ];
  if (!zone) unconfirmed.push("timezone: no Devpost deadline names a zone (PST, EDT, …); set to UTC until one does.");
  // Devpost's deadline first; a Slack post at a different time about submissions replaces it, as on the board.
  const slackSub = o.slackSchedule.find((s) => s.submission && !s.superseded_by);
  const page = dl.map((d) => ({ what: d.what, at: d.at, source: d.source, ...(d.submission && slackSub && Date.parse(slackSub.at) !== Date.parse(d.at) ? { superseded_by: slackSub.what } : {}) }));
  // A Slack entry restating a Devpost deadline (same time, both about submissions or both not) is the same deadline.
  const same = (s: SlackDeadline) => dl.some((d) => Date.parse(d.at) === Date.parse(s.at) && d.submission === s.submission);
  const schedule = [...page, ...o.slackSchedule.filter((s) => !same(s)).map(({ submission: _, ...s }) => s)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const config: EventDraft["config"] = {
    event: o.title,
    timezone: tz,
    hacking_start: null,
    hacking_end: null,
    ...(o.oldestTs !== null ? { oldest_message: localIso(o.oldestTs * 1000, tz) } : {}),
    schedule,
    unconfirmed,
    canon_pages: [o.root, `${o.root}rules`],
    schedule_pages: [],
    ...(o.authority ? { authority_channels: o.authority.channels } : {}),
    event_level_prizes: [],
    tool_gated_prizes: toolGatedPatterns(o.entities),
  };
  return {
    config,
    sources: {
      event: o.why,
      timezone: zone ? `the zone named in Devpost's deadline ("${dl.find((d) => timezoneFromQuote(d.quote))!.quote}")` : "unknown: UTC",
      schedule: `${page.length} Devpost deadline${page.length === 1 ? "" : "s"} (canon rules) + ${o.slackSchedule.length} organizer deadline${o.slackSchedule.length === 1 ? "" : "s"} classified in announcement channels`,
      canon_pages: `the Devpost root and its /rules page`,
      authority_channels: o.authority?.source ?? "unset: channels Slack marks restricted-posting",
      tool_gated_prizes: `"Best Use of" tracks whose tag isn't the product (two or more per tag)`,
      event_level_prizes: "not derivable from the page; empty",
      oldest_message: "the oldest captured post",
    },
  };
}
