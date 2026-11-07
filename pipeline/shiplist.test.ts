import { describe, expect, test } from "bun:test";
import type { EventConfig } from "./classify.ts";
import type { Entity, Message } from "./schema.ts";
import { currentSchedule, durationText, shipList, timePattern } from "./shiplist.ts";

const TZ = "America/Los_Angeles";
const sec = (iso: string) => Date.parse(iso) / 1000;
const link = (ts: string) => `https://x.slack.com/archives/CA/p${ts.replace(".", "")}`;
const post = (ts: string, text: string, author_id = "UORG", extra: Partial<Message> = {}): Message => ({ id: `CA:${ts}`, channel_id: "CA", channel_name: "0-announcements", ts, author_id, author_name: "o", text, links: [], permalink: link(ts), captured_at: "", run_id: "r", ...extra });
const src = (quote: string) => ({ kind: "page", url: "https://e.devpost.com/", quote, captured_at: "", snapshot_hash: "", block: 1 }) as unknown as Entity["name"]["source"];
const f = (value: unknown, quote = String(value)) => ({ value, source: src(quote) });
const rule = (id: string, kind: string, text: string, deadline?: string): Entity => ({ id, kind: "rule", sponsor: "event", name: f(text), fields: { text: f(text), rule_kind: f(kind), ...(deadline ? { deadline: f(deadline, text) } : {}) }, history: [], origin: "page" }) as unknown as Entity;

// Cal Hacks' shape: the judging post at 01:50 (9:00 deadline), the extension at 08:59 (9:30), the drafts post at 09:26.
const t = { judging: "1792918203.114859", ext: "1792943981.782739", drafts: "1792945574.409879" };
const messages = [
  post(t.judging, "Final submissions are due at 9:00am on our Devpost. Please arrive with your whole team by 9:30am. Be ready at your table by the start of judging at 10:30am.\nYou must be present for the whole judging window, from 10:30am–12:30pm."),
  post(t.ext, "@channel We’ve extended the Devpost submission deadline to 9:30 AM. Make sure to fully save and submit your project at the end! Drafts / Incomplete Submissions will not be considered for judging. There are currently 132 draft submissions."),
  post(t.drafts, "@channel There are still 113 draft submissions as of now! Please make sure you fully click through to Submit by 9:30 AM."),
  post("1792945600.000000", "My draft won't submit, help?", "UHACK"), // a hacker's post
];
const event = {
  event: "e",
  timezone: TZ,
  schedule: [
    { what: "Final Devpost submissions due", at: "2026-10-25T09:00:00-07:00", source: link(t.judging), superseded_by: "Devpost submission deadline extended" },
    { what: "Devpost submission deadline extended", at: "2026-10-25T09:30:00-07:00", source: link(t.ext) },
    { what: "Arrive with the whole team", at: "2026-10-25T09:30:00-07:00", source: link(t.judging) },
    { what: "Judging window", at: "2026-10-25T10:30:00-07:00", until: "2026-10-25T12:30:00-07:00", source: link(t.judging) },
  ],
} as unknown as EventConfig;
const entities = [
  rule("r:submit", "submission", "You must submit your hack by October 25th @ 9 AM PST. This is a hard deadline.", "2026-10-25T09:00-07:00"),
  rule("r:image", "submission", "Include an image of your project and GitHub repository."),
  rule("r:pitch", "conduct", "You will have three minutes to pitch and two minutes for judges to ask questions."),
  rule("r:age", "eligibility", "Ages 18+ only"),
  { id: "t:1", kind: "track", sponsor: "Apify", name: f("Best Use of Apify"), fields: { "requirements[0]": f("Use at least one Actor from the Apify Store."), "requirements[1]": f("Publish your Actor.") }, history: [], origin: "page" } as unknown as Entity,
  { id: "s:1", kind: "entry_step", sponsor: "Apify", name: f("Publish your Actor"), fields: { track_id: f("t:1", ""), step_kind: f("submission_field"), text: f("Publish your Actor.") }, history: [], origin: "page" } as unknown as Entity,
];
const at = (iso: string, entered: string[] = []) => shipList({ entities, event, messages, isOrganizer: (m) => m.author_id === "UORG", shown: (m) => m.text, entered, nowSec: sec(iso) });

