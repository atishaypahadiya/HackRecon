// `hr canon`: page snapshot → verified canon entities (v2 §Extraction, D7, D12, D15). One Opus call per
// page, with a JSON schema; code then checks every value against the snapshot the model read: the quote
// is in the cited block, every number and date in the value is in the quote, enums are valid, and every
// reference names an entity from the same answer, and the gating D15 coverage checks pass on the result (a
// dropped prize, e.g. Mana's on Cal Hacks 2026-11-06, is retried, not shipped). A failed check goes back to the
// model with the error.
// Logged-in pages (access not "public") are redacted first and checked against the redacted text (D12).
import { createHash } from "node:crypto";
import { scheduleLines, type EventConfig } from "./classify.ts";
import { coverage } from "./coverage.ts";
import { pageKey } from "./pages.ts";
import { JUDGE_EFFORT, JUDGE_MODEL } from "./prelabel.ts";
import type { Entity, FieldValue, PageSnapshot } from "./schema.ts";

export const CANON_MODEL = JUDGE_MODEL;
export const CANON_EFFORT = JUDGE_EFFORT;
/** One page per request; thinking counts toward max_tokens. */
export const CANON_MAX_TOKENS = 64000;

export const CANON_KINDS = ["track", "prize", "criterion", "rule", "entry_step"] as const;
export type CanonKind = (typeof CANON_KINDS)[number];

/** Field names each kind may carry. A track's `description` and `requirement` repeat (one per sentence of the
 *  prize block, user 2026-11-06); the rest appear at most once. */
export const KIND_FIELDS: Record<CanonKind, readonly string[]> = {
  track: ["description", "requirement", "eligible_with", "max_entries", "cash_value_usd", "winners"],
  prize: ["track", "place", "award_text", "amount_usd", "per"],
  criterion: ["description", "weight", "track"],
  rule: ["text", "applies_to", "rule_kind", "deadline"],
  entry_step: ["track", "step_kind", "text"],
};
const ALL_FIELDS = [...new Set(Object.values(KIND_FIELDS).flat())];
/** kind.field pairs that repeat, stored as `<field>s[n]` ("requirements[0]", "descriptions[1]"). */
const REPEATS = new Set(["track.requirement", "track.description"]);
/** Entry steps (user 2026-11-06): what entering a track takes beyond building and ticking it on Devpost. */
export const STEP_KINDS = ["opt_in", "supplemental_form", "description_mention", "submission_field"] as const;
/** Fields whose value names another entity by its ref in the same answer (or "all"). */
const REF_FIELDS = new Set(["track", "applies_to"]);
const NUMBER_FIELDS = new Set(["max_entries", "cash_value_usd", "winners", "amount_usd", "weight"]);
const ENUMS: Record<string, readonly string[]> = {
  per: ["team", "person"],
  rule_kind: ["submission", "eligibility", "conduct"],
  step_kind: STEP_KINDS,
};
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?[+-]\d{2}:\d{2}$/;

