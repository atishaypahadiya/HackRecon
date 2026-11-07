// Signal 2b's matcher (user 2026-11-07): a post where the writer names a sponsor as their employer. Pure, so the
// extension runs it in the page on hacker-only channels and keeps only the flag (hackerchannels.ts).
//
// Four phrasings only, each anchored on the writer, because a role or company named in passing is someone else
// ("an Early Career Recruiter at Figma", a judge list's "Founding Engineer at Apify"):
//   1. role + "at X", in the writer's introduction: "I'm a Senior Software Engineer at CRS", "I am Meredith, a
//      technical recruiter at Armadin";
//   2. "with X" as an introduction: "I'm Petros with Apify", "I am a recruiter with Microsoft";
//   3. "founder(s) of X" said of the writer: "I'm Behzad, one of the founders of Mana", "we're the founders of X";
//   4. "We're X" only as the post's first sentence, after an optional greeting ("Hey Cal Hacks! :wave:").
// Never in a question, and never X followed by a word that makes it a thing rather than an employer ("the Apify
// booth", "Apify users"). Links are dropped first.

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Case-insensitive without the i flag, for patterns that need a capital elsewhere (a person's name). */
const ci = (x: string) => escapeRe(x).replace(/\p{L}/gu, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

// No "intern": a hacker's own introduction says "I am an intern at Amazon AWS" (Cal Hacks #1-introductions), and an
// intern at a sponsor is usually there to hack.
const ROLES = ["co-founder", "cofounder", "founder", "ceo", "cto", "coo", "engineer", "developer advocate", "devrel", "recruiter", "product manager", "researcher", "employee"];
const role = `(?:${ROLES.map((r) => `${ci(r)}s?`).join("|")}|CEO|CTO|COO)`;
const I = String.raw`(?:[Ii]'?m|[Ii] am)`;
const NAME = String.raw`\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*)?`;
// The writer's introduction up to the role: "I'm a Senior Software", "I am Meredith, a technical", "My name is Tarik, I'm a".
const INTRO = String.raw`(?:(?:${I}|[Mm]y name is|[Tt]his is)\s+${NAME},?\s+(?:and\s+)?(?:${I}\s+)?|${I}\s+)(?:a|an|the|one of the)\s+(?:[\p{L}-]+\s+){0,3}?`;
const NOT_EMPLOYER = String.raw`(?!\s+(?:[Bb]ooth|[Tt]able|[Ww]orkshop|[Oo]ffice hours|[Tt]rack|[Pp]rize|[Cc]hallenge|[Cc]redits?|[Aa][Pp][Ii]|[Uu]sers?|[Ff]ans?|[Hh]ackers?|[Cc]ommunity)\b)`;
const GREETING = String.raw`^(?:(?:hi|hey|hello|howdy|greetings|good (?:morning|afternoon|evening)|welcome)\b[^\n.!?]{0,40}[!.]?(?:\s*:[\w+-]+:)*\s*)?`;

export interface SelfIdMatch {
  phrase: string;
  form: "role at" | "with" | "founder of" | "we're";
}

/** The phrase where the writer names one of `names` as their employer, or null. */
export function selfIdentification(text: string, names: string[]): SelfIdMatch | null {
  if (!names.length) return null;
  const S = `(?:${[...names].sort((a, b) => b.length - a.length).map(ci).join("|")})(?![\\p{L}\\p{N}])${NOT_EMPLOYER}`;
  const forms: [SelfIdMatch["form"], RegExp][] = [
    ["role at", new RegExp(String.raw`${INTRO}${role}\s+(?:at|@)\s+(?:[Tt]he\s+)?${S}`, "u")],
    ["with", new RegExp(String.raw`(?:(?:${I}|[Mm]y name is|[Tt]his is)\s+${NAME},?\s+|${INTRO}${role}\s+)with\s+(?:[Tt]he\s+)?${S}`, "u")],
    ["founder of", new RegExp(String.raw`(?:${I}\s+(?:${NAME},?\s+)?|[Ww]e'?re\s+|[Ww]e are\s+)(?:a|an|the|one of the)?\s*(?:${ci("co-")}|${ci("co")})?${ci("founder")}s?\s+of\s+${S}`, "u")],
  ];
  const plain = text.replace(/\s*<https?:\/\/[^>\s]+>/g, "").replace(/[‘’]/g, "'").replace(/[*_~]/g, "").replace(/ /g, " ");
  // 4: the post's first sentence, after an optional greeting.
  const opening = new RegExp(`${GREETING}(?:[Ww]e'?re|[Ww]e are)\\s+${S}`, "iu");
  const first = opening.exec(plain.trim());
  if (first && !/\?/.test(plain.trim().slice(0, first.index + first[0].length + 1))) return { phrase: first[0].replace(new RegExp(GREETING, "iu"), "").trim().slice(0, 100), form: "we're" };
  for (const sentence of plain.split(/(?<=[.!])\s+|\n+/)) {
    const t = sentence.trim();
    if (!t || /\?["')]*$/.test(t)) continue;
    for (const [form, re] of forms) {
      const m = re.exec(t);
      if (m) return { phrase: m[0].trim().slice(0, 100), form };
    }
  }
  return null;
}

/** Each sponsor `text` names as the writer's employer, for a post in a channel that isn't the sponsor's own
 *  (a hacker-only channel). `sponsors`: sponsor id → its names. */
export function selfIdSponsors(text: string, sponsors: { id: string; names: string[] }[]): string[] {
  return sponsors.filter((s) => selfIdentification(text, s.names)).map((s) => s.id);
}
