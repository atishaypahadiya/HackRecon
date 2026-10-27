// `hr prelabel`: the Opus judge (D21). claude-opus-5-5 fills the label columns of every row in
// review/labels.csv from the same redacted input Haiku gets, under the rules in docs/labeling.md
// (its Columns section, verbatim). It's a demo-time eval, not ground truth: `hr gate` reports
// agreement with Opus. Blind to Haiku: this module reads the sheet's ids and text, the capture,
// config and the rules. It never reads the classifier's outputs or the miss-check membership, and
// it never sends the sheet's `pool` column.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { OUTPUT_RETRIES, scheduleLines, type ClassifyInput, type EventConfig } from "./classify.ts";
import { HAND_LABELER, LABEL_COLUMNS, labelerOf, labelProblems, OPUS_LABELER, type LabelColumn, type LabelRow } from "./labels.ts";
import { AMOUNT_BASES, DEADLINE_STATUSES } from "./schema.ts";

export const JUDGE_MODEL = "claude-opus-5-5";
/** Thinking is always on for Opus 5.5; effort is the only control (default medium). */
export const JUDGE_EFFORT = "high" as const;
/** Thinking counts toward max_tokens; the JSON itself is small. */
export const JUDGE_MAX_TOKENS = 16000;
export const RULES_PATH = "docs/labeling.md";
export const RULES_HEADING = "## Columns";
export const JUDGE_CACHE_PATH = "review/prelabel_cache.json";
/** Which prompt the judge's labels in the sheet came from (read by `hr gate`). */
export const JUDGE_RUN_PATH = "review/prelabel_run.json";
/** USD per million tokens for claude-opus-5-5: input, output, cache read, 5-minute cache write
 *  (claude-api skill: shared/models.md and shared/prompt-caching.md). */
export const JUDGE_PRICES = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } as const;

export type Labels = Record<LabelColumn, string>;

export interface JudgeEntry {
  message_id: string;
  prompt_hash: string;
  model: string;
  labels: Labels;
  labeled_at: string;
}
export type JudgeCache = Record<string, JudgeEntry>;

export interface Usage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}
export const NO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

export interface JudgeRun {
  model: string;
  labeler: string;
  effort: string;
  prompt_hash: string;
  rules: string;
  written_at: string;
  rows: number;
  labeled: number;
  kept_hand: number;
  errors: { message_id: string; reason: string }[];
  /** This run's API calls only (cached rows cost nothing). */
  usage: Usage;
  cost_usd: number;
}

/** The labeling rules exactly as written: the Columns section of docs/labeling.md, heading included. */
export function rulesSection(md: string): string {
  const start = md.split("\n").findIndex((l) => l.trim() === RULES_HEADING);
  if (start < 0) throw new Error(`${RULES_PATH} has no "${RULES_HEADING}" section`);
  const lines = md.split("\n").slice(start);
  const end = lines.findIndex((l, i) => i > 0 && /^## /.test(l));
  return (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
}

export function judgeSystemPrompt(rules: string, e: EventConfig): string {
  return `You label one Slack post from a sponsor or event channel of ${e.event}, a hackathon, for an evaluation sheet. Your labels are the reference another model's output is scored against, so apply the rules below exactly as written and label only what the post itself states. Never estimate a number the post doesn't state.

The rules, verbatim from the labeling guide:

<rules>
${rules}
</rules>

Return one row: every column as a string, "" for a cell that doesn't apply.

About the input:
- posted_at is the post's time in event time. Resolve relative times ("tonight", "Sunday 9am", "end of hacking") from it and the schedule below.
- poster_role is organizer, sponsor-side or other: a hint about who posted, not a rule.
- links lists every link in the post.
- Names in posts are redacted as [person] and @person; ignore them.

Event schedule (timezone ${e.timezone}, UTC-07:00 during the event):
${scheduleLines(e)}`;
}

const str = { type: "string" } as const;
const oneOf = (vs: readonly string[]) => ({ type: "string", enum: [...vs] }) as const;

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...LABEL_COLUMNS],
  properties: {
    is_credit: oneOf(["y", "n"]),
    is_dated: oneOf(["y", "n"]),
    exclude: oneOf(["y", "n"]),
    credits_in_post: str,
    amount_text: str,
    amount_usd_per_person: str,
    amount_basis: oneOf(["", ...AMOUNT_BASES]),
    deadline_iso: str,
    deadline_status: oneOf(["", ...DEADLINE_STATUSES]),
    window_end: str,
    notes: str,
  },
} as const;

