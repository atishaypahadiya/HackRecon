import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { snapshotPage } from "../extension/src/page.ts";
import { checkCanon, checkJudge, deadlineInQuote, entityId, keyed, numbersIn, rematch, similarity, type RawEntity } from "./canon.ts";
import { coverage, figuresIn, moneyValue, statedTotal } from "./coverage.ts";
import { redactSnapshot, needsRedaction } from "./pages.ts";
import type { Entity } from "./schema.ts";

// A two-prize Devpost-shaped page: total = 500×1 + 300×2 = 1100.
const HTML = `<h1>Mini Hacks</h1>
<article id="challenge-requirements"><h3>Requirements</h3><ul><li>You must submit your hack by October 25th @ 9<span>&nbsp;AM&nbsp;</span>PST.</li></ul></article>
<article id="prizes"><h3>Prizes</h3><div id="prizes-overview"><div>$<span>1,100</span>+ in prizes</div></div>
<div id="prize_1"><h6><div>Mini Hacks Overall</div></h6><div class="prize-value">$500 in cash</div><div>1 winner</div><p>Laptop for each member</p></div>
<div id="prize_2"><h6><div>[Acme] Best Use of Acme</div></h6><div class="prize-value">$300 in cash</div><div>2 winners</div><p>1st place: $200 / 2nd place: $100</p></div>
</article>
<article id="judging-criteria"><h3>Judging Criteria</h3><ul><li><strong>Creativity</strong><br>Original ideas.</li></ul></article>`;
const snap = snapshotPage(parseHTML(`<html><body>${HTML}</body></html>`).document as unknown as Document, {
  url: "https://mini.devpost.com/",
  captured_at: "2026-11-06T00:00:00Z",
  access: "public",
  captured_by: "fixture",
});
const at = (text: string) => snap.blocks.find((b) => b.text === text || b.text.startsWith(text))!.i;

const good = (): RawEntity[] => [
  { ref: "t1", kind: "track", sponsor: "event", name: { value: "Mini Hacks Overall", block: at("Mini Hacks Overall"), quote: "Mini Hacks Overall" }, fields: [
    { field: "cash_value_usd", value: "500", block: at("$500 in cash"), quote: "$500 in cash" },
    { field: "winners", value: "1", block: at("1 winner"), quote: "1 winner" },
  ] },
  { ref: "p1", kind: "prize", sponsor: "event", name: { value: "Mini Hacks Overall", block: at("Mini Hacks Overall"), quote: "Mini Hacks Overall" }, fields: [
    { field: "track", value: "t1", block: 0, quote: "" },
    { field: "award_text", value: "Laptop for each member", block: at("Laptop"), quote: "Laptop for each member" },
  ] },
  { ref: "t2", kind: "track", sponsor: "Acme", name: { value: "[Acme] Best Use of Acme", block: at("[Acme]"), quote: "[Acme] Best Use of Acme" }, fields: [
    { field: "cash_value_usd", value: "300", block: at("$300 in cash"), quote: "$300 in cash" },
    { field: "winners", value: "2", block: at("2 winners"), quote: "2 winners" },
  ] },
  { ref: "p2", kind: "prize", sponsor: "Acme", name: { value: "1st place", block: at("1st place"), quote: "1st place" }, fields: [
    { field: "track", value: "t2", block: 0, quote: "" },
    { field: "place", value: "1st place", block: at("1st place"), quote: "1st place" },
    { field: "amount_usd", value: "200", block: at("1st place"), quote: "1st place: $200" },
  ] },
  { ref: "p3", kind: "prize", sponsor: "Acme", name: { value: "2nd place", block: at("1st place"), quote: "2nd place" }, fields: [
    { field: "track", value: "t2", block: 0, quote: "" },
    { field: "place", value: "2nd place", block: at("1st place"), quote: "2nd place" },
    { field: "amount_usd", value: "100", block: at("1st place"), quote: "2nd place: $100" },
  ] },
  { ref: "c1", kind: "criterion", sponsor: "event", name: { value: "Creativity", block: at("Creativity"), quote: "Creativity" }, fields: [{ field: "description", value: "Original ideas.", block: at("Creativity"), quote: "Original ideas." }] },
  { ref: "r1", kind: "rule", sponsor: "event", name: { value: "submit your hack", block: at("You must submit"), quote: "submit your hack" }, fields: [
    { field: "text", value: "You must submit your hack by October 25th @ 9 AM PST.", block: at("You must submit"), quote: "You must submit your hack by October 25th @ 9 AM PST." },
    { field: "rule_kind", value: "submission", block: at("You must submit"), quote: "You must submit your hack" },
    { field: "applies_to", value: "all", block: 0, quote: "" },
    { field: "deadline", value: "2026-10-25T09:00-07:00", block: at("You must submit"), quote: "by October 25th @ 9 AM PST" },
  ] },
];
const ok = (raw: RawEntity[]) => {
  const r = checkCanon({ entities: raw }, snap, "h");
  if ("error" in r) throw new Error(r.error);
  return r.entities;
};
const err = (raw: RawEntity[]) => {
  const r = checkCanon({ entities: raw }, snap, "h");
  return "error" in r ? r.error : "";
};

