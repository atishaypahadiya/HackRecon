import { describe, expect, test } from "bun:test";
import { baseline, capturedAt, disagreement, merge, pageChanges, type PageChange } from "./merge.ts";
import type { Change, Entity, FieldValue } from "./schema.ts";

const page = (value: unknown, captured_at: string, quote = String(value)): FieldValue<unknown> => ({ value, source: { kind: "page", url: "https://e.devpost.com/", quote, captured_at } });
const slack = (value: unknown, posted_at: string, quote = String(value)): FieldValue<unknown> => ({ value, source: { kind: "slack", url: `https://x.slack.com/archives/C/p${Date.parse(posted_at)}`, quote, captured_at: posted_at, posted_at } });
const rule = (deadline: string, at = "2026-10-24T10:00:00-07:00", id = "r:1"): Entity =>
  ({ id, kind: "rule", sponsor: "event", name: page("Submission", at), fields: { deadline: page(deadline, at), rule_kind: page("submission", at) }, history: [], origin: "page" }) as Entity;
const set = (to: FieldValue<unknown>, field = "deadline", entity_id = "r:1"): Change => ({ entity_id, field, to, kind: "set" });
const organizer = new Set(["https://x.slack.com/archives/C/p" + Date.parse("2026-10-25T08:59:00-07:00")]);
const authorized = (c: Change) => c.to.source.kind !== "slack" || organizer.has(c.to.source.url);

const NINE = "2026-10-25T09:00:00-07:00", NINE30 = "2026-10-25T09:30:00-07:00";

describe("rule 1 and 3: the page is the baseline; an authorized Slack change wins at its post's time", () => {
  test("Cal Hacks: the 9:00 page deadline, moved to 9:30 by the organizer's 8:59 post; the baseline stays readable", () => {
    const [e] = merge([rule(NINE)], { slack: [set(slack(NINE30, "2026-10-25T08:59:00-07:00"))], authorized });
    expect(e!.fields.deadline!.value).toBe(NINE30);
    expect(e!.history.map((h) => [h.status, h.from.value, h.to.value])).toEqual([["applied", NINE, NINE30]]);
    expect(baseline(e!, "deadline")?.value).toBe(NINE);
    expect(baseline(e!, "rule_kind")).toBeNull();
  });
  test("an unauthorized post is kept in history, never as the value; a question never sets one", () => {
    const [e] = merge([rule(NINE)], { slack: [set(slack(NINE30, "2026-10-25T08:00:00-07:00")), { ...set(slack(NINE30, "2026-10-25T08:30:00-07:00")), kind: "question" }], authorized: () => false });
    expect(e!.fields.deadline!.value).toBe(NINE);
    expect(e!.history.map((h) => h.status)).toEqual(["unauthorized", "question"]);
  });
  test("an entity with no changes is returned as it was", () => {
    const r = rule(NINE);
    expect(merge([r], { authorized })[0]).toBe(r);
  });
});

describe("rule 2: a later snapshot's field change is placed in its window", () => {
  const v1 = { entities: [rule(NINE, "2026-10-24T10:00:00-07:00")] };
  const v2 = { entities: [rule("2026-10-25T08:30:00-07:00", "2026-10-25T06:00:00-07:00")] };
  test("the diff names the field, the new value and the window between the two captures; a new entity is no change", () => {
    const ch = pageChanges(v1, { entities: [...v2.entities, rule(NINE, "2026-10-25T06:00:00-07:00", "r:new")] });
    expect(ch.map((c) => [c.entity_id, c.field, c.to.value, c.window])).toEqual([["r:1", "deadline", "2026-10-25T08:30:00-07:00", { after: capturedAt(v1), until: capturedAt(v2) }]]);
  });
  test("a field the page drops becomes null", () => {
    const gone = { entities: [{ ...v2.entities[0]!, fields: { rule_kind: v2.entities[0]!.fields.rule_kind! } }] };
    expect(pageChanges(v1, gone).map((c) => [c.field, c.to.value])).toEqual([["deadline", null]]);
  });
});

describe("rule 4: one timeline, the latest wins; a Slack change inside a page change's window is ambiguous", () => {
  const window = { after: "2026-10-24T10:00:00-07:00", until: "2026-10-25T06:00:00-07:00" };
  const pc = (value: string): PageChange => ({ ...set(page(value, window.until)), window });
  test("a page change after an earlier Slack change wins", () => {
    const [e] = merge([rule(NINE)], { page: [pc("2026-10-25T10:00:00-07:00")], slack: [set(slack(NINE30, "2026-10-24T09:00:00-07:00"))], authorized: () => true });
    expect(e!.fields.deadline!.value).toBe("2026-10-25T10:00:00-07:00");
    expect(e!.history.map((h) => h.status)).toEqual(["applied", "applied"]);
  });
  test("Slack posted inside the window: both ambiguous, neither wins, and the line names the window", () => {
    const [e] = merge([rule(NINE)], { page: [pc("2026-10-25T10:00:00-07:00")], slack: [set(slack(NINE30, "2026-10-24T20:00:00-07:00"))], authorized: () => true });
    expect(e!.fields.deadline!.value).toBe(NINE);
    expect(e!.history.map((h) => h.status)).toEqual(["ambiguous", "ambiguous"]);
    expect(disagreement(e!, "deadline")).toBe(`Page and Slack disagree; page changed between ${window.after} and ${window.until}`);
    expect(disagreement(e!, "rule_kind")).toBeNull();
  });
  test("an unauthorized post in the window makes nothing ambiguous", () => {
    const [e] = merge([rule(NINE)], { page: [pc("2026-10-25T10:00:00-07:00")], slack: [set(slack(NINE30, "2026-10-24T20:00:00-07:00"))], authorized });
    expect(e!.fields.deadline!.value).toBe("2026-10-25T10:00:00-07:00");
    expect(e!.history.map((h) => h.status)).toEqual(["unauthorized", "applied"]);
  });
});

describe("rule 5: a Slack change a later snapshot repeats collapses into the page", () => {
  test("one applied entry, from the page, keeping the original baseline", () => {
    const window = { after: "2026-10-25T09:00:00-07:00", until: "2026-10-25T09:10:00-07:00" };
    const [e] = merge([rule(NINE)], { page: [{ ...set(page(NINE30, window.until)), window }], slack: [set(slack(NINE30, "2026-10-25T08:59:00-07:00"))], authorized });
    expect(e!.history.map((h) => [h.status, h.to.source.kind, h.from.value])).toEqual([["applied", "page", NINE]]);
    expect(e!.fields.deadline!.value).toBe(NINE30);
  });
});
