// `hr classify`: items from captured messages with Claude (design doc, "Item rules").
// Redacted text only (R3-19/OV2). Cache key covers model, prompt, schema and the full input (D9),
// so any change re-classifies; failures go to classify_errors.json and are never cached (D10).
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Sponsors } from "./pool.ts";
import type { PosterRole } from "./roles.ts";
import { AMOUNT_BASES, AMOUNT_UNITS, DEADLINE_STATUSES, ITEM_KINDS, type Item, type Message } from "./schema.ts";
import { ISO_WITH_OFFSET, tsToEventIsoWithDay } from "./time.ts";
import { addUsage, NO_USAGE, type Usage } from "./usage.ts";
import { EVENT_PATH } from "./event.ts";

export const MODEL = "claude-haiku-5-5" as const;
/** Haiku 5.5 defaults to medium; set explicitly so the cache key names it. */
export const EFFORT = "medium" as const;
/** Adaptive thinking counts toward max_tokens; the JSON itself is small. */
export const MAX_TOKENS = 8000;
/** Retries for an output that fails validation (D10). API errors use the SDK's own 2 retries with backoff. */
export const OUTPUT_RETRIES = 2;


export interface ClassifyRun {
  prompt_hash: string;
  model: string;
  written_at: string;
  /** Message ids with a cache entry for the current prompt and input (zero items is an answer too). */
  classified: string[];
  /** Message ids that failed this run (D10): scored as predicted negative. */
  errors: string[];
  /** Messages whose items come from an earlier prompt's answer (classify --new). */
  earlier_prompts?: number;
  /** This run's API calls only (cached messages cost nothing). */
  usage?: Usage;
  cost_usd?: number;
}

export interface EventConfig {
  event: string;
  /** This event's Slack export (slackdump), for the commands that read one when --export isn't given. "~/" is the
   *  home directory; relative paths are from the event's directory. Unset: those commands stop and say so. */
  slack_export?: string;
  timezone: string;
  hacking_start: string | null;
  hacking_end: string | null;
  schedule: { what: string; at: string; until?: string; superseded_by?: string; source: string }[];
  /** v2: the public or logged-in pages that make up canon (tracks, prizes, criteria, rules), D3. */
  canon_pages?: string[];
  /** v2: pages that hold the schedule (D3); none listed means the schedule is Slack-only. */
  schedule_pages?: string[];
  /** v2 (D19): channels whose posts carry organizer authority. Unset: channels Slack marks restricted-posting. */
  authority_channels?: string[];
  /** Discord channels where only the event's staff post, as "<server id>/<channel id>" (discord.ts channelKey). Ids,
   *  not names: Slack's authority_channels never apply to Discord. */
  discord_authority_channels?: string[];
  /** The chat agent's spend cap per event day, in USD (agent.ts CHAT_DAILY_USD when unset). */
  chat_daily_usd?: number;
  /** Channels only hackers post in (reps.ts signal 3: a likely rep never posts there). Unset: channels named like
   *  team formation or introductions (reps.ts HACKER_ONLY). */
  hacker_only_channels?: string[];
  /** v2 (D23): prizes judged on the whole project, not an idea fit, besides those with no sponsor tag. */
  event_level_prizes?: string[];
  /** v2 (D23): a reporting tag for the fit eval ("*" matches any rest); never an exclusion. */
  tool_gated_prizes?: string[];
  /** Page lines the canon read missed, noted by hand (user 2026-11-08): each joins canon while its quote is still on
   *  the page (canon.ts applyNotes), and is reported gone, so watch alerts, once the page drops it. */
  canon_notes?: CanonNote[];
}

export interface CanonNote {
  kind: "prize";
  /** The sponsor as the page writes it, or "event". */
  sponsor: string;
  name: string;
  /** Verbatim from the page. */
  quote: string;
  url: string;
}

export function readEvent(path = EVENT_PATH): EventConfig {
  return JSON.parse(readFileSync(path, "utf8")) as EventConfig;
}

