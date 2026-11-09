import { describe, expect, test } from "bun:test";
import { formatGate, rate, rowState, scoreGate, type GateInput } from "./gate.ts";
import { COLUMNS, type LabelRow } from "./labels.ts";
import type { Item } from "./schema.ts";

let seq = 0;
const row = (o: Partial<LabelRow> = {}): LabelRow => {
  const ts = `17928${String(++seq).padStart(5, "0")}.000000`;
  return {
    ...(Object.fromEntries(COLUMNS.map((c) => [c, ""])) as LabelRow),
    message_id: `C1:${ts}`,
    channel: "spons-a",
    pool: "keyword",
    in_capture: "y",
    permalink: `https://w/archives/C1/p${ts.replace(".", "")}`,
    ...o,
  };
};
const neg = (o: Partial<LabelRow> = {}) => row({ is_credit: "n", is_dated: "n", ...o });
const credit = (usd: string, o: Partial<LabelRow> = {}) =>
  row({ is_credit: "y", is_dated: "n", credits_in_post: "1", amount_usd_per_person: usd, amount_basis: usd ? "per_person" : "pool", ...o });
const dated = (iso: string, o: Partial<LabelRow> = {}) => row({ is_credit: "n", is_dated: "y", deadline_iso: iso, deadline_status: "explicit", ...o });

const item = (message_id: string, o: Partial<Item> = {}): Item => ({
  message_id,
  item_index: 0,
  kind: "credit",
  sponsor: "A",
  offer_key: "",
  amount_text: "$50",
  amount_unit: "USD",
  amount_basis: "per_person",
  deadline_status: "none",
  urls: [],
  model: "m",
  classified_at: "t",
  ...o,
});

const input = (rows: LabelRow[], items: Item[], o: Partial<GateInput> = {}): GateInput => ({
  tz: "America/Los_Angeles",
  rows,
  items,
  classified: new Set(rows.map((r) => r.message_id)),
  errors: new Set(),
  randomIds: new Set(),
  flaggedIds: new Set(),
  promptHash: "abc",
  currentPromptHash: "abc",
  flaggedCheckRan: true,
  ...o,
});

describe("rowState", () => {
  test("labeled needs both is_credit and is_dated; malformed rows are invalid", () => {
    expect(rowState(row())).toBe("unlabeled");
    expect(rowState(row({ is_credit: "n" }))).toBe("incomplete");
    expect(rowState(neg())).toBe("ok");
    expect(rowState(row({ is_credit: "y", is_dated: "n" }))).toBe("invalid"); // credits_in_post missing
  });
});

describe("unlabeled rows (blind labeling)", () => {
  const labeled = [credit("50"), neg()];
  const unlabeled = [row(), row({ is_credit: "y" }), row({ pool: "miss_check" })];
  const rows = [...labeled, ...unlabeled];
  const base = [item(labeled[0]!.message_id, { amount_usd_per_person: 50 })];

  test("are skipped and counted", () => {
    const r = scoreGate(input(rows, base));
    expect(r.labeled).toBe(2);
    expect(r.skipped).toEqual({ unlabeled: 2, incomplete: 1, invalid: [] });
    expect(r.complete).toBe(false);
  });

  test("whatever the classifier said about them, the printed gate is identical", () => {
    const answers = unlabeled.flatMap((r) => [
      item(r.message_id, { amount_usd_per_person: 999, amount_text: "LEAK" }),
      item(r.message_id, { kind: "deadline", deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "explicit" }),
    ]);
    const without = formatGate(scoreGate(input(rows, base)));
    const withAnswers = formatGate(scoreGate(input(rows, [...base, ...answers])));
    expect(withAnswers).toBe(without);
    for (const r of unlabeled) expect(without).not.toContain(r.message_id.split(":")[1]!.replace(".", ""));
    expect(without).not.toContain("LEAK");
  });
});

