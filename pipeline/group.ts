// `hr group`: the Opus grouping pass (the day-4 credit pass's grouping step, pulled forward before the
// board build). claude-opus-5-5 reads every post the judge labeled is_credit = y, as the same redacted
// input the classifier and judge read, and returns the distinct offers with their source posts:
// reminders, re-posts and cross-posts of one offer merge; different offers from one sponsor stay apart.
// Posts labeled not a credit never get here (they're dropped). Blind to Haiku, like `hr prelabel`: this
// module reads the sheet's labels, the capture and config, never the classifier's outputs.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { OUTPUT_RETRIES, scheduleLines, type ClassifyInput, type EventConfig } from "./classify.ts";
import { JUDGE_EFFORT, JUDGE_MODEL } from "./prelabel.ts";
import { AMOUNT_BASES, DEADLINE_STATUSES } from "./schema.ts";
import { addUsage, NO_USAGE, type Usage } from "./usage.ts";

export const GROUP_MODEL = JUDGE_MODEL;
export const GROUP_EFFORT = JUDGE_EFFORT;
/** One request holds every credit post; thinking counts toward max_tokens, so it streams. */
export const GROUP_MAX_TOKENS = 48000;
export const GROUP_PATH = "review/offers.json";

export interface Offer {
  sponsor: string;
  /** A few plain words naming what is offered, e.g. "Claude API credits". */
  title: string;
  /** Copied from a source post. */
  amount_text: string;
  /** Stated USD per person as a decimal string, "" unless stated. Never estimated. */
  amount_usd_per_person: string;
  amount_basis: string;
  /** The earliest stated deadline or claim-window end across the offer's posts, ISO 8601 with offset, or "". */
  limit_iso: string;
  limit_status: string;
  /** The one thing a hacker does to claim it, from the posts. At most one each; "" when no post states it. */
  claim_url: string;
  promo_code: string;
  /** Imperative, a few words, from the posts: "Fill out the form", "Show your badge at the booth". "" if unstated. */
  claim_how: string;
  /** message_ids, oldest first. */
  posts: string[];
  reason: string;
}

export interface NotOffer {
  post: string;
  reason: string;
}

export interface GroupResult {
  model: string;
  effort: string;
  prompt_hash: string;
  /** Hash of the request text: the offers are current only while it matches. */
  input_hash: string;
  posts: number;
  offers: Offer[];
  not_offers: NotOffer[];
  written_at: string;
  usage: Usage;
  cost_usd: number;
}

export function groupSystemPrompt(rules: string, e: EventConfig): string {
  return `You group credit offers from the sponsor and event channels of ${e.event}, a hackathon. Every post you're given was labeled as offering credits (API credits, free plan time, promo codes and the like). Return the distinct offers: one entry per thing a hacker could claim.

How to group:
- One offer = one sponsor's one claimable thing. Posts about the same credits from the same sponsor are one offer: reminders, re-posts, corrections, deadline extensions, and cross-posts in another channel (for example #0-announcements repeating a sponsor channel). The same amount, link or promo code is strong evidence of the same offer.
- Different things from the same sponsor are separate offers: a different product, a different amount for a different audience, a separate claim link or code that isn't a replacement for the first.
- A post that offers two different things belongs to both offers.
- If a post, read in full, offers nothing a hacker could claim (a judging update, a prize track, an intro, a support answer that only mentions credits), put it in not_offers with the reason instead of in an offer.
- Every post id must appear in at least one offer or in not_offers.

Fields of an offer, under the rules below for the amount and limit columns:
- sponsor: the sponsor field of its posts; "event" for the organizers' own offers.
- title: two to six plain words naming what is offered, from the posts (e.g. "Claude API credits", "Startup plan, first month free"). No marketing words.
- amount_text: the amount as one of the posts states it, copied exactly; "" if no post states one.
- amount_usd_per_person and amount_basis: as the rules define them, from what the posts state. If posts state different per-person amounts for the same offer, use the earliest post's and say so in reason.
- limit_iso and limit_status: the earliest stated deadline or claim-window end across the offer's posts (the rules' deadline_iso, deadline_status and window_end). "" and none when no post states a limit.
- claim_url: the one link a hacker uses to claim this offer (a claim page, form or signup), copied exactly from a post's links list; the latest post's link when a later post replaces it. "" if no post gives one. Never a docs or homepage link that doesn't claim anything.
- promo_code: the code exactly as a post states it, "" if none.
- claim_how: what a hacker does to claim it, imperative, at most eight words, from the posts ("Redeem the code at checkout", "Visit the booth during the workshop"). "" if no post says.
- posts: the ids of every post about this offer, oldest first.
- reason: one short sentence on why these posts are one offer (or why it stands alone).

Never estimate a number a post doesn't state.

The labeling rules, verbatim (they describe one post's columns; apply them to the offer):

<rules>
${rules}
</rules>

About each post:
- posted_at is the post's time in event time. Resolve relative times from it and the schedule below.
- poster_role is organizer, sponsor-side or other: a hint about who posted.
- Names in posts are redacted as [person] and @person; ignore them.

Event schedule (timezone ${e.timezone}, UTC-07:00 during the event):
${scheduleLines(e)}`;
}

const str = { type: "string" } as const;
const oneOf = (vs: readonly string[]) => ({ type: "string", enum: [...vs] }) as const;

export const GROUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["offers", "not_offers"],
  properties: {
    offers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sponsor", "title", "amount_text", "amount_usd_per_person", "amount_basis", "limit_iso", "limit_status", "claim_url", "promo_code", "claim_how", "posts", "reason"],
        properties: {
          sponsor: str,
          title: str,
          amount_text: str,
          amount_usd_per_person: str,
          amount_basis: oneOf(["", ...AMOUNT_BASES]),
          limit_iso: str,
          limit_status: oneOf(DEADLINE_STATUSES),
          claim_url: str,
          promo_code: str,
          claim_how: str,
          posts: { type: "array", items: str },
          reason: str,
        },
      },
    },
    not_offers: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["post", "reason"], properties: { post: str, reason: str } },
    },
  },
} as const;

