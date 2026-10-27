// `hr gate`: the day-2 gate (design doc, "Day-2 gate"), scored on review/labels.csv against
// data/items.json. Only labeled rows are ever scored or shown: nothing the classifier said about
// an unlabeled row is reported, not even in aggregate, so labeling stays blind.
import { labelProblems, type LabelRow } from "./labels.ts";
import type { Item } from "./schema.ts";
import { eventDate } from "./time.ts";

export const THRESHOLDS = { precision: 0.85, recall: 0.85, field: 0.9, capture: 0.95, minPositives: 20 } as const;

/** A count split the way every gate number is reported: top-level posts and thread broadcasts. */
export interface Ratio {
  n: number;
  d: number;
  top: [number, number];
  broadcast: [number, number];
}

function ratio(rows: { r: LabelRow; ok: boolean }[]): Ratio {
  const out: Ratio = { n: 0, d: 0, top: [0, 0], broadcast: [0, 0] };
  for (const { r, ok } of rows) {
    const part = r.subtype === "thread_broadcast" ? out.broadcast : out.top;
    out.d++, part[1]++;
    if (ok) out.n++, part[0]++;
  }
  return out;
}

export const rate = (x: Ratio): number | null => (x.d ? x.n / x.d : null);
const meets = (x: Ratio, min: number) => x.d > 0 && x.n / x.d >= min;

export interface Prediction {
  credit: boolean;
  dated: boolean;
  credits: Item[];
  deadlines: Item[];
}

export function predictions(items: Item[]): Map<string, Prediction> {
  const out = new Map<string, Prediction>();
  for (const it of items) {
    const p = out.get(it.message_id) ?? { credit: false, dated: false, credits: [], deadlines: [] };
    if (it.kind === "credit") p.credit = true, p.credits.push(it);
    if (it.deadline_status !== "none") p.dated = true, p.deadlines.push(it);
    out.set(it.message_id, p);
  }
  return out;
}

const NONE: Prediction = { credit: false, dated: false, credits: [], deadlines: [] };

export interface GateInput {
  rows: LabelRow[];
  items: Item[];
  /** Message ids data/items.json covers (classified under the scored prompt; zero items is an answer). */
  classified: Set<string>;
  /** Message ids that failed classification (D10): scored as predicted negative. */
  errors: Set<string>;
  /** Miss check 2 membership (review/pool.json). */
  randomIds: Set<string>;
  /** Miss check 1 rows added to the sheet (review/pool.json); empty until `hr pool --add-flagged`. */
  flaggedIds: Set<string>;
  promptHash: string;
  /** Hash the current config would produce; differs when items.json is stale. */
  currentPromptHash: string;
  /** Set once `hr pool --add-flagged` ran over the whole capture. */
  flaggedCheckRan: boolean;
}

export interface Miss {
  message_id: string;
  permalink: string;
  label: string;
  classifier: string;
}

export interface GateReport {
  prompt_hash: string;
  stale: boolean;
  rows: number;
  labeled: number;
  skipped: { unlabeled: number; incomplete: number; invalid: { message_id: string; problems: string[] }[] };
  /** Labeled rows in the capture with no classifier answer under this prompt (rerun classify). */
  not_classified: number;
  /** Labeled rows whose classification failed; counted as predicted negative. */
  errors: number;
  capture_recall: Ratio;
  /** Scored set (D12): keyword hits plus classifier-flagged rows outside them. */
  scored: number;
  positives: { credit: Ratio; dated: Ratio };
  credit: { precision: Ratio; recall: Ratio };
  dated: { precision: Ratio; recall: Ratio };
  amount: { all: Ratio; priced: Ratio; unpriced: Ratio; multi_credit_not_scored: number };
  deadline: { all: Ratio; unresolved_labels: Ratio };
  random: { labeled: number; of: number; credit_found: Ratio; dated_found: Ratio };
  flagged: { ran: boolean; labeled: number; of: number; credit_found: Ratio; dated_found: Ratio };
  misses: { credit_fn: Miss[]; credit_fp: Miss[]; dated_fn: Miss[]; dated_fp: Miss[]; amount: Miss[]; deadline: Miss[] };
  pass: Record<string, boolean>;
  complete: boolean;
}