describe("credit and dated precision/recall", () => {
  test("counted on keyword hits plus classifier-flagged rows outside them, split top-level / broadcast", () => {
    const tp = credit("50");
    const fn = credit("", { subtype: "thread_broadcast" });
    const fp = neg();
    const flaggedOutside = neg({ pool: "miss_check" }); // classifier flags it: a false positive in the scored set
    const quietOutside = credit("", { pool: "miss_check" }); // not flagged, not a hit: only the miss checks see it
    const r = scoreGate(
      input(
        [tp, fn, fp, flaggedOutside, quietOutside],
        [item(tp.message_id, { amount_usd_per_person: 50 }), item(fp.message_id), item(flaggedOutside.message_id)],
      ),
    );
    expect(r.scored).toBe(4);
    expect(r.credit.precision).toEqual({ n: 1, d: 3, top: [1, 3], broadcast: [0, 0] });
    expect(r.credit.recall).toEqual({ n: 1, d: 2, top: [1, 1], broadcast: [0, 1] });
    expect(r.positives.credit.d).toBe(2);
    expect(r.misses.credit_fn.map((m) => m.message_id)).toEqual([fn.message_id]);
    expect(r.misses.credit_fp.map((m) => m.message_id)).toEqual([fp.message_id, flaggedOutside.message_id]);
    expect(r.pass.credit_precision).toBe(false);
  });

  test("a failed classification counts as a miss; an unclassified row is left out and counted", () => {
    const failed = credit("50");
    const notRun = credit("50");
    const r = scoreGate(input([failed, notRun], [], { classified: new Set(), errors: new Set([failed.message_id]) }));
    expect(r.errors).toBe(1);
    expect(r.not_classified).toBe(1);
    expect(r.credit.recall).toMatchObject({ n: 0, d: 1 });
    expect(r.misses.credit_fn[0]!.classifier).toBe("classification failed");
  });

  test("no positives means n/a, never a pass", () => {
    const r = scoreGate(input([neg()], []));
    expect(rate(r.credit.recall)).toBeNull();
    expect(r.pass.credit_recall).toBe(false);
    expect(formatGate(r)).toContain("credit recall           n/a (0/0)  no positives yet");
  });
});

describe("field accuracy", () => {
  test("amount_usd_per_person exact, unpriced must stay unpriced, a missing credit item is wrong", () => {
    const priced = credit("50");
    const unpriced = credit("");
    const wrongPrice = credit("25");
    const noItem = credit("10");
    const multi = row({ is_credit: "y", is_dated: "n", credits_in_post: "2" });
    const r = scoreGate(
      input(
        [priced, unpriced, wrongPrice, noItem, multi],
        [
          item(priced.message_id, { amount_usd_per_person: 50 }),
          item(unpriced.message_id, { amount_basis: "pool" }),
          item(wrongPrice.message_id, { amount_usd_per_person: 100, amount_basis: "per_person" }),
          item(multi.message_id),
        ],
      ),
    );
    expect(r.amount.all).toMatchObject({ n: 2, d: 4 });
    expect(r.amount.priced).toMatchObject({ n: 1, d: 3 });
    expect(r.amount.unpriced).toMatchObject({ n: 1, d: 1 });
    expect(r.amount.multi_credit_not_scored).toBe(1);
    expect(r.misses.amount.map((m) => [m.label, m.classifier])).toEqual([
      ["25", '100 (per_person, "$50")'],
      ["10", "no credit item"],
    ]);
  });

  test("deadline_iso to the minute when a time is stated, to the day for date-only, window_end as the target", () => {
    const d = (o: Partial<Item>) => ({ kind: "deadline" as const, deadline_status: "explicit" as const, ...o });
    const minute = dated("2026-10-25T09:00-07:00");
    const sameInstantUtc = dated("2026-10-25T09:30-07:00");
    const offByHour = dated("2026-10-25T09:00-07:00");
    const dateOnly = dated("2026-10-25T23:59-07:00", { notes: "date-only" });
    const window = row({ is_credit: "n", is_dated: "y", window_end: "2026-10-24T19:00-07:00" });
    const unresolved = row({ is_credit: "n", is_dated: "y", deadline_status: "unresolved" });
    const r = scoreGate(
      input(
        [minute, sameInstantUtc, offByHour, dateOnly, window, unresolved],
        [
          item(minute.message_id, d({ deadline_iso: "2026-10-25T09:00:00-07:00" })),
          item(sameInstantUtc.message_id, d({ deadline_iso: "2026-10-25T16:30:00Z" })),
          item(offByHour.message_id, d({ deadline_iso: "2026-10-25T10:00:00-07:00" })),
          item(dateOnly.message_id, d({ deadline_iso: "2026-10-25T17:00:00-07:00" })),
          item(window.message_id, d({ deadline_iso: "2026-10-24T19:00:00-07:00", deadline_status: "resolved_relative" })),
          item(unresolved.message_id, d({ deadline_status: "unresolved" })),
        ],
      ),
    );
    expect(r.deadline.all).toMatchObject({ n: 4, d: 5 });
    expect(r.misses.deadline.map((m) => m.message_id)).toEqual([offByHour.message_id]);
    expect(r.deadline.unresolved_labels).toMatchObject({ n: 1, d: 1 });
    expect(r.dated.recall).toMatchObject({ n: 6, d: 6 });
  });
});

