// Redaction before any API call (R3-19, OV2). Poster names become [person], mentions @person.
// Sponsor names, aliases and common words are never treated as names, so "Bright Data" or
// "grant" survive even though posters are called "Dani Kaye, Bright Data" and "Grant …".
import type { Sponsors } from "./pool.ts";

/** Words that are also first names or tokens of poster names (design doc list + measured collisions). */
export const STOPWORDS = new Set(
  [
    "data", "bright", "long", "grant", "mark", "park", "sun", "ai", "cal", "hacks", "fetch", "factory",
    "will", "may", "june", "april", "august", "rose", "hope", "joy", "faith", "grace", "chase", "dawn",
    "summer", "winter", "bill", "art", "max", "ray", "drew", "page", "lane", "young", "king", "rich",
    "sunny", "dev", "team", "mentor", "judge", "the", "and", "for", "you", "all", "new", "one", "labs",
    // places and apps that are also poster names (measured on the labeled set: "San Francisco", GitHub)
    "san", "francisco", "jose", "berkeley", "palace", "github", "slack", "devpost",
  ],
);

export interface NameList {
  /** Cleaned multi-word names, longest first: matched case-insensitively. */
  full: string[];
  /** Single name tokens: matched only when capitalized in the text. */
  tokens: string[];
  /** Raw author names as rendered, longest first: for `@Name [Tag]` mentions. */
  raw: string[];
}

/** "Dani Kaye, Bright Data" → "Dani Kaye"; "[CAL HACKS] Eric Cao" → "Eric Cao";
 *  "Olivia (Ziqi) Wang" → "Olivia Wang"; "Ali - Mana" → "Ali". */
export function cleanName(name: string): string {
  return name
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+[-–|]\s+.*$/, "")
    .replace(/,.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildNameList(authorNames: Iterable<string>, sponsors: Sponsors): NameList {
  const sponsorWords = new Set(
    Object.values(sponsors)
      .flatMap((s) => [s.sponsor, ...s.aliases])
      .flatMap((s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u))
      .filter(Boolean),
  );
  const skip = (t: string) => t.length < 3 || STOPWORDS.has(t.toLowerCase()) || sponsorWords.has(t.toLowerCase()) || /^\d+$/.test(t);
  const full = new Set<string>();
  const tokens = new Set<string>();
  const raw = new Set<string>();
  for (const name of authorNames) {
    if (!name.trim()) continue;
    raw.add(name.trim());
    const clean = cleanName(name);
    const parts = clean.split(/[^\p{L}\p{N}.'’_-]+/u).map((t) => t.replace(/^[.'’_-]+|[.'’_-]+$/g, "")).filter(Boolean);
    if (parts.length > 1) full.add(clean);
    for (const t of parts) if (!skip(t)) tokens.add(t[0]!.toUpperCase() + t.slice(1));
  }
  const byLen = (a: string, b: string) => b.length - a.length;
  return { full: [...full].sort(byLen), tokens: [...tokens].sort(byLen), raw: [...raw].sort(byLen) };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";
const KEEP_MENTIONS = /^(?:channel|here|everyone|person)$/i;

/** Compiled once per name list; `redact` is called per message. */
export function compileRedactor(names: NameList): (text: string) => { text: string; replaced: number } {
  const alt = (xs: string[]) => xs.map(esc).join("|");
  const rawMention = names.raw.length ? new RegExp(`@(?:${alt(names.raw)})${R}`, "gu") : null;
  const fullMention = names.full.length ? new RegExp(`@(?:${alt(names.full)})${R}`, "giu") : null;
  const full = names.full.length ? new RegExp(`${L}(?:${alt(names.full)})${R}`, "giu") : null;
  const token = names.tokens.length ? new RegExp(`${L}(?:${alt(names.tokens)})${R}`, "gu") : null;
  return (text) => {
    let n = 0;
    const sub = (re: RegExp | null, to: string) => {
      if (re) text = text.replace(re, () => (n++, to));
    };
    text = text.replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, () => (n++, "@person"));
    sub(rawMention, "@person");
    sub(fullMention, "@person");
    // Any other rendered @mention; not the @ inside an email address.
    text = text.replace(/(?<![\p{L}\p{N}._%+-])@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu, (m, name: string) => (KEEP_MENTIONS.test(name) ? m : (n++, "@person")));
    sub(full, "[person]");
    sub(token, "[person]");
    return { text, replaced: n };
  };
}