describe("checkCanon", () => {
  test("accepts a verified answer and maps refs to D7 ids", () => {
    const es = ok(good());
    const t2 = es.find((e) => e.name.value === "[Acme] Best Use of Acme")!;
    expect(t2.id).toBe("track:https://mini.devpost.com#mini-hacks/prizes/acme-best-use-of-acme");
    const p2 = es.find((e) => e.name.value === "1st place")!;
    expect(p2.fields.track_id!.value).toBe(t2.id);
    expect(p2.fields.amount_usd!.value).toBe(200);
    expect(p2.id).toBe("prize:https://mini.devpost.com#mini-hacks/prizes/acme-best-use-of-acme/1st-place");
    expect(p2.fields.amount_usd!.source).toMatchObject({ kind: "page", quote: "1st place: $200", snapshot_hash: "h", block: at("1st place") });
  });

  test("a quote that isn't in its block fails", () => {
    const raw = good();
    raw[0]!.fields[0]!.quote = "$5,000 in cash";
    expect(err(raw)).toContain('quote "$5,000 in cash" is not in block');
  });

  test("a number in the value that isn't in the quote fails", () => {
    const raw = good();
    raw[3]!.fields[2]!.value = "250";
    expect(err(raw)).toContain("250 not in its quote");
  });

  test("a deadline whose hour isn't in the quote fails", () => {
    const raw = good();
    raw[6]!.fields[3]!.value = "2026-10-25T09:30-07:00";
    expect(err(raw)).toBe("");
    raw[6]!.fields[3]!.value = "2026-10-25T10:00-07:00";
    expect(err(raw)).toContain("month, day or hour");
  });

  test("bad enum, unknown field for the kind, dangling ref, prize without track", () => {
    const raw = good();
    raw[6]!.fields[1]!.value = "vibes";
    raw[5]!.fields.push({ field: "winners", value: "1", block: 0, quote: "Mini Hacks" });
    raw[1]!.fields[0]!.value = "t9";
    raw[4]!.fields = raw[4]!.fields.filter((f) => f.field !== "track");
    const e = err(raw);
    expect(e).toContain('"vibes" is not one of submission|eligibility|conduct');
    expect(e).toContain("not a criterion field");
    expect(e).toContain('"t9" is not a ref');
    expect(e).toContain("a prize needs its track");
  });

  test("a prize's id comes from its track and place, not the name the model gave it", () => {
    const raw = good();
    raw[3]!.name = { value: "Acme first prize", block: at("1st place"), quote: "1st place: $200" };
    expect(ok(raw).find((e) => e.name.value === "Acme first prize")!.id).toBe("prize:https://mini.devpost.com#mini-hacks/prizes/acme-best-use-of-acme/1st-place");
    expect(ok(good()).find((e) => e.kind === "rule")!.id).toBe("rule:https://mini.devpost.com#mini-hacks/requirements/you-must-submit-your-hack-by-october-25th");
  });

  test("prizes sharing a place on one track are told apart by amount", () => {
    const raw = good();
    for (const i of [3, 4]) raw[i]!.fields = raw[i]!.fields.filter((f) => f.field !== "place");
    const ids = ok(raw).filter((e) => e.kind === "prize" && e.sponsor === "Acme").map((e) => e.id.split("/").at(-1));
    expect(ids).toEqual(["usd-200", "usd-100"]);
  });

  test("same heading path and name twice keeps both, numbered in page order", () => {
    const raw = good();
    raw.push({ ...raw[5]!, ref: "c2" });
    const ids = ok(raw).filter((e) => e.kind === "criterion").map((e) => e.id);
    expect(ids[1]).toBe(`${ids[0]}~2`);
  });
});

