import { describe, expect, test } from "bun:test";
import type { Sponsors } from "./pool.ts";
import { buildNameList, cleanName, compileRedactor } from "./redact.ts";
import { organizerTag, posterRole, rolesById } from "./roles.ts";
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
  "Dana Kim, Bright Data",
  "Grant Tanner",
  "Sam Vega (Microsoft)",
  "Ravi Varma [Fetch AI]",
  "[CAL HACKS] Evan Cole",
  "Olive (Zoe) Wren",
  "Amir - Mana",
  "Victor H. [CAL HACKS]",
  "Francisco",
  "devuser.123",
];

describe("cleanName (OV2: strip tags and company suffixes before tokenizing)", () => {
  test.each([
    ["Dana Kim, Bright Data", "Dana Kim"],
    ["[CAL HACKS] Evan Cole", "Evan Cole"],
    ["Sam Vega (Microsoft)", "Sam Vega"],
    ["Olive (Zoe) Wren", "Olive Wren"],
    ["Amir - Mana", "Amir"],
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
    expect(redact("Thanks Grant Tanner and dana kim! Ask Vega or vega.").text).toBe(
      "Thanks [person] and [person]! Ask [person] or vega.",
    );
  });

  test("mentions become @person; @channel, @here and email addresses stay", () => {
    expect(redact("@channel ping @Dana Kim, Bright Data or @Evan Cole or @someone.else, mail dev@fetch.ai").text).toBe(
      "@channel ping @person or @person or @person, mail dev@fetch.ai",
    );
    expect(redact("<@U0ZC7F5B60C> hi @here").text).toBe("@person hi @here");
  });

  test("counts every replacement", () => {
    expect(redact("@Evan Cole and Sam Vega and Ravi").replaced).toBe(3);
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
  const tag = organizerTag("Cal Hacks 13.0");
  const all = Object.values(sponsors);
  const bd = sponsors["spons-bright-data"];

  test("organizer by id, tag or title, ahead of any sponsor match", () => {
    expect(posterRole(m("Nora Quill", { author_id: "UORG" }), bd, orgs, tag)).toBe("organizer");
    expect(posterRole(m("Charlie [Cal Hacks]"), bd, orgs, tag)).toBe("organizer");
    expect(posterRole(m("Sam", { author_title: "Logistics Director" }), bd, orgs, tag)).toBe("organizer");
  });

  test("the tag is this event's name, never another event's (audit 2026-11-08)", () => {
    const iterate = organizerTag("Iterate: AI Research Hackathon (Nov 14–15, 2026, San Francisco)");
    expect(iterate?.source).toBe("\\bIterate\\b");
    expect(posterRole(m("Dana (Iterate)"), bd, orgs, iterate)).toBe("organizer");
    expect(posterRole(m("Charlie [Cal Hacks]"), bd, orgs, iterate)).toBe("other");
    expect(posterRole(m("Charlie [Cal Hacks]"), bd, orgs, null)).toBe("other");
  });

  test("sponsor-side by tag, suffix or external badge in the sponsor's channel", () => {
    expect(posterRole(m("Jeevi [Bright Data]"), bd, orgs, tag)).toBe("sponsor-side");
    expect(posterRole(m("Dana Kim, Bright Data"), bd, orgs, tag)).toBe("sponsor-side");
    expect(posterRole(m("sara", { author_external: true }), bd, orgs, tag)).toBe("sponsor-side");
    expect(posterRole(m("Jeevi [Bright Data]"), sponsors["spons-microsoft"], orgs, tag)).toBe("other");
  });

  test("event channels match any configured sponsor; hackers stay other", () => {
    const ev = sponsors["0-announcements"];
    expect(posterRole(m("Sam Vega (Microsoft)", { channel_name: "2-opportunities" }), ev, orgs, tag, all)).toBe("sponsor-side");
    expect(posterRole(m("quinnbuilds7"), bd, orgs, tag, all)).toBe("other");
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
    const before = at("cohost-annapurna-labs", "LenaRose (Annapurna Labs)", { author_id: "U1" });
    const after = at("cohost-annapurna-labs", "LenaRose", { author_id: "U1" });
    const role = rolesById([before, after], sponsors, new Set(), null);
    expect([role(before), role(after)]).toEqual(["sponsor-side", "sponsor-side"]);
    expect(role(at("0-announcements", "LenaRose", { author_id: "U1" }))).toBe("sponsor-side");
    expect(role(at("spons-microsoft", "LenaRose", { author_id: "U1" }))).toBe("other");
  });
  test("an organizer tag seen once marks every post by that id; no id, no role, whatever the name says", () => {
    const tagged = at("spons-microsoft", "Charlie [Cal Hacks]", { author_id: "U2" });
    const plain = at("spons-microsoft", "Charlie", { author_id: "U2" });
    const role = rolesById([tagged, plain], sponsors, new Set(["U3"]), organizerTag("Cal Hacks 13.0"));
    expect([role(tagged), role(plain), role(at("spons-microsoft", "anyone", { author_id: "U3" }))]).toEqual(["organizer", "organizer", "organizer"]);
    expect(role(at("cohost-annapurna-labs", "Someone (Annapurna Labs)"))).toBe("other");
  });
});