describe("miss checks", () => {
  test("random 30 reported apart: positives found outside the keyword list and what the classifier caught", () => {
    const caught = credit("", { pool: "miss_check" });
    const missed = dated("2026-10-25T09:00-07:00", { pool: "miss_check" });
    const plain = neg({ pool: "miss_check" });
    const r = scoreGate(input([caught, missed, plain], [item(caught.message_id, { amount_basis: "pool" })], { randomIds: new Set([caught.message_id, missed.message_id, plain.message_id]) }));
    expect(r.random).toMatchObject({ labeled: 3, of: 3 });
    expect(r.random.credit_found).toMatchObject({ n: 1, d: 1 });
    expect(r.random.dated_found).toMatchObject({ n: 0, d: 1 });
    expect(r.scored).toBe(1); // only the flagged one joins the scored set
  });

  test("flagged check: regex gaps among labeled flagged rows; says so when it hasn't run", () => {
    const gap = credit("5", { pool: "miss_check" });
    const falseFlag = neg({ pool: "miss_check" });
    const r = scoreGate(input([gap, falseFlag], [item(gap.message_id, { amount_usd_per_person: 5 }), item(falseFlag.message_id)], { flaggedIds: new Set([gap.message_id, falseFlag.message_id]) }));
    expect(r.flagged).toMatchObject({ ran: true, labeled: 2, of: 2 });
    expect(r.flagged.credit_found.d).toBe(1);
    expect(formatGate(scoreGate(input([gap], [], { flaggedCheckRan: false })))).toContain("miss check 1, classifier-flagged outside the hits: not run for this classifier prompt");
  });
});

describe("report", () => {
  test("prints the prompt hash, counts next to every %, and flags stale items", () => {
    const rows = [credit("50"), credit("10", { subtype: "thread_broadcast" })];
    const out = formatGate(
      scoreGate(input(rows, [item(rows[0]!.message_id, { amount_usd_per_person: 50 })], { promptHash: "1e5a8d8a43dfe770", currentPromptHash: "ffff" })),
    );
    expect(out).toContain("classifier prompt 1e5a8d8a43dfe770 (STALE");
    expect(out).toContain("credit recall           50.0% (1/2; top-level 1/1, broadcast 0/1)  FAIL (< 85%)");
    expect(out).toContain("items are stale");
  });

  test("a full pass is complete only when every row is labeled and both miss checks ran", () => {
    const rows = [credit("50"), dated("2026-10-25T09:00-07:00")];
    const items = [item(rows[0]!.message_id, { amount_usd_per_person: 50 }), item(rows[1]!.message_id, { kind: "deadline", deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "explicit" })];
    const r = scoreGate(input(rows, items));
    expect(Object.values(r.pass).every(Boolean)).toBe(true);
    expect(r.complete).toBe(true);
    expect(formatGate(r).split("\n").at(-1)).toBe("PASS");
  });
});

describe("reference labels (D21)", () => {
  const opus = (r: LabelRow) => ({ ...r, labeler: "opus-5-5" });
  const judge = { model: "claude-opus-5-5", promptHash: "j1", currentPromptHash: "j1" };

  test("Opus labels: every number is agreement with Opus, never called accuracy", () => {
    const a = opus(credit("50"));
    const b = opus(credit("25"));
    const items = [item(a.message_id, { amount_usd_per_person: 50 }), item(b.message_id, { amount_usd_per_person: 30 })];
    const rep = scoreGate(input([a, b], items, { judge }));
    expect(rep.reference).toEqual({ kind: "opus", labelers: { "opus-5-5": 2 }, judge_model: "claude-opus-5-5", judge_prompt_hash: "j1", judge_stale: false });
    const text = formatGate(rep);
    expect(text).toContain("reference labels: 2 by opus-5-5 (claude-opus-5-5 as an LLM judge, prompt j1). Every percentage below is agreement with Opus, not accuracy");
    expect(text).toContain("amount_usd_per_person   50.0% (1/2)");
    expect(text).toContain("opus: 25  classifier: 30");
    expect(text).toMatch(/FAIL: .*amount_agreement.* \(agreement with Opus, same thresholds; not accuracy\)/);
    expect(text).not.toMatch(/amount_accuracy|deadline_accuracy/);
  });

  test("Opus labels from another prompt, or with no run record, are stale and keep the gate provisional", () => {
    const rows = [opus(neg())];
    const changed = scoreGate(input(rows, [], { judge: { ...judge, currentPromptHash: "j2" } }));
    expect(changed.reference.judge_stale).toBe(true);
    expect(changed.complete).toBe(false);
    expect(formatGate(changed)).toContain("Opus labels are stale");
    expect(scoreGate(input(rows, [])).reference.judge_stale).toBe(true);
    expect(scoreGate(input(rows, [], { judge })).complete).toBe(true);
  });

  test("hand labels keep the accuracy wording; a mix says agreement with the labels", () => {
    const handOnly = formatGate(scoreGate(input([neg({ labeler: "hand" })], [])));
    expect(handOnly).toContain("reference labels: 1 by hand");
    expect(handOnly).not.toContain("agreement");
    const mixed = scoreGate(input([neg({ labeler: "hand" }), opus(neg())], [], { judge }));
    expect(mixed.reference.kind).toBe("mixed");
    expect(formatGate(mixed)).toContain("agreement with these labels, not accuracy");
  });
});
