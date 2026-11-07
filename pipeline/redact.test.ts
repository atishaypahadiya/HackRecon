import { describe, expect, test } from "bun:test";
import type { Sponsors } from "./pool.ts";
import { buildNameList, cleanName, compileRedactor } from "./redact.ts";
import { posterRole, rolesById } from "./roles.ts";
import type { Message } from "./schema.ts";

const sponsors: Sponsors = {
  "0-announcements": { sponsor: "event", kind: "event", aliases: [] },
  "spons-bright-data": { sponsor: "Bright Data", kind: "sponsor", aliases: ["BrightData"] },
  "spons-fetch-ai": { sponsor: "Fetch.ai", kind: "sponsor", aliases: ["Fetch", "Agentverse"] },
  "spons-microsoft": { sponsor: "Microsoft", kind: "sponsor", aliases: ["Azure"] },
  "spons-factory-ai": { sponsor: "Factory", kind: "sponsor", aliases: ["Factory AI"] },
};

// Poster names as rendered in the day-1 capture.
const posters = [
  "Dani Kaye, Bright Data",
  "Grant Timmerman",
  "Shiloah Vasquez (Microsoft)",
  "Rajashekar Vennavelli [Fetch AI]",
  "[CAL HACKS] Eric Cao",
  "Olivia (Ziqi) Wang",
  "Ali - Mana",
  "Victor H. [CAL HACKS]",
  "Francisco",
  "rishigolla.123",
];

describe("cleanName (OV2: strip tags and company suffixes before tokenizing)", () => {
  test.each([
    ["Dani Kaye, Bright Data", "Dani Kaye"],
    ["[CAL HACKS] Eric Cao", "Eric Cao"],
    ["Shiloah Vasquez (Microsoft)", "Shiloah Vasquez"],
    ["Olivia (Ziqi) Wang", "Olivia Wang"],
    ["Ali - Mana", "Ali"],
    ["Victor H. [CAL HACKS]", "Victor H."],
  ])("%s → %s", (raw, clean) => expect(cleanName(raw)).toBe(clean));
});

describe("redact", () => {
  const redact = compileRedactor(buildNameList(posters, sponsors));

  test("sponsor names, aliases and stopwords survive although posters carry them (measured collisions)", () => {
    const t = "Bright Data gives $50 in credits; grant access via Fetch.ai Agentverse. Microsoft Azure data, Factory droids. Meet in San Francisco.";
    expect(redact(t)).toEqual({ text: t, replaced: 0 });
  });

  test("full names case-insensitively; single tokens only when capitalized", () => {
    expect(redact("Thanks Grant Timmerman and dani kaye! Ask Vasquez or vasquez.").text).toBe(
      "Thanks [person] and [person]! Ask [person] or vasquez.",
    );
  });

  test("mentions become @person; @channel, @here and email addresses stay", () => {
    expect(redact("@channel ping @Dani Kaye, Bright Data or @Eric Cao or @someone.else, mail dev@fetch.ai").text).toBe(
      "@channel ping @person or @person or @person, mail dev@fetch.ai",
    );
    expect(redact("<@U0C7W75V6DQ> hi @here").text).toBe("@person hi @here");
  });

  test("counts every replacement", () => {
    expect(redact("@Eric Cao and Shiloah Vasquez and Rajashekar").replaced).toBe(3);
  });
});

describe("posterRole (D17, A5 rules)", () => {
  const m = (author_name: string, extra: Partial<Message> = {}): Message => ({
    id: "C1:1792800000.000001",
    channel_id: "C1",
    channel_name: "spons-bright-data",
    ts: "1792800000.000001",
    author_name,
    author_id: "U1",
    text: "",
    links: [],
    permalink: "",
    captured_at: "",
    run_id: "r",
    ...extra,
  });
  const orgs = new Set(["UORG"]);
  const all = Object.values(sponsors);
  const bd = sponsors["spons-bright-data"];

  test("organizer by id, tag or title, ahead of any sponsor match", () => {
    expect(posterRole(m("Jessenia Chan", { author_id: "UORG" }), bd, orgs)).toBe("organizer");
    expect(posterRole(m("Charlie [Cal Hacks]"), bd, orgs)).toBe("organizer");
    expect(posterRole(m("Sam", { author_title: "Logistics Director" }), bd, orgs)).toBe("organizer");
  });

  test("sponsor-side by tag, suffix or external badge in the sponsor's channel", () => {
    expect(posterRole(m("Jeevi [Bright Data]"), bd, orgs)).toBe("sponsor-side");
    expect(posterRole(m("Dani Kaye, Bright Data"), bd, orgs)).toBe("sponsor-side");
    expect(posterRole(m("sahana", { author_external: true }), bd, orgs)).toBe("sponsor-side");
    expect(posterRole(m("Jeevi [Bright Data]"), sponsors["spons-microsoft"], orgs)).toBe("other");
  });

  test("event channels match any configured sponsor; hackers stay other", () => {
    const ev = sponsors["0-announcements"];
    expect(posterRole(m("Shiloah Vasquez (Microsoft)", { channel_name: "2-opportunities" }), ev, orgs, all)).toBe("sponsor-side");
    expect(posterRole(m("prabhavgoel"), bd, orgs, all)).toBe("other");
  });
});

describe("rolesById (user 2026-11-06: reps and organizers keyed by Slack user ID only)", () => {
  const sponsors = {
    "cohost-annapurna-labs": { sponsor: "Annapurna Labs", kind: "cohost", aliases: ["AWS"] },
    "spons-microsoft": { sponsor: "Microsoft", kind: "sponsor", aliases: [] },
    "0-announcements": { sponsor: "event", kind: "event", aliases: [] },
  } as unknown as Record<string, import("./pool.ts").SponsorEntry>;
  const at = (channel_name: string, author_name: string, extra: Partial<Message> = {}): Message => ({
    id: `C1:${extra.ts ?? "1792800000.000001"}`, channel_id: "C1", channel_name, ts: "1792800000.000001", author_name, text: "", links: [], permalink: "", captured_at: "", run_id: "r", ...extra,
  });
  test("a rep who renames mid-event keeps the role, in that sponsor's channels and event channels only", () => {
    const before = at("cohost-annapurna-labs", "LaurenElize (Annapurna Labs)", { author_id: "U1" });
    const after = at("cohost-annapurna-labs", "LaurenElize", { author_id: "U1" });
    const role = rolesById([before, after], sponsors, new Set());
    expect([role(before), role(after)]).toEqual(["sponsor-side", "sponsor-side"]);
    expect(role(at("0-announcements", "LaurenElize", { author_id: "U1" }))).toBe("sponsor-side");
    expect(role(at("spons-microsoft", "LaurenElize", { author_id: "U1" }))).toBe("other");
  });
  test("an organizer tag seen once marks every post by that id; no id, no role, whatever the name says", () => {
    const tagged = at("spons-microsoft", "Charlie [Cal Hacks]", { author_id: "U2" });
    const plain = at("spons-microsoft", "Charlie", { author_id: "U2" });
    const role = rolesById([tagged, plain], sponsors, new Set(["U3"]));
    expect([role(tagged), role(plain), role(at("spons-microsoft", "anyone", { author_id: "U3" }))]).toEqual(["organizer", "organizer", "organizer"]);
    expect(role(at("cohost-annapurna-labs", "Someone (Annapurna Labs)"))).toBe("other");
  });
});