describe("Ship's deadline: the page, moved by a post once it's posted", () => {
  test("before the extension: the page's 9:00, the page as source (the post agreeing changes nothing)", () => {
    const d = at("2026-10-25T08:01:00-07:00").deadline!;
    expect([d.at, d.from, d.was]).toEqual(["2026-10-25T09:00-07:00", "page", undefined]);
  });
  test("after it: 9:30 from the post, quoted, with what Devpost said", () => {
    const d = at("2026-10-25T09:05:00-07:00").deadline!;
    expect(d).toMatchObject({ at: "2026-10-25T09:30:00-07:00", from: "slack", quote: "We’ve extended the Devpost submission deadline to 9:30 AM.", channel: "0-announcements", was: { at: "2026-10-25T09:00-07:00" } });
  });
  test("merge's authority (D8): a post by someone who isn't an organizer never moves it", () => {
    const d = shipList({ entities, event, messages, isOrganizer: () => false, shown: (m) => m.text, entered: [], nowSec: sec("2026-10-25T09:05:00-07:00") }).deadline!;
    expect([d.at, d.from, d.was]).toEqual(["2026-10-25T09:00-07:00", "page", undefined]);
  });
  test("merge rule 4: the page edited in a window holding the post: no winner, and the line says so", () => {
    const sub = entities.find((x) => x.fields.rule_kind?.value === "submission" && x.fields.deadline)!;
    const window = { after: "2026-10-25T08:50:00-07:00", until: "2026-10-25T09:02:00-07:00" };
    const pageChanges = [{ entity_id: sub.id, field: "deadline", kind: "set" as const, to: { value: "2026-10-25T10:00:00-07:00", source: { kind: "page" as const, url: "https://e.devpost.com/", quote: "10 AM", captured_at: window.until } }, window }];
    const d = shipList({ entities, event, messages, isOrganizer: (m) => m.author_id === "UORG", shown: (m) => m.text, entered: [], nowSec: sec("2026-10-25T09:05:00-07:00"), pageChanges }).deadline!;
    expect([d.at, d.from, d.disagree]).toEqual(["2026-10-25T09:00-07:00", "page", `Page and Slack disagree; page changed between ${window.after} and ${window.until}`]);
  });
  test("a schedule entry counts from its post's time; a superseded one until its replacement is posted", () => {
    expect(currentSchedule(event, sec("2026-10-24T12:00:00-07:00")).map((x) => x.what)).toEqual([]);
    expect(currentSchedule(event, sec("2026-10-25T08:00:00-07:00")).map((x) => x.what)).toEqual(["Final Devpost submissions due", "Arrive with the whole team", "Judging window"]);
    expect(currentSchedule(event, sec("2026-10-25T09:00:00-07:00")).map((x) => x.what)).toEqual(["Devpost submission deadline extended", "Arrive with the whole team", "Judging window"]);
  });
});

describe("Required to submit", () => {
  test("the drafts item: standing, then the latest organizer post about drafts, quoted; then the submission rules", () => {
    const r = (iso: string) => at(iso).required;
    expect(r("2026-10-25T08:00:00-07:00")[0]).toMatchObject({ id: "ship:submit", from: "standing", source_url: "" });
    expect(r("2026-10-25T09:05:00-07:00")[0]).toMatchObject({ from: "slack", quote: "Make sure to fully save and submit your project at the end! Drafts / Incomplete Submissions will not be considered for judging." });
    expect(r("2026-10-25T09:27:00-07:00")[0]).toMatchObject({ from: "slack", quote: "There are still 113 draft submissions as of now! Please make sure you fully click through to Submit by 9:30 AM.", source_url: link(t.drafts) });
    expect(r("2026-10-25T09:27:00-07:00").slice(1).map((x) => x.id)).toEqual(["r:submit", "r:image"]);
  });
});

describe("For the tracks you entered", () => {
  test("entry steps with Plan's ids, then requirements not already a step; nothing for tracks not entered", () => {
    expect(at("2026-10-25T08:00:00-07:00").tracks).toEqual([]);
    const tr = at("2026-10-25T08:00:00-07:00", ["t:1", "t:missing"]).tracks;
    expect(tr.map((x) => x.name)).toEqual(["Best Use of Apify"]);
    expect(tr[0]!.items.map((x) => [x.id, x.label])).toEqual([
      ["s:1", "Publish your Actor"],
      ["t:1:req:0", "Use at least one Actor from the Apify Store."],
    ]);
  });
  test("the chooser offers every track on the pages, whatever is entered; nothing is pre-ticked", () => {
    expect(at("2026-10-25T08:00:00-07:00").choices).toEqual([{ track_id: "t:1", name: "Best Use of Apify" }]);
    expect(at("2026-10-25T08:00:00-07:00", ["t:1"]).choices).toEqual(at("2026-10-25T08:00:00-07:00").choices);
  });
});

describe("Judging", () => {
  test("schedule entries from the deadline on, each quoted by the sentence naming its time (and end), then pitch rules", () => {
    const j = at("2026-10-25T08:00:00-07:00").judging;
    expect(j.map((x) => x.label)).toEqual([
      "Please arrive with your whole team by 9:30am.",
      "You must be present for the whole judging window, from 10:30am–12:30pm.",
      "You will have three minutes to pitch and two minutes for judges to ask questions.",
    ]);
    expect(j[0]).toMatchObject({ from: "slack", channel: "0-announcements" });
    expect(at("2026-10-24T12:00:00-07:00").judging.map((x) => x.id)).toEqual(["r:pitch"]); // nothing posted yet
  });
  test("ids don't move when an entry appears or goes", () => {
    const ids = (iso: string) => at(iso).judging.map((x) => x.id);
    expect(ids("2026-10-25T09:05:00-07:00")).toEqual(ids("2026-10-25T08:00:00-07:00"));
  });
});

describe("clock text", () => {
  test("times as posts write them, in the event's zone", () => {
    const p = timePattern("2026-10-25T09:30:00-07:00", TZ);
    expect(["by 9:30am", "to 9:30 AM", "at 9:30."].every((x) => p.test(x))).toBe(true);
    expect(["19:30", "9:305"].some((x) => p.test(x))).toBe(false);
    const nine = timePattern("2026-10-25T09:00:00-07:00", TZ);
    expect(["by 9am", "@ 9 AM PST", "9:00am"].every((x) => nine.test(x))).toBe(true);
    expect(nine.test("19 am")).toBe(false);
  });
  test("countdown rounds down", () => {
    expect([durationText(61 * 60_000), durationText(59 * 60_000 + 59_000), durationText(30_000), durationText(26 * 3_600_000)]).toEqual(["1 h 1 min", "59 min", "under a minute", "1 d 2 h"]);
  });
});