export function canonSystemPrompt(e: EventConfig): string {
  return `You extract the canon of ${e.event}, a hackathon, from one of its public pages: the tracks hackers can enter, the prizes, the judging criteria and the rules. Hackers plan their weekend from your output, so every value must be stated on the page, and you cite exactly where.

The page comes as numbered blocks in reading order. "[12] h6 Best Hack" is a heading block; "[13] $500 in cash" is a text block under the latest headings. Event timezone: ${e.timezone}. What the event's config knows of its schedule (for the year and dates; never quote it):
${scheduleLines(e)}

Return entities. Each has:
- ref: your own short id ("t1", "p1", "c1", "r1"), used only to point one entity at another in this answer.
- kind: track | prize | criterion | rule | entry_step.
- sponsor: the sponsor's name as the page writes it (Devpost prize titles start with it in brackets: "[Fetch.ai] Best Use of ASI:One" → "Fetch.ai"), or "event" for the event's own tracks, criteria and rules.
- name: the entity's name, with the block and verbatim quote it comes from.
- fields: a list of {field, value, block, quote}. Leave a field out when the page doesn't state it. Never guess.

Kinds and their fields:
- track: something a team enters or is judged for. On Devpost every prize block (a heading such as "[Visa] Best use of …" followed by its value, winner count and description) is one track. Its name is the heading. Carry the block's full text, sentence by sentence, so nothing in it is lost: every sentence goes to exactly one of the track's requirement or description fields, one of its criteria, one of its entry steps, or one of its prizes. Fields: requirement (one per sentence that states what a project must do, use, build or submit to enter or win, copied as the sentence: "Build it on Convex", "Project must be using Apify in a meaningful way", "must be built with Cursor", "subject to eligibility verification"; repeat the field for each), description (one per remaining sentence of the block's description that is not a requirement, criterion, entry step or prize; repeat the field for each), eligible_with (stated stacking rules), max_entries, cash_value_usd (the block's own "$X in cash" line, as a number, "0" when it says $0), winners (the "N winners" line, as a number).
- prize: what a winner of a track gets. One per place the track states ("1st place: $1250 + Interview" is one prize, "Special Recognition: $250 each" another); a track that names no places gets exactly one prize with no place, whatever its winner count and however many lines its award has ("3 winners" over an invitation, travel and a swag bag is one prize whose award_text holds all of it; "$5,000 in cash" and "4 winners" with no other line is one prize, award_text "$5,000 in cash"); something every entrant gets (a raffle entry, swag for all submitters) is its own prize with place "every entrant". Fields: track (the track's ref; quote ""), place ("1st place"), award_text (the award, verbatim, with everything the block says that winner gets: cash, credits, travel, interviews, swag), amount_usd (a number, only when a dollar amount is stated for that prize; credits and gift cards count only if stated in dollars), per ("team" or "person", only if stated).
- criterion: a judging criterion. Name = the criterion's name. Fields: description, weight (only if stated, as a number), track (the track's ref, quote "", when the criterion is how one track is judged: "most innovative use of Tiger Data", "the more you use Cursor, the more likely you are to win"; leave it out for the event's criteria). A track's stated judging basis is a criterion, not a requirement: every sentence saying how the track is judged or what wins it ("We will judge the quality of the project", "Use real Convex features like live queries and components to win") is its own criterion with track set.
- entry_step: something entering a track takes beyond building the project and ticking the track on Devpost. Fields: track (the track's ref; quote ""), step_kind: opt_in (register, sign up, join, apply or create an account first), supplemental_form (a separate form or survey to fill in), description_mention (something the Devpost description or submission must say or include, such as naming the track or the tool used), submission_field (a specific item the submission must carry for this track: a demo video, a repo link, a deck, a published Actor); text (the sentence, verbatim). Name = a short label in the page's words. The sentence may also be a requirement: then give both.
- rule: a submission, eligibility or conduct rule hackers must follow. Name = a short label of 2 to 6 words taken from the rule's own words. Fields: text (the rule, verbatim), applies_to ("all", or a track ref when the rule is for one track; quote ""), rule_kind (submission | eligibility | conduct), deadline (ISO 8601 with offset, e.g. 2026-10-25T09:00-07:00, only when the rule states a date and time). A deadline's time is the event's local time: write the UTC offset actually in effect in ${e.timezone} on that date, even if the page's zone label (PST/PDT) disagrees.

Quoting:
- quote is copied character for character from the one block you cite, long enough to contain every number and date in the value. Keep it short: the phrase, not the whole block.
- Every number in a value appears in its quote ("$3,600" supports 3600; "$1k" supports 1000).
- Sponsor logos, navigation, footers, judges' names and "Devpost Achievements" are not canon: skip them.`;
}