describe("numbers and dates", () => {
  test("numbersIn normalizes $1k, commas, ordinals", () => {
    expect(numbersIn("$1k, $3,600 and 1st")).toEqual([1000, 3600, 1]);
    expect(moneyValue("$1k")).toBe(1000);
    expect(moneyValue("1,000 USD")).toBe(1000);
  });
  test("deadlineInQuote needs month, day and hour", () => {
    expect(deadlineInQuote("2026-10-25T09:00-07:00", "October 25th @ 9 AM PST")).toBe(true);
    expect(deadlineInQuote("2026-10-25T21:00-07:00", "Oct 25 at 9 PM")).toBe(true);
    expect(deadlineInQuote("2026-11-25T09:00-08:00", "October 25th @ 9 AM")).toBe(false);
  });
  test("figuresIn finds amounts and dates", () => {
    expect(figuresIn("Win $500 or 200 USD by October 25th, 10/26")).toEqual(["$500", "200 USD", "October 25th", "10/26"]);
    expect(figuresIn("1st place: $2000, 2nd: $1,000.")).toEqual(["$2000", "$1,000"]);
  });
});

describe("coverage (D15)", () => {
  test("a complete extraction passes, with the stated total", () => {
    expect(statedTotal(snap)!.usd).toBe(1100);
    const r = coverage(snap, ok(good()));
    expect(r.checks.map((c) => [c.name, c.pass])).toEqual([["prize_total", true], ["prize_blocks", true], ["figures", null]]);
    expect(r.pass).toBe(true);
  });

  test("a dropped winners line opens a gap and names the block", () => {
    const raw = good();
    raw[2]!.fields = raw[2]!.fields.filter((f) => f.field !== "winners");
    const r = coverage(snap, ok(raw));
    const total = r.checks.find((c) => c.name === "prize_total")!;
    expect(total.pass).toBe(false);
    expect(total.summary).toContain("gap $300");
    expect(total.details).toEqual(["[Acme] Best Use of Acme: page $300 × 2 = $600; extracted $300 × none = $300"]);
    expect(r.pass).toBe(false);
  });

  test("a prize block with no track fails prize_blocks", () => {
    const raw = good().filter((e) => e.ref !== "t1" && e.ref !== "p1");
    const c = coverage(snap, ok(raw)).checks.find((c) => c.name === "prize_blocks")!;
    expect(c.pass).toBe(false);
    expect(c.details).toEqual(["Mini Hacks Overall (prize_1): no track"]);
  });

  test("figures outside every quote are listed unattached", () => {
    const raw = good().filter((e) => e.ref !== "p3");
    const c = coverage(snap, ok(raw)).checks.find((c) => c.name === "figures")!;
    expect(c.details.some((d) => d.includes("$100") && d.includes("prize block prize_2"))).toBe(true);
    expect(c.details.some((d) => d.includes("$1,100"))).toBe(true); // the total line itself is no entity's quote
  });

  test("a page with no total or prize blocks: checks don't apply", () => {
    const plain = { ...snap, blocks: snap.blocks.filter((b) => !b.anchor?.startsWith("prize")) .filter((b) => !b.text.includes("in prizes")).map((b, i) => ({ ...b, i })) };
    const r = coverage(plain, []);
    expect(r.checks.slice(0, 2).map((c) => c.pass)).toEqual([null, null]);
    expect(r.pass).toBe(true);
  });
});

describe("checkJudge", () => {
  test("rejects unknown entity ids and blocks", () => {
    const es: Entity[] = ok(good());
    expect(checkJudge({ missing: [{ kind: "rule", block: 999, what: "x" }], misplaced: [{ entity_id: "nope", problem: "y" }] }, snap, es)).toEqual({
      error: "missing: block 999 doesn't exist; misplaced: nope is not an entity id",
    });
    expect(checkJudge({ missing: [], misplaced: [{ entity_id: es[0]!.id, problem: "y" }] }, snap, es)).toMatchObject({ misplaced: [{ entity_id: es[0]!.id }] });
  });
});