type State = "ok" | "unlabeled" | "incomplete" | "invalid";

/** A row is labeled once is_credit and is_dated are both y/n and nothing in it is malformed. */
export function rowState(r: LabelRow): State {
  const filled = [r.is_credit, r.is_dated].filter((v) => v.trim() !== "").length;
  if (filled === 0 && !r.exclude.trim()) return "unlabeled";
  if (filled < 2) return "incomplete"; // still being labeled; `hr pool --check` reports its problems
  return labelProblems(r).length ? "invalid" : "ok";
}

const fmtAmount = (v: number | undefined) => (v === undefined ? "unpriced" : String(v));
const describeCredits = (p: Prediction) =>
  p.credits.length ? p.credits.map((c) => `${fmtAmount(c.amount_usd_per_person)} (${c.amount_basis}, "${c.amount_text}")`).join("; ") : "no credit item";
const describeDeadlines = (p: Prediction) =>
  p.deadlines.length ? p.deadlines.map((d) => `${d.deadline_iso ?? d.deadline_status} [${d.kind}]`).join("; ") : "no deadline";

/** Label target for deadline accuracy: deadline_iso, else the claim window end (D15). */
function deadlineMatch(r: LabelRow, p: Prediction): boolean {
  const target = r.deadline_iso.trim() || r.window_end.trim();
  const dateOnly = /\bdate-only\b/i.test(r.notes);
  return p.deadlines.some((d) => {
    if (!d.deadline_iso) return false;
    if (dateOnly) return eventDate(d.deadline_iso) === eventDate(target);
    return Math.floor(Date.parse(d.deadline_iso) / 60000) === Math.floor(Date.parse(target) / 60000);
  });
}