const nullable = (t: object) => ({ anyOf: [t, { type: "null" }] });

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "sponsor",
          "amount_text",
          "amount_value",
          "amount_unit",
          "amount_basis",
          "amount_usd_per_person",
          "deadline_iso",
          "deadline_status",
          "event_start_iso",
          "urls",
        ],
        properties: {
          kind: { type: "string", enum: [...ITEM_KINDS] },
          sponsor: { type: "string" },
          amount_text: { type: "string" },
          amount_value: nullable({ type: "number" }),
          amount_unit: { type: "string", enum: [...AMOUNT_UNITS] },
          amount_basis: { type: "string", enum: [...AMOUNT_BASES] },
          amount_usd_per_person: nullable({ type: "number" }),
          deadline_iso: nullable({ type: "string" }),
          deadline_status: { type: "string", enum: [...DEADLINE_STATUSES] },
          event_start_iso: nullable({ type: "string" }),
          urls: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface RawItem {
  kind: Item["kind"];
  sponsor: string;
  amount_text: string;
  amount_value: number | null;
  amount_unit: Item["amount_unit"];
  amount_basis: Item["amount_basis"];
  amount_usd_per_person: number | null;
  deadline_iso: string | null;
  deadline_status: Item["deadline_status"];
  event_start_iso: string | null;
  urls: string[];
}

export function scheduleLines(e: EventConfig): string {
  const lines = [
    `- Hacking start: ${e.hacking_start ?? "not known"}`,
    `- Hacking end: ${e.hacking_end ?? "not known (if a post says \"end of hacking\" and nothing below pins it, the deadline is unresolved)"}`,
    ...e.schedule.map((s) => `- ${s.what}: ${s.at}${s.until ? ` until ${s.until}` : ""}${s.superseded_by ? ` (later replaced: ${s.superseded_by})` : ""}`),
  ];
  return lines.join("\n");
}

export function systemPrompt(e: EventConfig, rules: string): string {
  return `You extract offers and deadlines from one Slack post in a sponsor or event channel of ${e.event}, a hackathon. Hackers use your output to see what they could claim and by when, and every number they see must come from the post itself.

Return {"items": [...]} with one item per distinct offer or deadline in the post. Return {"items": []} when there is none: chatter, thanks, introductions, technical help, logistics with nothing offered and no time limit.

Kinds:
- credit: something any hacker or team can claim without winning: API or cloud credits, free usage or plan upgrades, promo codes, discounts.
- prize: awarded to winners of a track or challenge, including prizes paid in credits.
- job: jobs, internships, recruiting.
- workshop: talks, workshops, office hours or demos at a stated time (the time goes in event_start_iso).
- deadline: a time limit for hackers that isn't part of another item in this post (submissions due, a form closing, RSVP by).
- other: any other concrete thing offered to hackers (swag, hardware, food), only when it is offered rather than mentioned.
A post that bundles two credit programs and a prize yields three items.

poster_role is a hint, not a filter: organizer, sponsor-side or other. From an "other" poster (usually a hacker), questions and complaints are not offers ("do we only get $5 of credit?" yields no item). An announcement-shaped post from anyone (it states an amount, a code, a link or how to claim) is classified normally.

Fields:
- sponsor: the channel's sponsor, unless the item clearly belongs to another company the post names; "event" for event-wide items with no sponsor.
- amount_text: the amount exactly as written ("$50 in credits", "up to $200", "1M tokens"); "" when there is none.
- amount_value: the number in amount_text (50, 200, 1000000), or null.
- amount_unit: USD for dollar amounts; credits, tokens or hours when stated in those; other otherwise, including when there is no amount.
- amount_basis: per_person, per_team, pool (a total shared by many), up_to ("up to $X"), or unknown (an amount with no stated basis, or no amount).
- amount_usd_per_person: only when amount_unit is USD and amount_basis is per_person: the stated number. Otherwise null. Never compute or estimate it; $100 per team is not $25 per person.
- deadline_iso: a time limit hackers must act by: a deadline (submission, form, claim, RSVP) or the end of a claim window stated in the post. ISO 8601 with the event offset, e.g. 2026-10-25T09:00:00-07:00. Resolve relative times ("tonight", "Sunday 11:59pm", "in 2 hours", "end of hacking") from the post's posted_at and the schedule below. A date with no time means 23:59:00 that day. null when there is no limit or it can't be pinned to an instant. Start times of talks, workshops, food or other events are not limits: they go in event_start_iso, never here.
- deadline_status: explicit (a calendar date is stated), resolved_relative (you resolved a relative time or a schedule reference), unresolved (a limit is mentioned but can't be pinned; deadline_iso null), none (no limit, including an item that only has a start time; deadline_iso null).
- event_start_iso: when a workshop, talk, office hours, demo, meal or other scheduled event starts, resolved like deadline_iso. null when the item isn't a scheduled event or no start time is stated. It never makes an item dated.
- urls: links from the post's links list that belong to this item (claim pages, forms, docs), copied exactly; [] if none.

Names in posts are redacted as [person] and @person; ignore them.

Event schedule (timezone ${e.timezone}, UTC-07:00 during the event):
${scheduleLines(e)}

The same posts are labeled by the rules below, quoted verbatim from the labeling guide. They describe one row per post in a labeling sheet, not your output, but your items must agree with them:
- is_credit = y exactly when you return a credit item; credits_in_post is the number of credit items.
- is_dated = y exactly when some item has deadline_status explicit, resolved_relative or unresolved. A claim window's end (the sheet's window_end) goes in that item's deadline_iso.
- exclude = y: the post offers nothing, so no credit item.
- amount_text, amount_usd_per_person and amount_basis mean the same as your fields.

<rules>
${rules}
</rules>`;
}

/** One message's request input. `user` is everything the model sees besides the system prompt. */
export interface ClassifyInput {
  message: Message;
  role: PosterRole;
  sponsor: string;
  user: string;
  redactions: number;
  key: string;
}

/** Covers the system prompt (schedule and the rules' Columns section included), the schema, model and effort. */
export function promptHash(system: string): string {
  return sha256(JSON.stringify([MODEL, EFFORT, system, OUTPUT_SCHEMA])).slice(0, 16);
}

export function buildInput(
  m: Message,
  o: { role: PosterRole; sponsor: string; redact: (t: string) => { text: string; replaced: number }; promptHash: string },
): ClassifyInput {
  const text = o.redact(m.text);
  const links = m.links.map((l) => o.redact(l).text);
  const user = [
    `channel: #${m.channel_name}`,
    `channel sponsor: ${o.sponsor}`,
    `poster_role: ${o.role}`,
    `posted_at: ${tsToEventIsoWithDay(m.ts)}`,
    m.subtype === "thread_broadcast" ? "note: a thread reply that was also sent to the channel" : "",
    `links:${links.length ? "\n" + links.map((l) => `- ${l}`).join("\n") : " none"}`,
    `post:\n<post>\n${text.text}\n</post>`,
  ]
    .filter(Boolean)
    .join("\n");
  return { message: m, role: o.role, sponsor: o.sponsor, user, redactions: text.replaced, key: `${m.id}:${sha256(o.promptHash + "\n" + user).slice(0, 32)}` };
}

/** Checks the rules the JSON schema can't express. Returns the items or a reason. */
export function checkItems(v: unknown, links: string[]): { items: RawItem[] } | { error: string } {
  const items = (v as { items?: unknown })?.items;
  if (!Array.isArray(items)) return { error: "output has no items array" };
  for (const [i, it] of (items as RawItem[]).entries()) {
    const at = `items[${i}]`;
    if (!ITEM_KINDS.includes(it.kind)) return { error: `${at}.kind ${it.kind}` };
    if (it.amount_usd_per_person !== null && !(it.amount_unit === "USD" && it.amount_basis === "per_person")) {
      return { error: `${at}: amount_usd_per_person set with ${it.amount_unit}/${it.amount_basis}` };
    }
    if (it.amount_usd_per_person === null && it.amount_unit === "USD" && it.amount_basis === "per_person") {
      return { error: `${at}: amount_unit USD and amount_basis per_person, so amount_usd_per_person is required (the stated number)` };
    }
    if (it.event_start_iso !== null && !ISO_WITH_OFFSET.test(it.event_start_iso)) return { error: `${at}.event_start_iso "${it.event_start_iso}" has no offset` };
    if (it.deadline_iso !== null) {
      if (!ISO_WITH_OFFSET.test(it.deadline_iso)) return { error: `${at}.deadline_iso "${it.deadline_iso}" has no offset` };
      if (it.deadline_status !== "explicit" && it.deadline_status !== "resolved_relative") return { error: `${at}: deadline_iso with status ${it.deadline_status}` };
    } else if (it.deadline_status === "explicit" || it.deadline_status === "resolved_relative") {
      return { error: `${at}: status ${it.deadline_status} without deadline_iso` };
    }
  }
  // URLs not in the post are dropped, never kept: every link must trace to the message.
  const known = new Set(links);
  return { items: (items as RawItem[]).map((it) => ({ ...it, urls: it.urls.filter((u) => known.has(u)) })) };
}

export interface CacheEntry {
  message_id: string;
  prompt_hash: string;
  model: string;
  items: RawItem[];
  classified_at: string;
}
export type Cache = Record<string, CacheEntry>;
export interface ClassifyError {
  message_id: string;
  reason: string;
  attempts: number;
  at: string;
}

export function readJsonFile<T>(path: string, empty: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty;
}

export function writeJsonFile(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
}

/** Calls the model for one input: up to 1 + OUTPUT_RETRIES attempts on invalid output. Output that
 *  fails validation goes back to the model unchanged (thinking blocks included) with the error, and
 *  the model corrects it; a truncated or empty reply is retried fresh.
 *  API errors are retried by the SDK (maxRetries 2, with backoff); one that still fails ends here. */
export async function classifyOne(
  client: Anthropic,
  system: string,
  hash: string,
  input: ClassifyInput,
  backoffMs = 1000,
): Promise<({ entry: CacheEntry } | { error: ClassifyError }) & { usage: Usage }> {
  let reason = "";
  let usage = NO_USAGE;
  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: input.user }];
  for (let attempt = 1; attempt <= 1 + OUTPUT_RETRIES; attempt++) {
    if (attempt > 1) await Bun.sleep(backoffMs * 2 ** (attempt - 2));
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        output_config: { effort: EFFORT, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [...messages],
      });
      usage = addUsage(usage, res.usage);
      const sendBack = (why: string) =>
        messages.push(
          { role: "assistant", content: res.content },
          { role: "user", content: `That output failed validation: ${why}. Return the corrected JSON for the same post.` },
        );
      if (res.stop_reason === "refusal") {
        reason = `refusal${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`;
        return { error: { message_id: input.message.id, reason, attempts: attempt, at: new Date().toISOString() }, usage }; // not retried
      }
      if (res.stop_reason === "max_tokens") {
        reason = "hit max_tokens";
        continue;
      }
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        reason = "no text block";
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.text);
      } catch {
        reason = "output is not JSON";
        sendBack(reason);
        continue;
      }
      const checked = checkItems(parsed, input.message.links);
      if ("error" in checked) {
        reason = checked.error;
        sendBack(reason);
        continue;
      }
      return { entry: { message_id: input.message.id, prompt_hash: hash, model: MODEL, items: checked.items, classified_at: new Date().toISOString() }, usage };
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        return { error: { message_id: input.message.id, reason: `API ${e.status ?? "connection"}: ${e.message}`, attempts: attempt, at: new Date().toISOString() }, usage };
      }
      throw e;
    }
  }
  return { error: { message_id: input.message.id, reason, attempts: 1 + OUTPUT_RETRIES, at: new Date().toISOString() }, usage };
}