export function groupHash(system: string): string {
  return createHash("sha256").update(JSON.stringify([GROUP_MODEL, GROUP_EFFORT, system, GROUP_SCHEMA])).digest("hex").slice(0, 16);
}

/** The one request: every credit post's redacted input, oldest first, each under its message id. */
export function groupRequest(inputs: ClassifyInput[]): string {
  const sorted = [...inputs].sort((a, b) => Number(a.message.ts) - Number(b.message.ts));
  return sorted.map((i) => `<post_input id="${i.message.id}">\n${i.user}\n</post_input>`).join("\n\n");
}

export function inputHash(system: string, request: string): string {
  return createHash("sha256").update(JSON.stringify([groupHash(system), request])).digest("hex").slice(0, 16);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?[+-]\d{2}:\d{2}$/;

/** The answer as offers, or why it fails: every post accounted for, no unknown ids, numbers only where stated. */
export function checkGroups(v: unknown, ids: string[], links: Set<string> = new Set()): { offers: Offer[]; not_offers: NotOffer[] } | { error: string } {
  const o = v as { offers?: Offer[]; not_offers?: NotOffer[] };
  if (!o || !Array.isArray(o.offers) || !Array.isArray(o.not_offers)) return { error: "offers and not_offers must be arrays" };
  const known = new Set(ids);
  const seen = new Set<string>();
  for (const [i, f] of o.offers.entries()) {
    if (!f.posts.length) return { error: `offers[${i}] has no posts` };
    for (const p of f.posts) {
      if (!known.has(p)) return { error: `offers[${i}] names unknown post ${p}` };
      seen.add(p);
    }
    if (f.amount_usd_per_person && !/^\d+(\.\d+)?$/.test(f.amount_usd_per_person)) return { error: `offers[${i}].amount_usd_per_person must be a plain number or ""` };
    if (f.amount_usd_per_person && f.amount_basis !== "per_person") return { error: `offers[${i}] has amount_usd_per_person but amount_basis ${f.amount_basis || '""'}` };
    if (f.limit_iso && !ISO.test(f.limit_iso)) return { error: `offers[${i}].limit_iso must be ISO 8601 with an offset, or ""` };
    if (!f.limit_iso && ["explicit", "resolved_relative"].includes(f.limit_status)) return { error: `offers[${i}] has limit_status ${f.limit_status} but no limit_iso` };
    if (!f.title.trim()) return { error: `offers[${i}] has no title` };
    if (f.claim_url && !links.has(f.claim_url)) return { error: `offers[${i}].claim_url is not one of its posts' links: ${f.claim_url}` };
  }
  for (const n of o.not_offers) {
    if (!known.has(n.post)) return { error: `not_offers names unknown post ${n.post}` };
    if (seen.has(n.post)) return { error: `post ${n.post} is in an offer and in not_offers` };
    seen.add(n.post);
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) return { error: `posts in no offer and not in not_offers: ${missing.join(", ")}` };
  return { offers: o.offers.map((f) => ({ ...f, posts: [...f.posts].sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1])) })), not_offers: o.not_offers };
}

/** Per-person amounts come from the day-2 Opus labels, not from the grouping pass: each offer takes the
 *  amount_usd_per_person of its earliest source post whose label states one (basis per_person), and is
 *  unpriced when none does. The grouping pass only decides which posts belong together. */
export function withLabelAmounts(offers: Offer[], labels: Map<string, { amount_usd_per_person: string; amount_basis: string }>): Offer[] {
  return offers.map((f) => {
    const id = f.posts.find((p) => {
      const l = labels.get(p);
      return l?.amount_basis === "per_person" && /^\d+(\.\d+)?$/.test(l.amount_usd_per_person);
    });
    const usd = id ? labels.get(id)!.amount_usd_per_person : "";
    return { ...f, amount_usd_per_person: usd, amount_basis: usd ? "per_person" : f.amount_basis === "per_person" ? "unknown" : f.amount_basis };
  });
}

/** One streamed request; on output that fails the check, the error goes back to the model (up to OUTPUT_RETRIES). */
export async function groupOffers(
  client: Anthropic,
  system: string,
  request: string,
  ids: string[],
  links: Set<string>,
): Promise<({ offers: Offer[]; not_offers: NotOffer[] } | { error: string }) & { usage: Usage; calls: number }> {
  let usage = NO_USAGE;
  let reason = "";
  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: request }];
  for (let attempt = 1; attempt <= 1 + OUTPUT_RETRIES; attempt++) {
    let res: Anthropic.Messages.Message;
    try {
      res = await client.messages
        .stream({
          model: GROUP_MODEL,
          max_tokens: GROUP_MAX_TOKENS,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          output_config: { effort: GROUP_EFFORT, format: { type: "json_schema", schema: GROUP_SCHEMA } },
          messages,
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError) return { error: `API ${e.status ?? "connection"}: ${e.message}`, usage, calls: attempt };
      throw e;
    }
    usage = addUsage(usage, res.usage);
    if (res.stop_reason === "refusal") return { error: "refusal", usage, calls: attempt };
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
      continue;
    }
    const checked = checkGroups(parsed, ids, links);
    if ("error" in checked) {
      reason = checked.error;
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: `That output failed validation: ${reason}. Return the corrected JSON for the same posts.` });
      continue;
    }
    return { ...checked, usage, calls: attempt };
  }
  return { error: reason, usage, calls: 1 + OUTPUT_RETRIES };
}