export function scoreGate(g: GateInput): GateReport {
  const preds = predictions(g.items);
  const states = g.rows.map((r) => ({ r, s: rowState(r) }));
  const labeled = states.filter((x) => x.s === "ok").map((x) => x.r);
  const yes = (v: string) => v.trim() === "y";
  const positive = (r: LabelRow) => yes(r.is_credit) || yes(r.is_dated);

  // Capture recall: every labeled positive, captured or not (R3-10).
  const capture_recall = ratio(labeled.filter(positive).map((r) => ({ r, ok: r.in_capture === "y" })));

  // Classification uses labeled rows that are in the capture and have an answer (or failed).
  const inCapture = labeled.filter((r) => r.in_capture === "y");
  const answered = inCapture.filter((r) => g.classified.has(r.message_id) || g.errors.has(r.message_id));
  const pred = (r: LabelRow) => (g.errors.has(r.message_id) ? NONE : (preds.get(r.message_id) ?? NONE));
  const flaggedByClassifier = (r: LabelRow) => pred(r).credit || pred(r).dated;
  const scored = answered.filter((r) => r.pool === "keyword" || flaggedByClassifier(r));

  const credit_fn: Miss[] = [], credit_fp: Miss[] = [], dated_fn: Miss[] = [], dated_fp: Miss[] = [];
  const miss = (r: LabelRow, label: string, classifier: string): Miss => ({ message_id: r.message_id, permalink: r.permalink, label, classifier });
  for (const r of scored) {
    const p = pred(r);
    const why = g.errors.has(r.message_id) ? "classification failed" : "";
    if (yes(r.is_credit) && !p.credit) credit_fn.push(miss(r, "credit", why || "no credit item"));
    if (!yes(r.is_credit) && p.credit) credit_fp.push(miss(r, yes(r.exclude) ? "not a credit (exclude)" : "not a credit", describeCredits(p)));
    if (yes(r.is_dated) && !p.dated) dated_fn.push(miss(r, "dated", why || "no deadline"));
    if (!yes(r.is_dated) && p.dated) dated_fp.push(miss(r, "not dated", describeDeadlines(p)));
  }

  // Field accuracy on labeled positives in the scored set; a missed item counts as wrong.
  const amountRows = scored.filter((r) => yes(r.is_credit) && Number(r.credits_in_post) === 1);
  const amountMisses: Miss[] = [];
  const amountScored = amountRows.map((r) => {
    const label = r.amount_usd_per_person.trim() === "" ? undefined : Number(r.amount_usd_per_person);
    const p = pred(r);
    const ok = p.credits.length > 0 && p.credits.every((c) => c.amount_usd_per_person === label);
    if (!ok) amountMisses.push(miss(r, fmtAmount(label), describeCredits(p)));
    return { r, ok, priced: label !== undefined };
  });
  const deadlineRows = scored.filter((r) => yes(r.is_dated) && (r.deadline_iso.trim() || r.window_end.trim()));
  const deadlineMisses: Miss[] = [];
  const deadlineScored = deadlineRows.map((r) => {
    const ok = deadlineMatch(r, pred(r));
    if (!ok) {
      const target = r.deadline_iso.trim() || `${r.window_end.trim()} (window_end)`;
      deadlineMisses.push(miss(r, /\bdate-only\b/i.test(r.notes) ? `${target}, date only` : target, describeDeadlines(pred(r))));
    }
    return { r, ok };
  });
  const unresolvedRows = scored.filter((r) => yes(r.is_dated) && !r.deadline_iso.trim() && !r.window_end.trim());

  // Miss check 2 (random 30) and miss check 1 (flagged outside the hits), each reported apart.
  const randomRows = answered.filter((r) => g.randomIds.has(r.message_id));
  const flaggedRows = answered.filter((r) => r.pool !== "keyword" && flaggedByClassifier(r));
  const found = (rows: LabelRow[], col: "is_credit" | "is_dated", by: "credit" | "dated") =>
    ratio(rows.filter((r) => yes(r[col])).map((r) => ({ r, ok: pred(r)[by] })));

  const report: GateReport = {
    prompt_hash: g.promptHash,
    stale: g.promptHash !== g.currentPromptHash,
    rows: g.rows.length,
    labeled: labeled.length,
    skipped: {
      unlabeled: states.filter((x) => x.s === "unlabeled").length,
      incomplete: states.filter((x) => x.s === "incomplete").length,
      invalid: states.filter((x) => x.s === "invalid").map((x) => ({ message_id: x.r.message_id, problems: labelProblems(x.r) })),
    },
    not_classified: inCapture.length - answered.length,
    errors: answered.filter((r) => g.errors.has(r.message_id)).length,
    capture_recall,
    scored: scored.length,
    positives: {
      credit: ratio(scored.filter((r) => yes(r.is_credit)).map((r) => ({ r, ok: true }))),
      dated: ratio(scored.filter((r) => yes(r.is_dated)).map((r) => ({ r, ok: true }))),
    },
    credit: {
      precision: ratio(scored.filter((r) => pred(r).credit).map((r) => ({ r, ok: yes(r.is_credit) }))),
      recall: ratio(scored.filter((r) => yes(r.is_credit)).map((r) => ({ r, ok: pred(r).credit }))),
    },
    dated: {
      precision: ratio(scored.filter((r) => pred(r).dated).map((r) => ({ r, ok: yes(r.is_dated) }))),
      recall: ratio(scored.filter((r) => yes(r.is_dated)).map((r) => ({ r, ok: pred(r).dated }))),
    },
    amount: {
      all: ratio(amountScored),
      priced: ratio(amountScored.filter((x) => x.priced)),
      unpriced: ratio(amountScored.filter((x) => !x.priced)),
      multi_credit_not_scored: scored.filter((r) => yes(r.is_credit) && Number(r.credits_in_post) > 1).length,
    },
    deadline: {
      all: ratio(deadlineScored),
      unresolved_labels: ratio(unresolvedRows.map((r) => ({ r, ok: pred(r).deadlines.some((d) => d.deadline_status === "unresolved") }))),
    },
    random: {
      labeled: labeled.filter((r) => g.randomIds.has(r.message_id)).length,
      of: g.randomIds.size,
      credit_found: found(randomRows, "is_credit", "credit"),
      dated_found: found(randomRows, "is_dated", "dated"),
    },
    flagged: {
      ran: g.flaggedCheckRan,
      labeled: flaggedRows.length,
      of: g.flaggedIds.size,
      credit_found: ratio(flaggedRows.filter((r) => yes(r.is_credit)).map((r) => ({ r, ok: true }))),
      dated_found: ratio(flaggedRows.filter((r) => yes(r.is_dated)).map((r) => ({ r, ok: true }))),
    },
    misses: { credit_fn, credit_fp, dated_fn, dated_fp, amount: amountMisses, deadline: deadlineMisses },
    pass: {},
    complete: false,
  };
  report.pass = {
    capture_recall: meets(capture_recall, THRESHOLDS.capture),
    credit_precision: meets(report.credit.precision, THRESHOLDS.precision),
    credit_recall: meets(report.credit.recall, THRESHOLDS.recall),
    dated_precision: meets(report.dated.precision, THRESHOLDS.precision),
    dated_recall: meets(report.dated.recall, THRESHOLDS.recall),
    amount_accuracy: meets(report.amount.all, THRESHOLDS.field),
    deadline_accuracy: meets(report.deadline.all, THRESHOLDS.field),
  };
  const allLabeled = report.skipped.unlabeled + report.skipped.incomplete + report.skipped.invalid.length === 0;
  report.complete = allLabeled && report.not_classified === 0 && !report.stale && g.flaggedCheckRan;
  return report;
}

