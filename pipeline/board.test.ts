import { describe, expect, test } from "bun:test";
import { boardData, excerpt, morningOf, plainText, replayFrames, type BoardOffer } from "./board.ts";
import type { Offer } from "./group.ts";
import type { Sponsors } from "./pool.ts";
import type { Message } from "./schema.ts";

const TZ = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso) / 1000;
const bo = (o: Partial<BoardOffer>): BoardOffer => ({
  id: "o1", sponsor: "Acme", title: "t", amount_text: "", usd: null, limit: null, limit_unclear: false, claim_url: "", promo_code: "", claim_how: "", first: 0, excerpt: "", posts: [], ...o,
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
  });

  test("quotes the post that states the code, from the sentence that has it", () => {
    const texts = [{ raw: "Welcome all.", plain: "Welcome all." }, { raw: "Hi there. Use code ABC at checkout.", plain: "Hi there. Use code ABC at checkout." }];
    expect(excerpt(texts, { promo_code: "ABC", amount_text: "", claim_url: "" })).toBe("…Use code ABC at checkout.");
    expect(excerpt([{ raw: "Yes all hackers get $50", plain: "Yes all hackers get $50" }], { promo_code: "", amount_text: "$50", claim_url: "" })).toBe("Yes all hackers get $50");
    expect(excerpt(texts, { promo_code: "", amount_text: "", claim_url: "" })).toBe("Welcome all.");
  });
});

describe("boardData", () => {
  const sponsors = { "spons-a": { sponsor: "Acme", kind: "sponsor", aliases: [] }, "0-ann": { sponsor: "event", kind: "event", aliases: [] } } as unknown as Sponsors;
  const msg = (ts: string, o: Partial<Message> = {}): Message => ({
    id: `C1:${ts}`, channel_id: "C1", channel_name: "spons-a", ts, author_name: "Grant Timmerman", text: "Grant Timmerman here: code ABC", links: [], permalink: `p/${ts}`, captured_at: "", run_id: "r", ...o,
  });
  const offer: Offer = { sponsor: "Acme", title: "API credits", amount_text: "", amount_usd_per_person: "", amount_basis: "unknown", limit_iso: "", limit_status: "unresolved", claim_url: "", promo_code: "ABC", claim_how: "", posts: ["C1:1792800000.0"], reason: "" };
  const d = boardData({
    event: "Cal Hacks 13.0", timezone: TZ, run_id: "r", channels: ["spons-a", "0-ann"],
    messages: [msg("1792800000.0"), msg("1792800100.0", { author_kind: "bot" }), msg("1792800200.0", { subtype: "thread_broadcast" })],
    sponsors, offers: [offer], role: () => "sponsor-side", basis: { grouping: "g", model: "m", written_at: "w" },
  });
  test("P counts real top-level posts only; unpriced stays null; demo mode redacts names in the excerpt", () => {
    expect(d.posts).toHaveLength(1);
    expect(d.offers[0]).toMatchObject({ usd: null, limit: null, limit_unclear: true, first: 1792800000 });
    expect(d.offers[0]!.excerpt).not.toContain("Grant");
    expect(d.reps).toEqual([{ sponsor: "Acme", channel: "spons-a", posts: 1, offers: 1, candidates: 1 }]);
  });
});