describe("redaction (D12)", () => {
  test("only an explicit public flag skips it", () => {
    expect(needsRedaction({ ...snap, access: "public" })).toBe(false);
    expect(needsRedaction({ ...snap, access: "authenticated" })).toBe(true);
    expect(needsRedaction({ ...snap, access: null })).toBe(true);
  });
  test("names, emails and phones are replaced, and counted", () => {
    const s = { ...snap, blocks: [{ i: 0, path: [], text: "Ask Dana Reyes at dana@acme.io or (415) 555-0100" }] };
    const r = redactSnapshot(s, (t) => ({ text: t.replace(/Dana Reyes/g, "[person]"), replaced: t.includes("Dana Reyes") ? 1 : 0 }));
    expect(r.snapshot.blocks[0]!.text).toBe("Ask [person] at [email] or [phone]");
    expect(r.replaced).toBe(3);
  });
  test("title, URL and link hrefs are scrubbed too; query and fragment dropped", () => {
    const s = { ...snap, url: "https://hive.example.com/u/Dana Reyes?token=abc#x", title: "Dana Reyes's schedule", links: [{ text: "Dana Reyes", href: "https://x.com/a?sig=1", block: 0 }] };
    const r = redactSnapshot(s, (t) => ({ text: t.replace(/Dana Reyes/g, "[person]"), replaced: 0 }));
    expect([r.snapshot.url, r.snapshot.title, r.snapshot.links[0]]).toEqual(["https://hive.example.com/u/[person]", "[person]'s schedule", { text: "[person]", href: "https://x.com/a", block: 0 }]);
  });
  test("names in hyphenated host labels and path segments, and malformed escapes, don't get through", () => {
    const red = (t: string) => ({ text: t.replace(/Dana Reyes/g, "[person]"), replaced: t.includes("Dana Reyes") ? 1 : 0 });
    const s = { ...snap, url: "https://dana-reyes.hive.io/p/dana_reyes/%E0%A4%A?token=abc", links: [] };
    expect(redactSnapshot(s, red).snapshot.url).toBe("https://[person].hive.io/p/[person]/%E0%A4%A");
    expect(redactSnapshot({ ...s, url: "https://dana:hunter2@hive.io/x" }, red).snapshot.url).toBe("https://hive.io/x");
  });
});

test("entityId leaves a track's heading as its leaf", () => {
  expect(entityId("track", snap, at("Mini Hacks Overall"), "Mini Hacks Overall")).toBe("track:https://mini.devpost.com#mini-hacks/prizes/mini-hacks-overall");
});

describe("rematch (D7)", () => {
  const es = () => ok(good());
  const prev = () => keyed(es(), snap);
  const rename = (e: Entity, id: string, quote?: string): Entity => ({ ...e, id, name: { ...e.name, source: { ...e.name.source, quote: quote ?? e.name.source.quote } } });

  test("same ids: nothing renamed, nothing gone", () => {
    expect(rematch(prev(), prev(), 0.8)).toEqual({ renamed: new Map(), gone: [] });
  });

  test("a moved entity with the same quote keeps its old id", () => {
    const next = es().map((e) => (e.kind === "criterion" ? rename(e, "criterion:moved") : e));
    const r = rematch(prev(), keyed(next, snap), 0.8);
    expect([...r.renamed]).toEqual([["criterion:moved", es().find((e) => e.kind === "criterion")!.id]]);
    expect(r.gone).toEqual([]);
  });

  test("a lightly edited quote matches above the threshold; a different one doesn't", () => {
    const c = es().find((e) => e.kind === "criterion")!;
    const light = rematch(prev(), keyed(es().map((e) => (e.id === c.id ? rename(e, "x", "Creativity!") : e)), snap), 0.8);
    expect(light.renamed.get("x")).toBe(c.id);
    const other = rematch(prev(), keyed(es().map((e) => (e.id === c.id ? rename(e, "x", "Technical depth") : e)), snap), 0.8);
    expect(other.renamed.size).toBe(0);
    expect(other.gone).toEqual([{ id: c.id, reason: "no match", best: expect.any(Number) }]);
  });

  test("two candidates above the threshold: listed as ambiguous, never guessed", () => {
    const c = es().find((e) => e.kind === "criterion")!;
    const next = [...es().filter((e) => e.id !== c.id), rename(c, "a"), rename(c, "b")];
    const r = rematch(prev(), keyed(next, snap), 0.8);
    expect(r.renamed.size).toBe(0);
    expect(r.gone).toEqual([{ id: c.id, reason: "ambiguous", best: 1 }]);
  });

  test("similarity ignores case, spacing and punctuation", () => {
    expect(similarity("Best  Use of Fetch.ai!", "best use of fetch ai")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
  });
});
