// Sponsor reps beyond A5's name/title and external badge (user 2026-11-07), strongest first:
//   1. confirmed: a profile email on the sponsor's domain (sponsors.json `domains`), from the users.json snapshot;
//   2. confirmed: an authority account (D19: an admin/owner-backed organizer id, or any post in an authority
//      channel) mentions the person's user ID on a line that names the sponsor, and no other sponsor;
//   2b. self-identified: the person's own post in the sponsor's channel names the sponsor as their employer or
//      company ("I'm Pat with Apify", "one of the founders of Mana", "We're Wajo"), matched in code against the
//      sponsor's names. Self-asserted, like a name tag: alone it's a label and grants nothing;
//   3. likely staff: posted a classified credit, prize or workshop post at the top of the sponsor's own channel, AND
//      answered a hacker's question in one of its threads, AND never posted in a hacker-only channel, unless 2b holds:
//      then those posts are shown as a counter-signal instead (user 2026-11-07).
// Confirmed reps count as sponsor-side (roles.ts rolesById). Likely staff never does: no authority over links or
// offers, no classifier hint; it's shown with its evidence. Keyed by person (people.ts), never by name.
import { existsSync, readFileSync } from "node:fs";
import { REP_SIGNALS_PATH } from "./event.ts";
import type { Sponsors } from "./pool.ts";
import type { A5Signal, PosterRole } from "./roles.ts";
import type { Item, Message } from "./schema.ts";

export { HACKER_ONLY } from "./hackerchannels.ts";
const STAFF_KINDS = new Set(["credit", "prize", "workshop"]);

export type RepSignal =
  | { kind: "email domain"; domain: string }
  | { kind: "organizer mention"; by: string; permalink: string }
  | { kind: "self-identified"; posts: (Evidence & { phrase: string })[] }
  | { kind: "likely staff"; posts: Evidence[]; answers: Evidence[] }
  /** Counter-signal: posts in hacker-only channels (authors-only, so counts and no times). */
  | { kind: "hacker channels"; channels: { channel: string; posts: number }[] };

/** A post that counts toward signal 3: its time (epoch seconds), so a replay counts only what was posted by then. */
export interface Evidence {
  ts: number;
  permalink: string;
}

export interface RepEvidence {
  person: string;
  accounts: string[];
  sponsor: string;
  /** confirmed: signal 1 or 2 (a role). likely: signal 3 (shown, no role). label: only 2b or the counter-signal,
   *  shown beside a rep found otherwise, never making one. */
  standing: "confirmed" | "likely" | "label";
  signals: RepSignal[];
}