export const CANON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entities"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "kind", "sponsor", "name", "fields"],
        properties: {
          ref: { type: "string" },
          kind: { type: "string", enum: [...CANON_KINDS] },
          sponsor: { type: "string" },
          name: {
            type: "object",
            additionalProperties: false,
            required: ["value", "block", "quote"],
            properties: { value: { type: "string" }, block: { type: "integer" }, quote: { type: "string" } },
          },
          fields: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "value", "block", "quote"],
              properties: { field: { type: "string", enum: ALL_FIELDS }, value: { type: "string" }, block: { type: "integer" }, quote: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

export function canonHash(system: string): string {
  return createHash("sha256").update(JSON.stringify([CANON_MODEL, CANON_EFFORT, system, CANON_SCHEMA])).digest("hex").slice(0, 16);
}

/** The request: the page's blocks, numbered, headings marked. Multi-line blocks keep their lines, indented. */
export function canonRequest(s: PageSnapshot): string {
  const lines = s.blocks.map((b) => `[${b.i}] ${b.heading ? `h${b.heading} ` : ""}${b.text.replace(/\n/g, "\n    ")}`);
  return `<page url="${s.url}" title="${s.title.replace(/"/g, "'")}">\n${lines.join("\n")}\n</page>`;
}

export function canonInputHash(system: string, request: string): string {
  return createHash("sha256").update(JSON.stringify([canonHash(system), request])).digest("hex").slice(0, 16);
}

// ---- verification ----

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Numbers a text states: "$3,600" → 3600, "$1k" → 1000, "1st" → 1, "2.5" → 2.5. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s?([kK])?(?![\d])/g)].map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1)).filter(Number.isFinite);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** An ISO deadline is supported when its quote names the same month (by name or number), day and hour. */
export function deadlineInQuote(iso: string, quote: string): boolean {
  const m = ISO.exec(iso);
  if (!m) return false;
  const [month, day, hour] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const q = quote.toLowerCase();
  const nums = numbersIn(q);
  const monthNamed = new RegExp(`\\b${MONTHS[month - 1]}`).test(q) || nums.includes(month);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return monthNamed && nums.includes(day) && (nums.includes(hour) || nums.includes(h12));
}