export function judgeHash(system: string): string {
  return createHash("sha256").update(JSON.stringify([JUDGE_MODEL, JUDGE_EFFORT, system, JUDGE_SCHEMA])).digest("hex").slice(0, 16);
}

/** The judge's answer as sheet cells, or why it breaks the sheet's rules (the same check as `hr pool --check`). */
export function checkLabels(v: unknown): { labels: Labels } | { error: string } {
  if (typeof v !== "object" || v === null) return { error: "output is not an object" };
  const labels = {} as Labels;
  for (const c of LABEL_COLUMNS) {
    const x = (v as Record<string, unknown>)[c];
    if (typeof x !== "string") return { error: `${c} is not a string` };
    labels[c] = x.replace(/[\r\n]+/g, " ").trim();
  }
  if (!/^[yn]$/.test(labels.is_credit) || !/^[yn]$/.test(labels.is_dated)) return { error: "is_credit and is_dated must be y or n" };
  const problems = labelProblems({ ...labels } as LabelRow);
  return problems.length ? { error: problems.join("; ") } : { labels };
}

function addUsage(u: Usage, r: Anthropic.Messages.Usage): Usage {
  return {
    input: u.input + r.input_tokens,
    output: u.output + r.output_tokens,
    cache_read: u.cache_read + (r.cache_read_input_tokens ?? 0),
    cache_write: u.cache_write + (r.cache_creation_input_tokens ?? 0),
  };
}

export function sumUsage(us: Usage[]): Usage {
  return us.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cache_read: a.cache_read + u.cache_read, cache_write: a.cache_write + u.cache_write }), NO_USAGE);
}

export function costUsd(u: Usage): number {
  const p = JUDGE_PRICES;
  return (u.input * p.input + u.output * p.output + u.cache_read * p.cache_read + u.cache_write * p.cache_write) / 1e6;
}

/** One row: up to 1 + OUTPUT_RETRIES attempts on output that fails the sheet's rules. API errors are
 *  retried by the SDK (maxRetries 2); a refusal isn't retried. The system prompt is cached across rows. */
export async function judgeOne(
  client: Anthropic,
  system: string,
  hash: string,
  input: ClassifyInput,
  backoffMs = 1000,
): Promise<({ entry: JudgeEntry } | { error: string }) & { usage: Usage }> {
  let usage = NO_USAGE;
  let reason = "";
  for (let attempt = 1; attempt <= 1 + OUTPUT_RETRIES; attempt++) {
    if (attempt > 1) await Bun.sleep(backoffMs * 2 ** (attempt - 2));
    let res: Anthropic.Messages.Message;
    try {
      res = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        output_config: { effort: JUDGE_EFFORT, format: { type: "json_schema", schema: JUDGE_SCHEMA } },
        messages: [{ role: "user", content: input.user }],
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError) return { error: `API ${e.status ?? "connection"}: ${e.message}`, usage };
      throw e;
    }
    usage = addUsage(usage, res.usage);
    if (res.stop_reason === "refusal") {
      return { error: `refusal${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`, usage };
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
      continue;
    }
    const checked = checkLabels(parsed);
    if ("error" in checked) {
      reason = checked.error;
      continue;
    }
    return { entry: { message_id: input.message.id, prompt_hash: hash, model: JUDGE_MODEL, labels: checked.labels, labeled_at: new Date().toISOString() }, usage };
  }
  return { error: reason, usage };
}

/** Writes the judge's answers into the sheet. Hand-labeled rows are kept as they are unless
 *  `includeHand` (then the judge's answer replaces them, like any other row). A row the judge
 *  has no current answer for (failed, or its input or prompt changed) is cleared rather than left with
 *  an old answer, so the gate only ever scores labels from the current judge prompt. */
export function applyJudge(rows: LabelRow[], answers: Map<string, Labels>, includeHand = false): { rows: LabelRow[]; opus: number; hand: number; unlabeled: number } {
  let opus = 0;
  let hand = 0;
  const out = rows.map((r) => {
    const a = answers.get(r.message_id);
    if (labelerOf(r) === HAND_LABELER && !(includeHand && a)) return hand++, r;
    if (a) return opus++, { ...r, ...a, labeler: OPUS_LABELER };
    return { ...r, ...(Object.fromEntries(LABEL_COLUMNS.map((c) => [c, ""])) as Labels), labeler: "" };
  });
  return { rows: out, opus, hand, unlabeled: rows.length - opus - hand };
}
