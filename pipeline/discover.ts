// Event discovery (v2, user 2026-11-06): after one "Sync this event" in Slack, HackRecon finds the rest.
//   urls        the Devpost and schedule pages, from links in announcement posts (channels where posting is
//               restricted, or listed authority_channels); a Devpost search by event name if no post links one.
//   sponsors    a sponsors.json draft: Devpost prize tags ("[Apify] Best Use of Apify") matched to the channel
//               sidebar (spons-apify), with every unmatched tag and channel listed for the user.
//   organizers  top-level posters in restricted-posting channels (D19: a signal people can't set themselves).
// Pure functions over captured data; `hr sync` does the I/O. Config the user wrote always wins over a draft.
import type { Sponsors } from "./pool.ts";
import type { Entity, Message } from "./schema.ts";

const URL_RE = /https?:\/\/[^\s<>|"')\]]+/g;
/** A Devpost hackathon lives on its own subdomain; devpost.com/software/... are project pages. */
const DEVPOST_EVENT = /^https?:\/\/([a-z0-9-]+)\.devpost\.com(?:\/|$)/i;
const NOT_EVENT_SUBDOMAINS = new Set(["www", "help", "info", "secure", "api"]);
/** Words near a link that mark it as the event's schedule or live site. */
const SCHEDULE_WORDS = /\b(schedule|agenda|itinerary|timeline|live site|hacker guide|event guide)\b/i;
const SCHEDULE_PATH = /\/(schedule|agenda|itinerary|timeline)\b/i;
const SKIP_HOSTS = /(^|\.)(slack\.com|devpost\.com|google\.com|zoom\.us|youtube\.com|youtu\.be|linkedin\.com|twitter\.com|x\.com|instagram\.com)$/i;

const clean = (u: string) => u.replace(/[.,;:!?>]+$/, "");

export interface FoundUrl {
  url: string;
  /** Posts that link it, newest first (permalinks). */
  posts: string[];
  why: string;
}
export interface DiscoveredUrls {
  devpost: FoundUrl | null;
  /** Other Devpost hackathons linked, e.g. last year's: never canon, listed so the pick is visible. */
  devpost_other: FoundUrl[];
  schedule: FoundUrl[];
}

function linksIn(m: Message): { url: string; context: string }[] {
  const out: { url: string; context: string }[] = [];
  const seen = new Set<string>();
  for (const raw of [...(m.text.match(URL_RE) ?? []), ...(m.links ?? [])]) {
    const url = clean(raw);
    if (seen.has(url)) continue;
    seen.add(url);
    const i = m.text.indexOf(raw);
    out.push({ url, context: i >= 0 ? m.text.slice(Math.max(0, i - 160), i + url.length + 40) : m.text.slice(0, 200) });
  }
  return out;
}

/** The event's Devpost root and schedule candidates from top-level posts in the announcement channels. */
export function discoverUrls(messages: Message[], announcementChannels: Set<string>): DiscoveredUrls {
  const devpost = new Map<string, FoundUrl>();
  const schedule = new Map<string, FoundUrl>();
  const posts = messages.filter((m) => announcementChannels.has(m.channel_name) && !m.thread_ts).sort((a, b) => Number(b.ts) - Number(a.ts));
  for (const m of posts)
    for (const { url, context } of linksIn(m)) {
      const d = DEVPOST_EVENT.exec(url);
      if (d && !NOT_EVENT_SUBDOMAINS.has(d[1]!.toLowerCase())) {
        const root = `https://${d[1]!.toLowerCase()}.devpost.com/`;
        const f = devpost.get(root) ?? { url: root, posts: [], why: "" };
        f.posts.push(m.permalink);
        devpost.set(root, f);
        continue;
      }
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (SKIP_HOSTS.test(u.hostname)) continue;
      const word = SCHEDULE_WORDS.exec(context)?.[1];
      if (!word && !SCHEDULE_PATH.test(u.pathname)) continue;
      const key = `https://${u.hostname}${u.pathname.replace(/\/+$/, "") || "/"}`;
      const f = schedule.get(key) ?? { url: key, posts: [], why: word ? `linked as "${word}"` : "schedule path" };
      f.posts.push(m.permalink);
      schedule.set(key, f);
    }
  const ranked = [...devpost.values()].sort((a, b) => b.posts.length - a.posts.length);
  for (const f of ranked) f.why = `linked in ${f.posts.length} announcement post${f.posts.length === 1 ? "" : "s"}`;
  return { devpost: ranked[0] ?? null, devpost_other: ranked.slice(1), schedule: [...schedule.values()].sort((a, b) => b.posts.length - a.posts.length) };
}

/** Devpost's standard public pages for a hackathon root. */
export const devpostCanonPages = (root: string) => [root, `${root}rules`];

const normName = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|hackathon|hacks?)\b/g, (w) => (w.startsWith("hack") ? "hack" : ""))
    .replace(/\s+/g, " ")
    .trim();