export interface RawField {
  field: string;
  value: string;
  block: number;
  quote: string;
}
export interface RawEntity {
  ref: string;
  kind: CanonKind;
  sponsor: string;
  name: { value: string; block: number; quote: string };
  fields: RawField[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/** D7: kind + canonical URL + heading path of the name's quote, plus the name where one path holds several. */
export function entityId(kind: CanonKind, s: PageSnapshot, block: number, name: string): string {
  const b = s.blocks[block]!;
  const path = [...b.path, ...(b.heading ? [b.text] : [])].map(slug).join("/");
  const leaf = kind === "track" && b.heading && slug(b.text) === slug(name) ? "" : `/${slug(name)}`;
  return `${kind}:${pageKey(s.url)}#${path}${leaf}`;
}

/** Checks the model's answer against the snapshot it read; returns entities with D7 ids, or the first errors. */
export function checkCanon(parsed: unknown, s: PageSnapshot, snapshotHash: string): { entities: Entity[] } | { error: string } {
  const raw = (parsed as { entities?: RawEntity[] })?.entities;
  if (!Array.isArray(raw)) return { error: "missing entities[]" };
  const errors: string[] = [];
  const refs = new Map<string, RawEntity>();
  for (const e of raw) {
    if (refs.has(e.ref)) errors.push(`ref ${e.ref} is used twice`);
    refs.set(e.ref, e);
  }
  const quoteOk = (where: string, block: number, quote: string): boolean => {
    const b = s.blocks[block];
    if (!b) return void errors.push(`${where}: block ${block} doesn't exist`), false;
    if (!quote.trim()) return void errors.push(`${where}: empty quote`), false;
    if (!norm(b.text).includes(norm(quote))) return void errors.push(`${where}: quote "${quote.slice(0, 80)}" is not in block ${block}`), false;
    return true;
  };
  for (const e of raw) {
    const at = `${e.ref} (${e.kind} "${e.name.value.slice(0, 50)}")`;
    if (!CANON_KINDS.includes(e.kind)) errors.push(`${at}: unknown kind`);
    if (quoteOk(`${at} name`, e.name.block, e.name.quote)) {
      const missing = numbersIn(e.name.value).filter((n) => !numbersIn(e.name.quote).includes(n));
      if (missing.length) errors.push(`${at} name: ${missing.join(", ")} not in its quote`);
    }
    const seen = new Set<string>();
    for (const f of e.fields) {
      const fat = `${at} ${f.field}`;
      if (!KIND_FIELDS[e.kind]?.includes(f.field)) {
        errors.push(`${fat}: not a ${e.kind} field (allowed: ${KIND_FIELDS[e.kind]?.join(", ")})`);
        continue;
      }
      if (seen.has(f.field) && !REPEATS.has(`${e.kind}.${f.field}`)) errors.push(`${fat}: given twice`);
      seen.add(f.field);
      if (REF_FIELDS.has(f.field)) {
        const target = refs.get(f.value);
        if (f.field === "applies_to" && f.value === "all") continue;
        if (!target) errors.push(`${fat}: "${f.value}" is not a ref in this answer`);
        else if (target.kind !== "track") errors.push(`${fat}: "${f.value}" is a ${target.kind}, not a track`);
        continue;
      }
      if (ENUMS[f.field] && !ENUMS[f.field]!.includes(f.value)) errors.push(`${fat}: "${f.value}" is not one of ${ENUMS[f.field]!.join("|")}`);
      if (!quoteOk(fat, f.block, f.quote)) continue;
      if (f.field === "deadline") {
        if (!ISO.test(f.value)) errors.push(`${fat}: "${f.value}" is not ISO 8601 with an offset`);
        else if (!deadlineInQuote(f.value, f.quote)) errors.push(`${fat}: month, day or hour of ${f.value} is not in its quote`);
        continue;
      }
      if (NUMBER_FIELDS.has(f.field) && !/^\d+(\.\d+)?$/.test(f.value)) {
        errors.push(`${fat}: "${f.value}" is not a plain number`);
        continue;
      }
      const missing = numbersIn(f.value).filter((n) => !numbersIn(f.quote).includes(n) && !(n === 0 && /\$0\b/.test(f.quote)));
      if (missing.length) errors.push(`${fat}: ${missing.join(", ")} not in its quote`);
    }
    if (e.kind === "prize" && !e.fields.some((f) => f.field === "track")) errors.push(`${at}: a prize needs its track`);
    if (e.kind === "entry_step" && !(["track", "step_kind", "text"] as const).every((k) => e.fields.some((f) => f.field === k))) errors.push(`${at}: an entry step needs track, step_kind and text`);
  }
  if (errors.length) return { error: `${errors.length} problem(s): ${errors.slice(0, 12).join("; ")}${errors.length > 12 ? "; …" : ""}` };

  const src = (block: number, quote: string): FieldValue<never>["source"] => ({ kind: "page", url: s.url, quote, captured_at: s.captured_at, snapshot_hash: snapshotHash, block });
  const ids = new Map(raw.map((e) => [e.ref, `ref:${e.ref}`])); // replaced by D7 ids in assignIds
  const entities = raw.map((e): Entity => {
    const fields: Record<string, FieldValue<unknown>> = {};
    const n = new Map<string, number>();
    for (const f of e.fields) {
      const rep = REPEATS.has(`${e.kind}.${f.field}`);
      const i = n.get(f.field) ?? 0;
      if (rep) n.set(f.field, i + 1);
      const key = rep ? `${f.field}s[${i}]` : f.field;
      const value = REF_FIELDS.has(f.field) ? (f.value === "all" ? "all" : ids.get(f.value)!) : NUMBER_FIELDS.has(f.field) ? Number(f.value) : f.value;
      fields[key === "track" ? "track_id" : key] = { value, source: src(REF_FIELDS.has(f.field) ? e.name.block : f.block, REF_FIELDS.has(f.field) ? e.name.quote : f.quote) };
    }
    return { id: ids.get(e.ref)!, kind: e.kind, sponsor: e.sponsor, name: { value: e.name.value, source: src(e.name.block, e.name.quote) }, fields, history: [], origin: "page" };
  });
  const final = assignIds(entities, s);
  const failed = coverage(s, final).checks.filter((c) => c.pass === false);
  if (failed.length)
    return {
      error: `coverage: ${failed.map((c) => `${c.name} (${c.summary}): ${c.details.slice(0, 8).join("; ")}`).join(" | ")}. Every prize block is one track; give each track one prize per stated place, or one prize with no place when it names none.`,
    };
  return { entities: final };
}

const words8 = (q: string) => slug(q.split(/\s+/).slice(0, 8).join(" "));
const pathOf = (s: PageSnapshot, block: number | undefined) => {
  const b = block === undefined ? undefined : s.blocks[block];
  return b ? [...b.path, ...(b.heading ? [b.text] : [])].map(slug).join("/") : "";
};

/** D7 ids from what the page fixes, never from a name the model chose: a track by its heading path; a prize by
 *  its track and stated place; a criterion by its heading path and name (the page's own words); a rule by its
 *  heading path and the first words of its verbatim text. Same id twice on a page → ~2, ~3 in answer order.
 *  References (prize track_id, rule applies_to) follow the new ids. */
export function assignIds(entities: Entity[], s: PageSnapshot): Entity[] {
  const used = new Map<string, number>();
  const uniq = (id: string) => {
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    return n > 1 ? `${id}~${n}` : id;
  };
  const page = pageKey(s.url);
  const remap = new Map<string, string>();
  for (const t of entities.filter((e) => e.kind === "track")) remap.set(t.id, uniq(entityId("track", s, t.name.source.block!, t.name.value ?? "")));
  // A prize's leaf is its stated place. Where several prizes on one track share a leaf (no places, or "top 3
  // teams" for all three), the stated amount tells them apart: usd-8000 (Hyphenate, Cal Hacks 13.0).
  const prizeBase = (e: Entity) => {
    const track = remap.get(String(e.fields.track_id?.value)) ?? `track:${page}#${pathOf(s, e.name.source.block)}`;
    const place = e.fields.place?.value;
    return `prize:${track.slice("track:".length)}/${slug(typeof place === "string" && place ? place : "prize")}`;
  };
  const baseCount = new Map<string, number>();
  for (const e of entities) if (e.kind === "prize") baseCount.set(prizeBase(e), (baseCount.get(prizeBase(e)) ?? 0) + 1);
  for (const e of entities.filter((e) => e.kind !== "track")) {
    let id: string;
    if (e.kind === "prize") {
      id = prizeBase(e);
      const usd = e.fields.amount_usd?.value;
      if (baseCount.get(id)! > 1 && typeof usd === "number") id = `${id.slice(0, id.lastIndexOf("/"))}/usd-${usd}`;
    } else if (e.kind === "rule" || e.kind === "entry_step") {
      const at = e.fields.text?.source ?? e.name.source;
      id = `${e.kind}:${page}#${pathOf(s, at.block)}/${words8(at.quote)}`;
    } else id = entityId(e.kind as CanonKind, s, e.name.source.block!, e.name.value ?? "");
    remap.set(e.id, uniq(id));
  }
  const swap = (v: unknown) => (typeof v === "string" && remap.has(v) ? remap.get(v)! : v);
  return entities.map((e) => ({
    ...e,
    id: remap.get(e.id) ?? e.id,
    fields: Object.fromEntries(Object.entries(e.fields).map(([k, fv]) => [k, k === "track_id" || k === "applies_to" ? { ...fv, value: swap(fv.value) } : fv])),
  }));
}

// ---- the judge (D15, D21): a fresh Opus call that sees the page and the extraction, nothing else ----

export function canonJudgeSystemPrompt(e: EventConfig): string {
  return `You check an extraction of ${e.event}'s canon (tracks, prizes, judging criteria, rules, entry steps) from one of its pages. You get the page as numbered blocks and the entities another model extracted, each with its id, kind, name and fields.

Report:
- missing: anything hackers need that the page states and no entity carries: a track or prize block with no track, a stated place or award with no prize, a judging criterion, a submission/eligibility/conduct rule, an entry step (opt-in, supplemental form, something the description must mention, a required submission item), a sentence of a prize block carried by no field, a stated requirement, deadline or dollar amount left out. Give its kind, the block it's in, and one line on what's missing.
- misplaced: an entity or field that is wrong: a value the page doesn't say, a prize on the wrong track, a sponsor that isn't the one the page names, a rule given the wrong kind, a deadline at the wrong time. Give the entity id and one line on the problem.

Don't report sponsor logos, navigation, judges' names, footers, or wording choices that keep the meaning. Return empty lists when the extraction is complete and correct.`;
}

export const CANON_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["missing", "misplaced"],
  properties: {
    missing: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "block", "what"],
        properties: { kind: { type: "string", enum: [...CANON_KINDS] }, block: { type: "integer" }, what: { type: "string" } },
      },
    },
    misplaced: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["entity_id", "problem"], properties: { entity_id: { type: "string" }, problem: { type: "string" } } },
    },
  },
} as const;

