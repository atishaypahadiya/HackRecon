// Sponsor reps beyond A5's name/title and external badge (user 2026-11-07), strongest first:
//   1. confirmed: a profile email on the sponsor's domain (sponsors.json `domains`), from the users.json snapshot;
//   2. confirmed: an authority account (D19: an admin/owner-backed organizer id, or any post in an authority
//      channel) mentions the person's user ID on a line that names the sponsor, and no other sponsor;
//   3. likely staff: posted a classified credit, prize or workshop post at the top of the sponsor's own channel, AND
//      answered a hacker's question in one of its threads, AND never posted in a hacker-only channel.
// Confirmed reps count as sponsor-side (roles.ts rolesById). Likely staff never does: no authority over links or
// offers, no classifier hint; it's shown with its evidence. Keyed by person (people.ts), never by name.
import { existsSync, readFileSync } from "node:fs";
import { REP_SIGNALS_PATH } from "./event.ts";
import type { Sponsors } from "./pool.ts";
import type { A5Signal, PosterRole } from "./roles.ts";
import type { Item, Message } from "./schema.ts";

/** Hacker-only channels when event.json lists none: team formation and introductions, by name. A name proves
 *  nothing about who posts there, but here it can only take a rep away, never add one. */
export const HACKER_ONLY = /(^|[-_])(team[-_]?formation|introductions?)$/i;
const STAFF_KINDS = new Set(["credit", "prize", "workshop"]);

export type RepSignal =
  | { kind: "email domain"; domain: string }
  | { kind: "organizer mention"; by: string; permalink: string }
  | { kind: "likely staff"; posts: Evidence[]; answers: Evidence[] };

/** A post that counts toward signal 3: its time (epoch seconds), so a replay counts only what was posted by then. */
export interface Evidence {
  ts: number;
  permalink: string;
}

export interface RepEvidence {
  person: string;
  accounts: string[];
  sponsor: string;
  standing: "confirmed" | "likely";
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

/** Signal 3, by person. `hackerPosters` is everyone who posted in a hacker-only channel; null when those channels
 *  weren't read, and then no one is likely staff (the rule can't be checked). `role` decides whose question counts
 *  as a hacker's: a parent post whose author is neither organizer nor sponsor-side. */
export function likelyReps(o: {
  messages: Message[];
  replies: Message[];
  items: Item[];
  sponsors: Sponsors;
  role: (m: Message) => PosterRole;
  person: (id: string) => string;
  hackerPosters: Set<string> | null;
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
    .filter(([key]) => answers.has(key) && !o.hackerPosters!.has(key.split("|")[0]!))
    .map(([key, ps]) => {
      const [who, sponsor] = key.split("|") as [string, string];
      const byTs = (a: Evidence, b: Evidence) => a.ts - b.ts;
      return { person: who, accounts: [...accounts.get(key)!].sort(), sponsor, posts: ps.sort(byTs), answers: answers.get(key)!.sort(byTs) };
    });
}

/** Merges the three signals into one entry per person and sponsor, strongest signal first. */
export function repEvidence(
  email: { id: string; sponsor: string; domain: string }[],
  mention: { id: string; sponsor: string; by: string; permalink: string }[],
  likely: { person: string; accounts: string[]; sponsor: string; posts: Evidence[]; answers: Evidence[] }[],
  person: (id: string) => string,
): RepEvidence[] {
  const by = new Map<string, RepEvidence>();
  const entry = (who: string, sponsor: string) => {
    const key = `${who}|${sponsor}`;
    if (!by.has(key)) by.set(key, { person: who, accounts: [], sponsor, standing: "likely", signals: [] });
    return by.get(key)!;
  };
  const account = (e: RepEvidence, ids: string[]) => (e.accounts = [...new Set([...e.accounts, ...ids])].sort());
  for (const x of email) {
    const e = entry(person(x.id), x.sponsor);
    account(e, [x.id]);
    if (!e.signals.some((s) => s.kind === "email domain")) e.signals.push({ kind: "email domain", domain: x.domain });
  }
  for (const x of mention) {
    const e = entry(person(x.id), x.sponsor);
    account(e, [x.id]);
    if (!e.signals.some((s) => s.kind === "organizer mention")) e.signals.push({ kind: "organizer mention", by: x.by, permalink: x.permalink });
  }
  for (const x of likely) {
    const e = entry(x.person, x.sponsor);
    account(e, x.accounts);
    e.signals.push({ kind: "likely staff", posts: x.posts, answers: x.answers });
  }
  for (const e of by.values()) e.standing = e.signals.some((s) => s.kind !== "likely staff") ? "confirmed" : "likely";
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
    const into = e.standing === "confirmed" ? ix.confirmed : ix.likely;
    into.set(who, (into.get(who) ?? new Set()).add(e.sponsor));
    ix.signals.set(`${who}|${e.sponsor}`, [...(ix.signals.get(`${who}|${e.sponsor}`) ?? []), ...e.signals]);
  }
  return ix;
}

/** No file yet: no one beyond A5's signals. */
export function loadRepIndex(person: (id: string) => string = (id) => id, path = REP_SIGNALS_PATH): RepIndex {
  return repIndex(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RepSignalsFile) : null, person);
}

/** When signal 3 first holds: both a staff post and an answer are in (epoch seconds); null if it never does. The
 *  hacker-only rule reads the whole capture or export, so a replay can only drop someone, never add them. */
export function likelySince(file: RepSignal[] = []): number | null {
  const s = file.find((x) => x.kind === "likely staff");
  return s?.kind === "likely staff" && s.posts.length && s.answers.length ? Math.max(s.posts[0]!.ts, s.answers[0]!.ts) : null;
}

/** What a rep matched, strongest first, as shown on the board and Plan; signal 3's counts as of `nowSec`. */
export function signalLabels(a5: A5Signal[], file: RepSignal[] = [], nowSec = Infinity): string[] {
  const out: string[] = [];
  for (const s of file) if (s.kind === "email domain") out.push(`email on ${s.domain}`);
  if (file.some((s) => s.kind === "organizer mention")) out.push("named by an organizer");
  if (a5.includes("external badge")) out.push("external badge");
  if (a5.includes("name or title")) out.push("name or title");
  for (const s of file) {
    if (s.kind !== "likely staff") continue;
    const p = s.posts.filter((e) => e.ts <= nowSec).length, a = s.answers.filter((e) => e.ts <= nowSec).length;
    if (p && a) out.push(`likely staff: ${p} offer, prize or workshop post${p === 1 ? "" : "s"}, ${a} answer${a === 1 ? "" : "s"} to hackers`);
  }
  return out;
}
