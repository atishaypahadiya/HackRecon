import { describe, expect, test } from "bun:test";
import { boardData, eventDeadlines, excerpt, morningOf, permalinkTs, plainText, offerIds, replayFrames, v1Ids, type BoardOffer } from "./board.ts";
import type { Offer } from "./group.ts";
import type { Sponsors } from "./pool.ts";
import { repEvidence, repIndex } from "./reps.ts";
import type { Message } from "./schema.ts";

const TZ = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso) / 1000;
const bo = (o: Partial<BoardOffer>): BoardOffer => ({
  id: "o1", sponsor: "Acme", title: "t", value_short: "", claim_short: "", amount_text: "", usd: null, limit: null, limit_unclear: false, claim_url: "", promo_code: "", claim_how: "", first: 0, excerpt: "", posts: [], ...o,
});

describe("replay frames", () => {
  test("08:00 local on the post's day", () => {
    expect(morningOf(at("2026-10-23T15:12:09-07:00"), TZ)).toBe(at("2026-10-23T08:00:00-07:00"));
    expect(morningOf(at("2026-10-23T15:12:09.5-07:00"), TZ)).toBe(at("2026-10-23T08:00:00-07:00"));
  });

  test("mornings from the morning after the oldest post to the morning after the newest, plus offer frames inside that range only", () => {
    const posts = [at("2026-10-20T10:00:00-07:00"), at("2026-10-22T07:00:00-07:00")];
    const f = replayFrames(posts, [bo({ first: at("2026-10-21T14:00:00-07:00"), limit: at("2026-10-21T19:00:00-07:00") }), bo({ first: at("2026-10-21T15:00:00-07:00"), limit: at("2026-10-30T15:00:00-07:00") })], TZ);
    expect(f).toEqual(["2026-10-21T08:00:00-07:00", "2026-10-21T14:00:00-07:00", "2026-10-21T15:00:00-07:00", "2026-10-21T19:00:00-07:00", "2026-10-22T08:00:00-07:00"].map(at));
  });
});

describe("excerpts", () => {
  test("plain text keeps link labels, drops the capture's hrefs and emoji codes, shortens bare URLs", () => {
    expect(plainText("Claim here <https://a.dev/x> now :tada: or see https://docs.b.dev/y/z")).toBe("Claim here now or see docs.b.dev");
    expect(plainText("form <https://f.dev/x|the form> !")).toBe("form the form!");
    expect(plainText("Line one :wave:\n\n  Line two")).toBe("Line one\nLine two");
  });

  test("quotes the post that states the code, from the sentence that has it", () => {
    const texts = [{ raw: "Welcome all.", plain: "Welcome all." }, { raw: "Hi there. Use code ABC at checkout.", plain: "Hi there. Use code ABC at checkout." }];
    expect(excerpt(texts, { promo_code: "ABC", amount_text: "", claim_url: "" })).toBe("Use code ABC at checkout.");
    const long = "Hi. Head over to the portal and after a very long winding sentence enter ABC there. More after.";
    expect(excerpt([{ raw: long, plain: long }], { promo_code: "ABC", amount_text: "", claim_url: "" }, 30)).toBe("Head over to the portal and…");
    expect(excerpt([{ raw: "x", plain: "Intro line\nUse ABC now" }], { promo_code: "ABC", amount_text: "", claim_url: "" })).toBe("Use ABC now");
    expect(excerpt([{ raw: "x", plain: "Hi. Then head to billing\nand enter ABC." }], { promo_code: "ABC", amount_text: "", claim_url: "" })).toBe("Then head to billing and enter ABC.");
    expect(excerpt([{ raw: "Yes all hackers get $50", plain: "Yes all hackers get $50" }], { promo_code: "", amount_text: "$50", claim_url: "" })).toBe("Yes all hackers get $50");
    expect(excerpt(texts, { promo_code: "", amount_text: "", claim_url: "" })).toBe("Welcome all.");
  });
});

describe("event deadlines", () => {
  test("superseded entries drop out; each shows from its announcement post's time", () => {
    expect(permalinkTs("https://x.slack.com/archives/C1/p1792943981782739")).toBe(1792943981.782739);
    const s = [
      { what: "Submissions due", at: "2026-10-25T09:00:00-07:00", source: "https://x/archives/C1/p1792918203114859", superseded_by: "extended" },
      { what: "Extended deadline", at: "2026-10-25T09:30:00-07:00", source: "https://x/archives/C1/p1792943981782739" },
      { what: "Judging", at: "2026-10-25T10:30:00-07:00", until: "2026-10-25T12:30:00-07:00", source: "https://x/archives/C1/p1792918203114859" },
    ];
    expect(eventDeadlines(s)).toEqual([
      { what: "Extended deadline", at: at("2026-10-25T09:30:00-07:00"), until: null, posted: 1792943981.782739, source: s[1]!.source },
      { what: "Judging", at: at("2026-10-25T10:30:00-07:00"), until: at("2026-10-25T12:30:00-07:00"), posted: 1792918203.114859, source: s[2]!.source },
    ]);
  });
});