export interface JudgeVerdict {
  missing: { kind: CanonKind; block: number; what: string }[];
  misplaced: { entity_id: string; problem: string }[];
}

export function canonJudgeRequest(s: PageSnapshot, entities: Entity[]): string {
  const show = (e: Entity) =>
    JSON.stringify({ id: e.id, kind: e.kind, sponsor: e.sponsor, name: e.name.value, ...Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v.value])) });
  return `${canonRequest(s)}\n\n<entities count="${entities.length}">\n${entities.map(show).join("\n")}\n</entities>`;
}

export function checkJudge(parsed: unknown, s: PageSnapshot, entities: Entity[]): JudgeVerdict | { error: string } {
  const v = parsed as JudgeVerdict;
  if (!Array.isArray(v?.missing) || !Array.isArray(v?.misplaced)) return { error: "missing missing[] or misplaced[]" };
  const ids = new Set(entities.map((e) => e.id));
  const bad = [
    ...v.missing.filter((m) => !s.blocks[m.block]).map((m) => `missing: block ${m.block} doesn't exist`),
    ...v.misplaced.filter((m) => !ids.has(m.entity_id)).map((m) => `misplaced: ${m.entity_id} is not an entity id`),
  ];
  return bad.length ? { error: bad.join("; ") } : v;
}

