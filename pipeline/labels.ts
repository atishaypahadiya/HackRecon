// review/labels.csv: the day-2 labeled set (D12, D13). Context columns are written by `hr pool`;
// label columns are written by `hr prelabel` (the Opus judge, D21) or by hand in `hr label`, and
// `hr pool` never overwrites them. `labeler` says which. Label columns reuse the credit sheet's
// names (review/credits.csv, D13) so `hr sheet` can pre-fill from them. Rules: docs/labeling.md.
import { existsSync, readFileSync } from "node:fs";
import { readTable } from "./csv.ts";
import { AMOUNT_BASES, DEADLINE_STATUSES } from "./schema.ts";
import { ISO_WITH_OFFSET } from "./time.ts";

export const LABELS_PATH = "review/labels.csv";
/** The labeling rules. Their Columns section goes verbatim into both prompts: the Opus judge's
 *  (D21) and the classifier's, so both read the same rules. */
export const RULES_PATH = "docs/labeling.md";
export const RULES_HEADING = "## Columns";
export const POOL_META_PATH = "review/pool.json";

export const CONTEXT_COLUMNS = [
  "message_id",
  "channel",
  "sponsor",
  "posted_at",
  "author",
  "subtype",
  "pool",
  "in_capture",
  "permalink",
  "text",
] as const;

export const LABEL_COLUMNS = [
  "is_credit",
  "is_dated",
  "exclude",
  "credits_in_post",
  "amount_text",
  "amount_usd_per_person",
  "amount_basis",
  "deadline_iso",
  "deadline_status",
  "window_end",
  "notes",
] as const;

/** Who wrote a row's label columns: OPUS_LABELER (hr prelabel) or HAND_LABELER (hr label, or a
 *  spreadsheet edit). Empty on unlabeled rows. */
export const LABELER_COLUMN = "labeler";
export const OPUS_LABELER = "opus-5-5";
export const HAND_LABELER = "hand";

export const COLUMNS = [...CONTEXT_COLUMNS, ...LABEL_COLUMNS, LABELER_COLUMN] as const;

export type ContextColumn = (typeof CONTEXT_COLUMNS)[number];
export type LabelColumn = (typeof LABEL_COLUMNS)[number];
export type LabelRow = Record<ContextColumn | LabelColumn | typeof LABELER_COLUMN, string>;

/** keyword: matched the keyword regex in the baseline. miss_check: either D12 miss check (30 random
 *  non-hits, or classifier-flagged non-hits); which one is recorded only in review/pool.json. */
export const POOLS = ["keyword", "miss_check"] as const;

export function readLabels(path = LABELS_PATH): LabelRow[] {
  if (!existsSync(path)) return [];
  // Sheets written before the labeler column existed read as labeler "".
  return readTable(readFileSync(path, "utf8"), [...CONTEXT_COLUMNS, ...LABEL_COLUMNS]).map((r) => ({ ...r, labeler: r.labeler ?? "" })) as LabelRow[];
}

/** The labeler of a row with labels: its labeler cell, or hand when a label predates the column. */
export function labelerOf(r: LabelRow): string {
  return r.labeler.trim() || (hasLabel(r) ? HAND_LABELER : "");
}

/** The labeling rules exactly as written: the Columns section of docs/labeling.md, heading included. */
export function rulesSection(md: string): string {
  const start = md.split("\n").findIndex((l) => l.trim() === RULES_HEADING);
  if (start < 0) throw new Error(`${RULES_PATH} has no "${RULES_HEADING}" section`);
  const lines = md.split("\n").slice(start);
  const end = lines.findIndex((l, i) => i > 0 && /^## /.test(l));
  return (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
}

export function readRules(path = RULES_PATH): string {
  return rulesSection(readFileSync(path, "utf8"));
}

export function hasLabel(r: LabelRow): boolean {
  return LABEL_COLUMNS.some((c) => r[c].trim() !== "");
}

const YN = new Set(["y", "n"]);

/** Problems with a row's hand-entered values (empty cells are fine: not labeled yet). */
export function labelProblems(r: LabelRow): string[] {
  const p: string[] = [];
  const v = (c: LabelColumn) => r[c].trim();
  for (const c of ["is_credit", "is_dated", "exclude"] as const) if (v(c) && !YN.has(v(c))) p.push(`${c} must be y or n`);
  if (v("credits_in_post") && !/^\d+$/.test(v("credits_in_post"))) p.push("credits_in_post must be a whole number");
  if (v("amount_basis") && !(AMOUNT_BASES as readonly string[]).includes(v("amount_basis"))) p.push(`amount_basis must be one of ${AMOUNT_BASES.join("|")}`);
  if (v("deadline_status") && !(DEADLINE_STATUSES as readonly string[]).includes(v("deadline_status"))) {
    p.push(`deadline_status must be one of ${DEADLINE_STATUSES.join("|")}`);
  }
  for (const c of ["deadline_iso", "window_end"] as const) if (v(c) && !ISO_WITH_OFFSET.test(v(c))) p.push(`${c} must look like 2026-10-25T09:00-07:00`);
  if (v("amount_usd_per_person")) {
    if (!/^\d+(?:\.\d+)?$/.test(v("amount_usd_per_person"))) p.push("amount_usd_per_person must be a plain number (no $)");
    if (v("amount_basis") !== "per_person") p.push("amount_usd_per_person is set only when amount_basis = per_person");
  }
  if (v("deadline_iso") && !["explicit", "resolved_relative"].includes(v("deadline_status"))) {
    p.push("deadline_iso needs deadline_status explicit or resolved_relative");
  }
  if (["explicit", "resolved_relative"].includes(v("deadline_status")) && !v("deadline_iso")) p.push(`deadline_status ${v("deadline_status")} needs deadline_iso`);
  if (v("is_credit") === "n" && (v("amount_usd_per_person") || Number(v("credits_in_post")) > 0)) p.push("is_credit = n but credit fields are filled");
  if (v("is_credit") === "y" && !(Number(v("credits_in_post")) >= 1)) p.push("is_credit = y needs credits_in_post 1 or more");
  const dated = !!v("deadline_iso") || !!v("window_end") || v("deadline_status") === "unresolved";
  if (v("is_dated") === "n" && dated) p.push("is_dated = n but a deadline or window_end is filled");
  if (v("is_dated") === "y" && v("deadline_status") === "none" && !v("window_end")) p.push("is_dated = y but deadline_status = none and no window_end");
  return p;
}
