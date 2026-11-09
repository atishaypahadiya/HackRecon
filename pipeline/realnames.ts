// No real people in the repo (user 2026-11-08, TODOS "Privacy"): no name, handle, user ID or email of anyone from an
// event's Slack or Discord in a tracked file. The identities come from each local event's data (its Slack export's
// users.json and data/messages.json, which holds Discord posts too); neither is ever tracked, so in CI there is
// nothing to check against and realnames.test.ts skips.
//   full names  two or more words, as cleanName leaves them ("Dana Kim, Bright Data" → "Dana Kim")
//   handles     one word of six or more characters that isn't an English word (or one with a plural or verb ending)
//               or a sponsor's name
//   ids         Slack user IDs and Discord user IDs, exact
//   emails      from profiles and from post text
// First names alone are not checked: "Ben" or "Pat" would match half the docs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanName } from "./redact.ts";

export interface Identities {
  full: Set<string>;
  handles: Set<string>;
  ids: Set<string>;
  emails: Set<string>;
}
export interface Person {
  id?: string;
  names: (string | undefined)[];
  email?: string;
}
export interface Hit {
  file: string;
  line: number;
  kind: "full name" | "handle" | "id" | "email";
  match: string;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** An English word, or one with a plural or verb ending: the system word list has "founder", not "founders". */
const isCommon = (w: string, common: Set<string>) =>
  common.has(w) || ["s", "es", "ed", "ing", "er", "ers"].some((end) => w.endsWith(end) && common.has(w.slice(0, -end.length)));
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._'-]*/gu) ?? []).map((w) => w.replace(/[._'-]+$/, ""));

/** The identities to look for. `common` is words that are never someone's handle on their own (English words,
 *  sponsor names): "founders" is a Cal Hacks member's handle and also an English word. */
export function identities(people: Person[], postTexts: string[], common: Set<string>): Identities {
  const out: Identities = { full: new Set(), handles: new Set(), ids: new Set(), emails: new Set() };
  for (const p of people) {
    if (p.id) out.ids.add(p.id);
    if (p.email) out.emails.add(p.email.toLowerCase());
    for (const raw of p.names) {
      const w = words(cleanName(raw ?? ""));
      if (w.length >= 2 && w.every((x) => x.length >= 2)) out.full.add(w.join(" "));
      else if (w.length === 1 && w[0]!.length >= 6 && !/^\d+$/.test(w[0]!) && !isCommon(w[0]!, common)) out.handles.add(w[0]!);
    }
  }
  for (const t of postTexts) for (const e of t.match(EMAIL) ?? []) out.emails.add(e.toLowerCase());
  return out;
}

/** Every line of `text` that names someone in `ids`. */
export function findIn(file: string, text: string, ids: Identities): Hit[] {
  const hits: Hit[] = [];
  const lengths = [...new Set([...ids.full].map((n) => n.split(" ").length))];
  text.split("\n").forEach((line, i) => {
    const at = (kind: Hit["kind"], match: string) => hits.push({ file, line: i + 1, kind, match });
    for (const t of line.match(/[A-Za-z0-9]{9,20}/g) ?? []) if (ids.ids.has(t)) at("id", t);
    for (const e of line.match(EMAIL) ?? []) if (ids.emails.has(e.toLowerCase())) at("email", e);
    const w = words(line);
    for (const x of w) if (ids.handles.has(x)) at("handle", x);
    for (const k of lengths) for (let j = 0; j + k <= w.length; j++) {
      const g = w.slice(j, j + k).join(" ");
      if (ids.full.has(g)) at("full name", g);
    }
  });
  return hits;
}

type ExportUser = { id: string; name?: string; real_name?: string; is_bot?: boolean; profile?: { real_name?: string; display_name?: string; email?: string } };
type Post = { author_id?: string; author_name?: string; author_kind?: string; text?: string };

/** Each local event's people and post texts: events/<slug>/data/messages.json and the users.json of the Slack export
 *  its config names. Events without data add nothing. */
export function localEventData(eventsDir: string): { people: Person[]; texts: string[]; sources: string[] } {
  const people: Person[] = [];
  const texts: string[] = [];
  const sources: string[] = [];
  const read = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null);
  for (const slug of existsSync(eventsDir) ? readdirSync(eventsDir) : []) {
    const posts = read<Post[]>(join(eventsDir, slug, "data", "messages.json"));
    if (posts) {
      sources.push(`${slug}: ${posts.length} posts`);
      for (const m of posts) {
        if (m.author_kind !== "bot") people.push({ id: m.author_id, names: [m.author_name] });
        texts.push(m.text ?? "");
      }
    }
    const dir = read<{ slack_export?: string }>(join(eventsDir, slug, "config", "event.json"))?.slack_export?.replace(/^~(?=\/)/, homedir());
    const users = dir ? read<ExportUser[]>(join(dir, "users.json")) : null;
    if (users) {
      sources.push(`${slug}: ${users.length} members`);
      for (const u of users) if (!u.is_bot && u.id !== "USLACKBOT") people.push({ id: u.id, names: [u.name, u.real_name, u.profile?.real_name, u.profile?.display_name], email: u.profile?.email });
    }
  }
  return { people, texts, sources };
}

/** English words (the system word list, when there is one) and every event's sponsor names and aliases. */
export function commonWords(eventsDir: string): Set<string> {
  const out = new Set<string>();
  if (existsSync("/usr/share/dict/words")) for (const w of readFileSync("/usr/share/dict/words", "utf8").split("\n")) out.add(w.trim().toLowerCase());
  for (const slug of existsSync(eventsDir) ? readdirSync(eventsDir) : []) {
    const p = join(eventsDir, slug, "config", "sponsors.json");
    if (!existsSync(p)) continue;
    for (const s of Object.values(JSON.parse(readFileSync(p, "utf8")) as Record<string, { sponsor?: string; aliases?: string[] }>))
      for (const n of [s.sponsor ?? "", ...(s.aliases ?? [])]) for (const w of words(n)) out.add(w);
  }
  return out;
}