export interface DevpostHit {
  title: string;
  url: string;
  submission_period_dates?: string;
  open_state?: string;
}
/** Picks the hackathon whose title matches the event name exactly (after normalizing); null when none or several do. */
export function pickDevpostHit(eventName: string, hits: DevpostHit[]): { hit: DevpostHit | null; why: string } {
  const want = normName(eventName);
  const exact = hits.filter((h) => normName(h.title) === want);
  if (exact.length === 1) return { hit: exact[0]!, why: `Devpost search: the one hackathon titled "${exact[0]!.title}"` };
  if (exact.length > 1) return { hit: null, why: `Devpost search: ${exact.length} hackathons titled "${eventName}"; list the right one in event.json canon_pages` };
  return { hit: null, why: `Devpost search: no hackathon titled "${eventName}" (${hits.length} results: ${hits.slice(0, 3).map((h) => h.title).join(", ") || "none"})` };
}

// sponsors.json draft ---------------------------------------------------------------------------------------

/** Sidebar prefixes that say what a channel is. Unknown prefixes leave the channel unmatched for the user. */
const CHANNEL_KIND: [RegExp, Sponsors[string]["kind"]][] = [
  [/^(spons|sponsor|sponsors|partner)-/, "sponsor"],
  [/^(cohost|co-host|host)-/, "cohost"],
];
/** Name words that don't tell sponsors apart ("Bitdeer AI" vs channel "bitdeer"). */
const NOISE = new Set(["ai", "labs", "lab", "inc", "io", "app", "hq", "api", "the", "co", "dev"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.ai\b/g, " ai")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w));
const key = (s: string) => words(s).join("");

export interface SponsorsDraft {
  sponsors: Sponsors;
  /** Devpost sponsor tags with no channel in the sidebar. */
  tags_without_channel: string[];
  /** Sponsor-looking channels with no Devpost tag (sponsor named from the channel, flagged for the user). */
  channels_without_tag: string[];
}

/** Devpost prize tags (canon track sponsors) matched to sidebar channel names; announcement channels are "event". */
export function sponsorsDraft(tracks: Entity[], channels: string[], announcementChannels: Set<string>): SponsorsDraft {
  const tags = [...new Set(tracks.filter((t) => t.kind === "track" && t.sponsor !== "event").map((t) => t.sponsor))].sort();
  const sponsors: Sponsors = {};
  const used = new Set<string>();
  const channels_without_tag: string[] = [];
  for (const ch of [...channels].sort()) {
    if (announcementChannels.has(ch)) {
      sponsors[ch] = { sponsor: "event", kind: "event", aliases: [] };
      continue;
    }
    const kind = CHANNEL_KIND.find(([re]) => re.test(ch));
    if (!kind) continue;
    const rest = ch.replace(kind[0], "");
    const restWords = words(rest.replace(/-/g, " "));
    // A tag matches when its words are the channel's words, or its leading words ("CRS" ~ crs-credit-api).
    const tag =
      tags.find((t) => key(t) === key(rest.replace(/-/g, " "))) ??
      tags.find((t) => {
        const tw = words(t);
        return tw.length > 0 && tw.every((w, i) => restWords[i] === w);
      }) ??
      tags.find((t) => {
        const tw = words(t);
        return restWords.length > 0 && restWords.every((w, i) => tw[i] === w);
      });
    if (tag) used.add(tag);
    else channels_without_tag.push(ch);
    const name = tag ?? rest.split("-").map((w) => (w.length <= 3 && w !== "one" ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");
    sponsors[ch] = { sponsor: name, kind: kind[1], aliases: [] };
  }
  return { sponsors, tags_without_channel: tags.filter((t) => !used.has(t)), channels_without_tag };
}

/** Agreement of a draft with a hand-written sponsors.json: per channel, same sponsor name and kind. */
export function compareSponsors(draft: Sponsors, hand: Sponsors) {
  const rows = Object.keys(hand)
    .sort()
    .map((ch) => {
      const d = draft[ch];
      const h = hand[ch]!;
      const sameName = !!d && (d.sponsor === h.sponsor || key(d.sponsor) === key(h.sponsor) || h.aliases.some((a) => key(a) === key(d.sponsor)));
      return { channel: ch, hand: `${h.sponsor} (${h.kind})`, draft: d ? `${d.sponsor} (${d.kind})` : "missing", match: sameName && d!.kind === h.kind };
    });
  return { rows, matched: rows.filter((r) => r.match).length, n: rows.length, extra: Object.keys(draft).filter((ch) => !(ch in hand)) };
}

// organizers ------------------------------------------------------------------------------------------------

export interface OrganizerProposal {
  id: string;
  name: string;
  /** Top-level posts in restricted-posting channels. */
  posts: number;
  channels: string[];
}

/** Everyone who posted top-level in a channel where Slack restricts posting: a signal hackers can't set (D19). */
export function organizersFromRestricted(messages: Message[], restricted: Set<string>): OrganizerProposal[] {
  const by = new Map<string, OrganizerProposal>();
  for (const m of messages) {
    if (!restricted.has(m.channel_name) || m.thread_ts || m.subtype || m.author_kind === "bot" || !m.author_id) continue;
    const p = by.get(m.author_id) ?? { id: m.author_id, name: m.author_name, posts: 0, channels: [] };
    p.posts++;
    if (!p.channels.includes(m.channel_name)) p.channels.push(m.channel_name);
    by.set(m.author_id, p);
  }
  return [...by.values()].sort((a, b) => b.posts - a.posts);
}