describe("boardData", () => {
  const sponsors = { "spons-a": { sponsor: "Acme", kind: "sponsor", aliases: [] }, "0-ann": { sponsor: "event", kind: "event", aliases: [] } } as unknown as Sponsors;
  const msg = (ts: string, o: Partial<Message> = {}): Message => ({
    id: `C1:${ts}`, channel_id: "C1", channel_name: "spons-a", ts, author_name: "Grant Tanner", author_id: "UGRANT", text: "Grant Tanner here: code ABC", links: [], permalink: `p/${ts}`, captured_at: "", run_id: "r", ...o,
  });
  const offer: Offer = { sponsor: "Acme", title: "API credits", amount_text: "", amount_usd_per_person: "", amount_basis: "unknown", limit_iso: "", limit_status: "unresolved", claim_url: "", promo_code: "ABC", claim_how: "", value_short: "API credits", claim_short: "", posts: ["C1:1792800000.0"], reason: "" };
  const d = boardData({
    event: "Cal Hacks 13.0", timezone: TZ, run_id: "r", channels: ["spons-a", "0-ann"],
    messages: [msg("1792800000.0"), msg("1792800100.0", { author_kind: "bot" }), msg("1792800200.0", { subtype: "thread_broadcast" })],
    sponsors, offers: [offer], role: () => "sponsor-side", basis: { grouping: "g", model: "m", written_at: "w" },
  });
  test("P counts real top-level posts only; unpriced stays null; demo mode redacts names in the excerpt", () => {
    expect(d.posts).toHaveLength(1);
    expect(d.offers[0]).toMatchObject({ usd: null, limit: null, limit_unclear: true, first: 1792800000 });
    expect(d.offers[0]!.excerpt).not.toContain("Grant");
    expect(d.reps).toEqual([{ sponsor: "Acme", channel: "spons-a", posts: 1, offers: 1, candidates: 1, candidate_first: [1792800000] }]);
    expect(d.event_deadlines).toEqual([]);
  });
});

describe("offer ids (OV5)", () => {
  test("first-post ids, ~n for a second offer from the same post", () => {
    expect(offerIds([{ channel: "spons-acme", ts: "1792446957.154859" }, { channel: "spons-acme", ts: "1792446957.154859" }, { channel: "b", ts: "1.000001" }])).toEqual([
      "o-spons-acme-1792446957154859",
      "o-spons-acme-1792446957154859~2",
      "o-b-1000001",
    ]);
  });
  const post = (channel: string, ts: number) => ({ ts, channel, permalink: "" });
  const now = [bo({ id: "o-a-2", posts: [post("a", 2), post("a", 3)] }), bo({ id: "o-b-1", posts: [post("b", 1)] })];
  test("v1 positional ids map by first post; unmatched v1 offers are left out", () => {
    const v1 = { offers: [bo({ id: "o1", posts: [post("b", 1)] }), bo({ id: "o2", posts: [post("a", 3), post("a", 2)] }), bo({ id: "o3", posts: [post("c", 9)] })] };
    expect(v1Ids(v1, now)).toEqual({ o1: "o-b-1", o2: "o-a-2" });
  });
  test("an existing map is carried forward, dropping ids no longer on the board", () => {
    expect(v1Ids({ offers: now, v1_ids: { o1: "o-b-1", o9: "o-gone-5" } }, now)).toEqual({ o1: "o-b-1" });
    expect(v1Ids(null, now)).toEqual({});
  });
});

describe("rep signals on the board", () => {
  test("2b is a time with no phrase; likely staff carries it and the hacker-channel count", () => {
    const sp = { "spons-apify": { sponsor: "Apify", kind: "sponsor", aliases: [] } } as unknown as Sponsors;
    const m = (ts: string, author_id: string, author_name: string): Message => ({ id: `C:${ts}`, channel_id: "C", channel_name: "spons-apify", ts, author_id, author_name, text: "hi", links: [], permalink: `p/${ts}`, captured_at: "", run_id: "r" });
    const messages = [m("100", "UA", "Ana [Apify]"), m("200", "UP", "Pat")];
    const ev = repEvidence({
      email: [],
      mention: [],
      selfId: [
        { person: "UA", accounts: ["UA"], sponsor: "Apify", posts: [{ ts: 150, permalink: "p/150", phrase: "I'm Ana with Apify" }] },
        { person: "UP", accounts: ["UP"], sponsor: "Apify", posts: [{ ts: 300, permalink: "p/300", phrase: "I'm Pat with Apify" }] },
      ],
      likely: [{ person: "UP", accounts: ["UP"], sponsor: "Apify", posts: [{ ts: 200, permalink: "p/200" }], answers: [{ ts: 250, permalink: "p/250" }] }],
      hacker: new Map([["UP", [{ channel: "1-introductions", posts: 2 }]]]),
      person: (id) => id,
    });
    const reps = repIndex({ built_at: "", sources: { emails: "", mentions: "", replies: "", hacker_only: "" }, hacker_only_channels: [], rule_notes: [], reps: ev });
    const d = boardData({ event: "e", timezone: TZ, run_id: "r", channels: ["spons-apify"], messages, sponsors: sp, offers: [], role: (x) => (x.author_id === "UA" ? "sponsor-side" : "other"), reps, basis: { grouping: "", model: "", written_at: "" } });
    expect(d.rep_signals["spons-apify"]).toEqual([["name or title"]]);
    expect(d.rep_self["spons-apify"]).toEqual([150]);
    // Pat passes the hacker-channel rule only from his self-identification at 300.
    expect(d.rep_likely["spons-apify"]).toEqual([{ first: 300, posts: [200], answers: [250], staff: 300, self: 300, hacker: 2 }]);
    expect(JSON.stringify(d)).not.toContain("with Apify");
  });
});