/** Cached items as schema Items. Sponsor names go through sponsors.json (sponsor or alias → sponsor). */
/** What to send and which answer each message keeps. Normally: whatever has no answer under this prompt and input.
 *  onlyNew (classify --new, user 2026-11-07): only messages never classified under any prompt, so a sync's new posts
 *  cost a few calls even after event.json changed the prompt; the rest keep their newest answer. */
export function classifyPlan<I extends { key: string; message: { id: string } }>(inputs: I[], cache: Cache, onlyNew: boolean) {
  const newest = new Map<string, CacheEntry>();
  if (onlyNew) for (const e of Object.values(cache)) if ((newest.get(e.message_id)?.classified_at ?? "") < e.classified_at) newest.set(e.message_id, e);
  const answer = (i: I): CacheEntry | undefined => cache[i.key] ?? newest.get(i.message.id);
  return { todo: inputs.filter((i) => !answer(i)), answer };
}

export function toItems(entry: CacheEntry, sponsors: Sponsors): Item[] {
  const canon = new Map<string, string>();
  for (const s of Object.values(sponsors)) for (const n of [s.sponsor, ...s.aliases]) canon.set(n.toLowerCase(), s.sponsor);
  return entry.items.map((it, item_index) => {
    const item: Item = {
      message_id: entry.message_id,
      item_index,
      kind: it.kind,
      sponsor: canon.get(it.sponsor.toLowerCase()) ?? it.sponsor,
      offer_key: "",
      amount_text: it.amount_text,
      amount_unit: it.amount_unit,
      amount_basis: it.amount_basis,
      deadline_status: it.deadline_status,
      urls: it.urls,
      model: entry.model,
      classified_at: entry.classified_at,
    };
    if (it.amount_value !== null) item.amount_value = it.amount_value;
    if (it.amount_usd_per_person !== null) item.amount_usd_per_person = it.amount_usd_per_person;
    if (it.deadline_iso !== null) item.deadline_iso = it.deadline_iso;
    if (it.event_start_iso) item.event_start_iso = it.event_start_iso;
    return item;
  });
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