const pct = (x: Ratio) => (x.d ? `${((x.n / x.d) * 100).toFixed(1)}%` : "n/a");
const split = (x: Ratio) => (x.broadcast[1] ? `; top-level ${x.top[0]}/${x.top[1]}, broadcast ${x.broadcast[0]}/${x.broadcast[1]}` : "");
const show = (x: Ratio) => `${pct(x)} (${x.n}/${x.d}${split(x)})`;
const count = (x: Ratio) => `${x.d}${x.broadcast[1] ? ` (top-level ${x.top[1]}, broadcast ${x.broadcast[1]})` : ""}`;
const verdict = (ok: boolean, x: Ratio, min: number) => (x.d === 0 ? "no positives yet" : ok ? `ok (≥ ${min * 100}%)` : `FAIL (< ${min * 100}%)`);

export function formatGate(rep: GateReport): string {
  const L: string[] = [];
  const t = THRESHOLDS;
  L.push(`day-2 gate, classifier prompt ${rep.prompt_hash}${rep.stale ? " (STALE: config now gives a different prompt; rerun hr classify)" : ""}`);
  L.push(
    `labeled ${rep.labeled}/${rep.rows} rows; skipped ${rep.skipped.unlabeled} unlabeled, ${rep.skipped.incomplete} incomplete ` +
      `(is_credit or is_dated empty), ${rep.skipped.invalid.length} with label problems`,
  );
  for (const v of rep.skipped.invalid) L.push(`  label problem ${v.message_id}: ${v.problems.join("; ")}`);
  if (rep.not_classified) L.push(`not classified under this prompt: ${rep.not_classified} labeled rows (run: bun run hr classify --labeled-only); left out of every number below`);
  L.push(`classification errors: ${rep.errors} labeled rows (counted as predicted negative)`);
  L.push("");
  L.push(`capture recall          ${show(rep.capture_recall)}  ${verdict(rep.pass.capture_recall!, rep.capture_recall, t.capture)}`);
  L.push(`scored set: ${rep.scored} labeled rows (keyword hits + classifier-flagged outside them, D12)`);
  L.push(
    `positives: credit ${count(rep.positives.credit)}, dated ${count(rep.positives.dated)} (minimum ${t.minPositives} each` +
      `${rep.positives.credit.d < t.minPositives || rep.positives.dated.d < t.minPositives ? "; below it so far" : ""})`,
  );
  L.push(`credit precision        ${show(rep.credit.precision)}  ${verdict(rep.pass.credit_precision!, rep.credit.precision, t.precision)}`);
  L.push(`credit recall           ${show(rep.credit.recall)}  ${verdict(rep.pass.credit_recall!, rep.credit.recall, t.recall)}`);
  L.push(`dated precision         ${show(rep.dated.precision)}  ${verdict(rep.pass.dated_precision!, rep.dated.precision, t.precision)}`);
  L.push(`dated recall            ${show(rep.dated.recall)}  ${verdict(rep.pass.dated_recall!, rep.dated.recall, t.recall)}`);
  L.push(`amount_usd_per_person   ${show(rep.amount.all)}  ${verdict(rep.pass.amount_accuracy!, rep.amount.all, t.field)}`);
  L.push(`  priced ${show(rep.amount.priced)}, unpriced ${show(rep.amount.unpriced)}; ${rep.amount.multi_credit_not_scored} multi-credit rows not scored`);
  L.push(`deadline_iso            ${show(rep.deadline.all)}  ${verdict(rep.pass.deadline_accuracy!, rep.deadline.all, t.field)}`);
  L.push(`  to the minute where a time is stated, to the day for date-only labels; unresolved labels, classifier also unresolved: ${show(rep.deadline.unresolved_labels)}`);
  L.push("");
  L.push(`miss check 2, random ${rep.random.of} (outside the keyword list): ${rep.random.labeled} labeled`);
  L.push(`  credit positives found ${rep.random.credit_found.d}, classifier caught ${show(rep.random.credit_found)}`);
  L.push(`  dated positives found ${rep.random.dated_found.d}, classifier caught ${show(rep.random.dated_found)}`);
  if (!rep.flagged.ran) L.push("miss check 1, classifier-flagged outside the hits: not run yet (bun run hr classify, then bun run hr pool --add-flagged)");
  else {
    L.push(`miss check 1, classifier-flagged outside the hits: ${rep.flagged.labeled} labeled (${rep.flagged.of} rows added to the sheet)`);
    L.push(`  regex gaps found: credit ${count(rep.flagged.credit_found)}, dated ${count(rep.flagged.dated_found)}`);
  }
  const list = (title: string, xs: Miss[]) => {
    if (!xs.length) return;
    L.push("", `${title} (${xs.length}):`);
    for (const m of xs) L.push(`  ${m.permalink}  label: ${m.label}  classifier: ${m.classifier}`);
  };
  list("credit missed", rep.misses.credit_fn);
  list("credit false positives", rep.misses.credit_fp);
  list("dated missed", rep.misses.dated_fn);
  list("dated false positives", rep.misses.dated_fp);
  list("amount_usd_per_person wrong", rep.misses.amount);
  list("deadline_iso wrong", rep.misses.deadline);
  L.push("");
  const failed = Object.entries(rep.pass).filter(([, ok]) => !ok).map(([k]) => k);
  L.push(
    `${failed.length ? `FAIL: ${failed.join(", ")}` : "PASS"}` +
      (rep.complete ? "" : " (provisional: " + [
        rep.skipped.unlabeled + rep.skipped.incomplete + rep.skipped.invalid.length ? "rows still unlabeled" : "",
        rep.not_classified ? "rows not classified" : "",
        rep.stale ? "items are stale" : "",
        rep.flagged.ran ? "" : "miss check 1 not run",
      ].filter(Boolean).join(", ") + ")"),
  );
  return L.join("\n");
}