// ---- D7: re-match after a re-extraction ----

/** Quote normalization for matching: case, whitespace and punctuation ignored. */
export const matchText = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Dice coefficient over character bigrams of the normalized texts: 1 = same, 0 = nothing shared. */
export function similarity(a: string, b: string): number {
  const x = matchText(a);
  const y = matchText(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let both = 0;
  for (const [g, n] of gx) both += Math.min(n, gy.get(g) ?? 0);
  return (2 * both) / (x.length - 1 + (y.length - 1));
}

/** What an entity is matched on: the page text its id is built from, plus its main quote. Model-chosen names
 *  are left out, so a renamed prize still matches. */
export function matchKey(e: Entity, s: PageSnapshot): string {
  const at = e.kind === "rule" ? (e.fields.text?.source ?? e.name.source) : e.name.source;
  const b = at.block === undefined ? undefined : s.blocks[at.block];
  const extra =
    e.kind === "prize"
      ? [String(e.fields.place?.value ?? ""), String(e.fields.amount_usd?.value ?? ""), e.fields.award_text?.source.quote ?? ""]
      : e.kind === "rule"
        ? [at.quote]
        : [e.name.source.quote];
  return [e.kind, ...(b?.path ?? []), ...(b?.heading ? [b.text] : []), ...extra].join(" | ");
}

/** D7 similarity threshold. Uncalibrated: re-extracting an unchanged snapshot keeps every id exactly (Cal Hacks
 *  Devpost, 2026-11-06: 151 of 151 across two runs), so fuzzy matching only ever runs after a real page edit.
 *  Calibrate on the first re-capture whose snapshot hash changes. */
export const REMATCH_THRESHOLD = 0.8;

export interface Rematch {
  /** new id → old id, for entities whose id changed but whose quote still matches. */
  renamed: Map<string, string>;
  /** Old ids with no entity left, or with two candidates (ambiguous): listed "no longer on the page". */
  gone: { id: string; reason: "no match" | "ambiguous"; best: number }[];
}

export interface Keyed {
  id: string;
  kind: string;
  /** matchKey at extraction time; stored, since a re-capture can overwrite the old snapshot file. */
  key: string;
}
export const keyed = (entities: Entity[], s: PageSnapshot): Keyed[] => entities.map((e) => ({ id: e.id, kind: e.kind, key: matchKey(e, s) }));

/** D7: an old id survives when the same id is extracted again, or when exactly one new entity of the same kind
 *  (not already claimed) matches its key at or above `threshold`. Never a guess: two candidates → gone. */
export function rematch(prev: Keyed[], next: Keyed[], threshold: number): Rematch {
  const nextIds = new Set(next.map((e) => e.id));
  const prevIds = new Set(prev.map((e) => e.id));
  const free = next.filter((e) => !prevIds.has(e.id));
  const renamed = new Map<string, string>();
  const gone: Rematch["gone"] = [];
  for (const old of prev) {
    if (nextIds.has(old.id)) continue;
    const scored = free
      .filter((e) => e.kind === old.kind && !renamed.has(e.id))
      .map((e) => ({ e, sim: similarity(old.key, e.key) }))
      .sort((a, b) => b.sim - a.sim);
    const best = scored[0]?.sim ?? 0;
    const above = scored.filter((c) => c.sim >= threshold);
    if (above.length === 1) renamed.set(above[0]!.e.id, old.id);
    else gone.push({ id: old.id, reason: above.length > 1 ? "ambiguous" : "no match", best: Number(best.toFixed(3)) });
  }
  return { renamed, gone };
}

/** An entry step or requirement the previous read of a page had and the new read lacks (user 2026-11-07). */
export interface KeptField {
  kind: "entry_step" | "requirement";
  /** The entry step's id, or the requirement's track id. */
  id: string;
  value: string;
  /** Whether its quote is still in the new snapshot's text (false: the page may really have dropped it). */
  quote_on_page: boolean;
}

/** A re-read never silently drops an entry step or a requirement (user 2026-11-07, after the 2026-11-07 re-read lost
 *  GoDaddy's "Register your domain name" and Apify's "Building an actor"): each one the previous read had and the
 *  new read lacks is carried over from the previous read unchanged, and listed. An entry step is present when the
 *  new read has its id, or a step on the same track with the same text; a requirement when the same track lists
 *  the same text. A requirement whose whole track is gone isn't kept here: the track is in no_longer_on_page. */
export function keepDropped(prev: Entity[], next: Entity[], snap: PageSnapshot): { entities: Entity[]; kept: KeptField[] } {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const pageText = norm(snap.blocks.map((b) => b.text).join(" "));
  const onPage = (quote: string | undefined) => !!quote && pageText.includes(norm(quote));
  const stepText = (e: Entity) => norm(String(e.fields.text?.value ?? e.name.value ?? ""));
  const stepKey = (e: Entity) => `${e.fields.track_id?.value ?? ""}|${stepText(e)}`;
  const reqs = (e: Entity) => Object.entries(e.fields).filter(([k]) => /^requirements\[\d+\]$/.test(k));
  const kept: KeptField[] = [];
  const out = [...next];

  const ids = new Set(next.map((e) => e.id));
  const steps = new Set(next.filter((e) => e.kind === "entry_step").map(stepKey));
  for (const e of prev.filter((x) => x.kind === "entry_step" && !ids.has(x.id) && !steps.has(stepKey(x)))) {
    out.push(e);
    kept.push({ kind: "entry_step", id: e.id, value: String(e.fields.text?.value ?? e.name.value ?? ""), quote_on_page: onPage(e.fields.text?.source.quote ?? e.name.source.quote) });
  }

  const tracks = new Map(prev.filter((x) => x.kind === "track").map((t) => [t.id, t]));
  for (const [i, t] of out.entries()) {
    const old = t.kind === "track" ? tracks.get(t.id) : undefined;
    if (!old) continue;
    const have = new Set(reqs(t).map(([, f]) => norm(String(f.value))));
    const lost = reqs(old).filter(([, f]) => !have.has(norm(String(f.value))));
    if (!lost.length) continue;
    const fields = { ...t.fields };
    let n = Math.max(-1, ...reqs(t).map(([k]) => Number(/\d+/.exec(k)![0]))) + 1;
    for (const [, f] of lost) {
      fields[`requirements[${n++}]`] = f;
      kept.push({ kind: "requirement", id: t.id, value: String(f.value), quote_on_page: onPage(f.source.quote) });
    }
    out[i] = { ...t, fields };
  }
  return { entities: out, kept };
}