export interface RepSignalsFile {
  built_at: string;
  /** Where each signal's facts came from: "capture", "export (<dir>)", or "not checked: <why>". */
  sources: { emails: string; mentions: string; replies: string; hacker_only: string };
  hacker_only_channels: string[];
  rule_notes: string[];
  reps: RepEvidence[];
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const sponsorNames = (sponsors: Sponsors) => {
  const by = new Map<string, string[]>();
  for (const s of Object.values(sponsors)) if (s.sponsor !== "event") by.set(s.sponsor, [...new Set([s.sponsor, ...s.aliases, ...(by.get(s.sponsor) ?? [])])]);
  return by;
};

/** Signal 1: an email on a listed domain or its subdomain (`mail.apify.com` counts; `apify.com.evil.io` doesn't). */
export function emailReps(users: { id: string; email?: string }[], sponsors: Sponsors): { id: string; sponsor: string; domain: string }[] {
  const domains = new Map<string, string>();
  for (const s of Object.values(sponsors)) for (const d of s.domains ?? []) domains.set(d.toLowerCase().replace(/^@/, ""), s.sponsor);
  return users.flatMap((u) => {
    const host = u.email?.split("@")[1]?.toLowerCase();
    if (!host) return [];
    return [...domains].filter(([d]) => host === d || host.endsWith(`.${d}`)).map(([domain, sponsor]) => ({ id: u.id, sponsor, domain }));
  });
}

/** A post as signal 2 reads it: text plus each @-mention's user ID and rendered label. */
export interface MentionPost {
  author_id: string;
  channel_name: string;
  text: string;
  mentions: { id: string; label: string }[];
  permalink: string;
  /** A thread reply (sent to the channel or not). Restricted-posting channels still let anyone reply in threads, so
   *  a reply carries channel authority never; only its author's own authority. */
  reply: boolean;
}

/** D19 authority for signal 2: an authority account anywhere, or a top-level post in an authority channel. */
export function mentionAuthority(authorityIds: Set<string>, authorityChannels: Set<string>): (p: MentionPost) => boolean {
  return (p) => authorityIds.has(p.author_id) || (!p.reply && authorityChannels.has(p.channel_name));
}

/** Signal 2. A mention's label (the mentioned person's own display name) is cut from the line before sponsor names
 *  are read, so "@Ana [Apify]" can't name Apify for her. A line naming two or more sponsors is skipped. */
export function mentionReps(posts: MentionPost[], sponsors: Sponsors, authority: (p: MentionPost) => boolean, organizer: (id: string) => boolean): { hits: { id: string; sponsor: string; by: string; permalink: string }[]; ambiguous: number } {
  const names = sponsorNames(sponsors);
  const hits: { id: string; sponsor: string; by: string; permalink: string }[] = [];
  let ambiguous = 0;
  for (const p of posts) {
    if (!p.mentions.length || !authority(p)) continue;
    for (const line of p.text.split("\n")) {
      const here = p.mentions.filter((m) => m.label && line.includes(m.label));
      if (!here.length) continue;
      let rest = line;
      for (const m of here) rest = rest.split(m.label).join(" ");
      const named = [...names].filter(([, ns]) => ns.some((n) => norm(rest).includes(norm(n)))).map(([s]) => s);
      if (named.length > 1) ambiguous++;
      if (named.length !== 1) continue;
      for (const m of here) if (m.id !== p.author_id && !organizer(m.id)) hits.push({ id: m.id, sponsor: named[0]!, by: p.author_id, permalink: p.permalink });
    }
  }
  return { hits, ambiguous };
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Case-insensitive without the i flag, for patterns that need a capital elsewhere (a person's name). */
const ci = (x: string) => escapeRe(x).replace(/\p{L}/gu, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/** Signal 2b's matcher: the phrase in `text` where the writer names one of `names` as their own employer or company,
 *  or null. Six forms only, each anchored on the writer: "I'm <Name> with/from/at S", a role "of/at/for S"
 *  (founder, engineer, recruiter…), "we're (the team behind) S", "here from S", "I work at/for S" or "the S team", "I am a recruiter with S".
 *  A sentence ending in "?" never counts ("anyone here from Apify?"), nor S followed by booth, table, workshop,
 *  office hours, track, prize, challenge or credits ("I'm at the Apify booth"). Links are dropped first. */
export function selfIdentification(text: string, names: string[]): string | null {
  if (!names.length) return null;
  const alts = [...names].sort((a, b) => b.length - a.length);
  const S = `(?:${alts.map(ci).join("|")})`;
  const end = String.raw`(?![\p{L}\p{N}])(?!\s+(?:[Bb]ooth|[Tt]able|[Ww]orkshop|[Oo]ffice hours|[Tt]rack|[Pp]rize|[Cc]hallenge|[Cc]redits?)\b)`;
  const name = String.raw`\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*)?`;
  const forms = [
    String.raw`\b(?:[Ii]'?m|[Ii] am|[Mm]y name is|[Tt]his is)\s+${name},?\s+(?:[Ww]ith|[Ff]rom|[Aa]t)\s+(?:[Tt]he\s+)?${S}${end}`,
    String.raw`\b(?:${ci("co-founder")}s?|${ci("cofounder")}s?|${ci("founder")}s?|CEO|CTO|COO|${ci("engineer")}s?|${ci("developer advocate")}s?|${ci("devrel")}|${ci("recruiter")}s?|${ci("product manager")}s?|${ci("researcher")}s?|${ci("employee")}s?)\s+(?:of|at|for|from)\s+(?:[Tt]he\s+)?${S}${end}`,
    String.raw`\b(?:[Ww]e'?re|[Ww]e are)\s+(?:[Tt]he\s+team\s+(?:behind|at|from)\s+)?${S}${end}(?!\s+(?:users?|fans?|hackers?)\b)`,
    String.raw`\b[Hh]ere\s+(?:from|with)\s+(?:[Tt]he\s+)?${S}${end}`,
    String.raw`\b(?:[Ii] work (?:at|for)\s+${S}${end}|(?:[Ff]rom|[Oo]n) the\s+${S}\s+team\b|${S}\s+team here\b)`,
    String.raw`\b(?:[Ii]'?m|[Ii] am)\s+(?:a|an|the|one of the)\s+(?:\p{L}+\s+){0,2}?(?:${ci("recruiter")}s?|${ci("engineer")}s?|${ci("founder")}s?|${ci("developer advocate")}s?|${ci("product manager")}s?|${ci("researcher")}s?)\s+(?:[Ww]ith|[Aa]t|[Ff]rom|[Ff]or)\s+(?:[Tt]he\s+)?${S}${end}`,
  ].map((f) => new RegExp(f, "u"));
  const plain = text.replace(/\s*<https?:\/\/[^>\s]+>/g, "").replace(/[\u2018\u2019]/g, "'").replace(/[*_~]/g, "");
  for (const sentence of plain.split(/(?<=[.!])\s+|\n+/)) {
    const t = sentence.trim();
    if (!t || /\?["')]*$/.test(t)) continue;
    for (const f of forms) {
      const m = f.exec(t);
      if (m) return m[0].trim().slice(0, 100);
    }
  }
  return null;
}

/** Signal 2b over each person's own posts in each sponsor's channels (not event channels, not bots). */
export function selfIdReps(posts: Message[], sponsors: Sponsors, person: (id: string) => string): { person: string; accounts: string[]; sponsor: string; posts: (Evidence & { phrase: string })[] }[] {
  const names = sponsorNames(sponsors);
  const by = new Map<string, { accounts: Set<string>; posts: (Evidence & { phrase: string })[] }>();
  for (const m of posts) {
    const ch = sponsors[m.channel_name];
    if (!ch || ch.sponsor === "event" || !m.author_id || m.author_kind === "bot") continue;
    const phrase = selfIdentification(m.text, names.get(ch.sponsor) ?? []);
    if (!phrase) continue;
    const key = `${person(m.author_id)}|${ch.sponsor}`;
    const e = by.get(key) ?? { accounts: new Set(), posts: [] };
    e.accounts.add(m.author_id);
    e.posts.push({ ts: Number(m.ts), permalink: m.permalink, phrase });
    by.set(key, e);
  }
  return [...by].map(([key, e]) => {
    const [who, sponsor] = key.split("|") as [string, string];
    return { person: who, accounts: [...e.accounts].sort(), sponsor, posts: e.posts.sort((a, b) => a.ts - b.ts) };
  });
}

/** Signal 3, by person. `hackerPosters` is everyone who posted in a hacker-only channel; null when those channels
 *  weren't read, and then no one is likely staff (the rule can't be checked). Someone in `selfIdentified`
 *  (`person|sponsor`, signal 2b) passes despite such posts; repEvidence shows them as a counter-signal. `role`
 *  decides whose question counts as a hacker's: a parent post whose author is neither organizer nor sponsor-side. */
export function likelyReps(o: {
  messages: Message[];
  replies: Message[];
  items: Item[];
  sponsors: Sponsors;
  role: (m: Message) => PosterRole;
  person: (id: string) => string;
  hackerPosters: Set<string> | null;
  selfIdentified?: Set<string>;
}): { person: string; accounts: string[]; sponsor: string; posts: Evidence[]; answers: Evidence[] }[] {
  if (!o.hackerPosters) return [];
  const staffPost = new Set(o.items.filter((i) => STAFF_KINDS.has(i.kind)).map((i) => i.message_id));
  const byId = new Map(o.messages.map((m) => [m.id, m]));
  const posts = new Map<string, Evidence[]>();
  const answers = new Map<string, Evidence[]>();
  const accounts = new Map<string, Set<string>>();
  const add = (map: Map<string, Evidence[]>, key: string, v: Evidence, id: string) => {
    map.set(key, [...(map.get(key) ?? []), v]);
    accounts.set(key, (accounts.get(key) ?? new Set()).add(id));
  };
  for (const m of o.messages) {
    const ch = o.sponsors[m.channel_name];
    if (!ch || ch.sponsor === "event" || !m.author_id || m.author_kind === "bot" || m.thread_ts || m.subtype || o.role(m) === "organizer") continue;
    if (staffPost.has(m.id)) add(posts, `${o.person(m.author_id)}|${ch.sponsor}`, { ts: Number(m.ts), permalink: m.permalink }, m.author_id);
  }
  for (const r of o.replies) {
    const ch = o.sponsors[r.channel_name];
    if (!ch || ch.sponsor === "event" || !r.author_id || !r.thread_ts || r.author_kind === "bot" || o.role(r) === "organizer") continue;
    const parent = byId.get(`${r.channel_id}:${r.thread_ts}`);
    if (!parent?.author_id || o.person(parent.author_id) === o.person(r.author_id) || o.role(parent) !== "other" || !parent.text.includes("?")) continue;
    add(answers, `${o.person(r.author_id)}|${ch.sponsor}`, { ts: Number(r.ts), permalink: r.permalink }, r.author_id);
  }
  return [...posts]
    .filter(([key]) => answers.has(key) && (!o.hackerPosters!.has(key.split("|")[0]!) || !!o.selfIdentified?.has(key)))
    .map(([key, ps]) => {
      const [who, sponsor] = key.split("|") as [string, string];
      const byTs = (a: Evidence, b: Evidence) => a.ts - b.ts;
      return { person: who, accounts: [...accounts.get(key)!].sort(), sponsor, posts: ps.sort(byTs), answers: answers.get(key)!.sort(byTs) };
    });
}

/** Merges the signals into one entry per person and sponsor, strongest first. The counter-signal (posts in
 *  hacker-only channels) is added to an entry that exists for another reason, never creates one. */
export function repEvidence(o: {
  email: { id: string; sponsor: string; domain: string }[];
  mention: { id: string; sponsor: string; by: string; permalink: string }[];
  selfId?: { person: string; accounts: string[]; sponsor: string; posts: (Evidence & { phrase: string })[] }[];
  likely: { person: string; accounts: string[]; sponsor: string; posts: Evidence[]; answers: Evidence[] }[];
  /** person → posts per hacker-only channel. */
  hacker?: Map<string, { channel: string; posts: number }[]>;
  person: (id: string) => string;
}): RepEvidence[] {
  const by = new Map<string, RepEvidence>();
  const entry = (who: string, sponsor: string) => {
    const key = `${who}|${sponsor}`;
    if (!by.has(key)) by.set(key, { person: who, accounts: [], sponsor, standing: "label", signals: [] });
    return by.get(key)!;
  };
  const account = (e: RepEvidence, ids: string[]) => (e.accounts = [...new Set([...e.accounts, ...ids])].sort());
  for (const x of o.email) {
    const e = entry(o.person(x.id), x.sponsor);
    account(e, [x.id]);
    if (!e.signals.some((s) => s.kind === "email domain")) e.signals.push({ kind: "email domain", domain: x.domain });
  }
  for (const x of o.mention) {
    const e = entry(o.person(x.id), x.sponsor);
    account(e, [x.id]);
    if (!e.signals.some((s) => s.kind === "organizer mention")) e.signals.push({ kind: "organizer mention", by: x.by, permalink: x.permalink });
  }
  for (const x of o.selfId ?? []) {
    const e = entry(x.person, x.sponsor);
    account(e, x.accounts);
    e.signals.push({ kind: "self-identified", posts: x.posts });
  }
  for (const x of o.likely) {
    const e = entry(x.person, x.sponsor);
    account(e, x.accounts);
    e.signals.push({ kind: "likely staff", posts: x.posts, answers: x.answers });
  }
  for (const e of by.values()) {
    const h = o.hacker?.get(e.person);
    if (h?.length) e.signals.push({ kind: "hacker channels", channels: h });
    e.standing = e.signals.some((s) => s.kind === "email domain" || s.kind === "organizer mention") ? "confirmed" : e.signals.some((s) => s.kind === "likely staff") ? "likely" : "label";
  }
  return [...by.values()].sort((a, b) => a.sponsor.localeCompare(b.sponsor) || a.person.localeCompare(b.person));
}

/** The evidence file read for the board and Plan: who is confirmed (a role) and who is likely (a label only). */
export interface RepIndex {
  confirmed: Map<string, Set<string>>;
  likely: Map<string, Set<string>>;
  /** `${person}|${sponsor}` → the file's signals. */
  signals: Map<string, RepSignal[]>;
}

export function repIndex(file: RepSignalsFile | null, person: (id: string) => string = (id) => id): RepIndex {
  const ix: RepIndex = { confirmed: new Map(), likely: new Map(), signals: new Map() };
  for (const e of file?.reps ?? []) {
    // Re-keyed through today's person links: a link made after the file was built still joins its accounts.
    const who = person(e.accounts[0] ?? e.person);
    const into = e.standing === "confirmed" ? ix.confirmed : e.standing === "likely" ? ix.likely : null;
    into?.set(who, (into.get(who) ?? new Set()).add(e.sponsor));
    ix.signals.set(`${who}|${e.sponsor}`, [...(ix.signals.get(`${who}|${e.sponsor}`) ?? []), ...e.signals]);
  }
  return ix;
}

/** No file yet: no one beyond A5's signals. */
export function loadRepIndex(person: (id: string) => string = (id) => id, path = REP_SIGNALS_PATH): RepIndex {
  return repIndex(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RepSignalsFile) : null, person);
}

/** When signal 3 first holds: a staff post and an answer are in and, for someone who posted in a hacker-only
 *  channel, the self-identification that lets them pass (epoch seconds); null if it never does. Hacker-only posts
 *  carry no times (authors-only), so a replay counts them all: it can drop someone early, never add them. */
export function likelySince(file: RepSignal[] = []): number | null {
  const s = file.find((x) => x.kind === "likely staff");
  if (s?.kind !== "likely staff" || !s.posts.length || !s.answers.length) return null;
  const since = Math.max(s.posts[0]!.ts, s.answers[0]!.ts);
  if (!file.some((x) => x.kind === "hacker channels")) return since;
  const self = file.find((x) => x.kind === "self-identified");
  return self?.kind === "self-identified" && self.posts.length ? Math.max(since, self.posts[0]!.ts) : null;
}

/** What a rep matched, strongest first, as shown on the board and Plan; signal 3's counts as of `nowSec`. */
export function signalLabels(a5: A5Signal[], file: RepSignal[] = [], nowSec = Infinity): string[] {
  const out: string[] = [];
  for (const s of file) if (s.kind === "email domain") out.push(`email on ${s.domain}`);
  if (file.some((s) => s.kind === "organizer mention")) out.push("named by an organizer");
  for (const s of file) {
    const first = s.kind === "self-identified" ? s.posts.find((e) => e.ts <= nowSec) : undefined;
    if (first) out.push(`self-identified: “${first.phrase}”`);
  }
  if (a5.includes("external badge")) out.push("external badge");
  if (a5.includes("name or title")) out.push("name or title");
  for (const s of file) {
    if (s.kind !== "likely staff") continue;
    const p = s.posts.filter((e) => e.ts <= nowSec).length, a = s.answers.filter((e) => e.ts <= nowSec).length;
    const since = likelySince(file);
    if (p && a && since !== null && since <= nowSec) out.push(`likely staff: ${p} offer, prize or workshop post${p === 1 ? "" : "s"}, ${a} answer${a === 1 ? "" : "s"} to hackers`);
  }
  for (const s of file) if (s.kind === "hacker channels") out.push(`counter-signal: posted in ${s.channels.map((c) => `#${c.channel} (${c.posts})`).join(", ")}`);
  return out;
}
