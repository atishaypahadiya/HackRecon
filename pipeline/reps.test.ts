import { describe, expect, test } from "bun:test";
import { personKeys } from "./people.ts";
import type { Sponsors } from "./pool.ts";
import { emailReps, HACKER_ONLY, likelyReps, likelySince, mentionAuthority, mentionReps, repEvidence, repIndex, selfIdReps, signalLabels, staffSince, type MentionPost } from "./reps.ts";
import { selfIdentification, selfIdSponsors } from "./selfid.ts";
import { rolesById } from "./roles.ts";
import type { Item, Message } from "./schema.ts";

const sponsors = {
  "0-announcements": { sponsor: "event", kind: "event", aliases: [] },
  "spons-apify": { sponsor: "Apify", kind: "sponsor", aliases: [], domains: ["apify.com"] },
  "spons-fetch-ai": { sponsor: "Fetch.ai", kind: "sponsor", aliases: ["Fetch AI"] },
} as Sponsors;

describe("signal 1: profile email on the sponsor's domain", () => {
  test("the domain or a subdomain; never a look-alike; no email, no signal", () => {
    expect(
      emailReps(
        [
          { id: "U1", email: "pat@apify.com" },
          { id: "U2", email: "a@mail.Apify.com" },
          { id: "U3", email: "x@apify.com.evil.io" },
          { id: "U4", email: "y@gmail.com" },
          { id: "U5" },
        ],
        sponsors,
      ).map((x) => [x.id, x.sponsor]),
    ).toEqual([
      ["U1", "Apify"],
      ["U2", "Apify"],
    ]);
  });
});

describe("signal 2: an authority account mentions the user ID beside the sponsor's name", () => {
  const post = (author_id: string, text: string, mentions: { id: string; label: string }[], channel_name = "0-announcements", reply = false): MentionPost => ({ author_id, channel_name, text, mentions, permalink: `p/${text.length}`, reply });
  const authority = (p: MentionPost) => p.author_id === "UORG";
  const organizer = (id: string) => id === "UORG" || id === "UORG2";
  test("same line, one sponsor named outside the mention's label", () => {
    const r = mentionReps(
      [
        post("UORG", "Say hi to @Pat from Apify at the booth\nand @Lee is our MC", [{ id: "UP", label: "@Pat" }, { id: "UL", label: "@Lee" }]),
        post("UHACK", "@Ana from Apify helped us", [{ id: "UA", label: "@Ana" }]), // not an authority account
        post("UORG", "thanks @Ana [Apify]!", [{ id: "UA", label: "@Ana [Apify]" }]), // the name is only in her own label
        post("UORG", "@Bo from Apify and Fetch.ai judges", [{ id: "UB", label: "@Bo" }]), // two sponsors: skipped
        post("UORG", "@UORG2 runs Apify's table", [{ id: "UORG2", label: "@UORG2" }]), // organizers aren't reps
      ],
      sponsors,
      authority,
      organizer,
    );
    expect(r.hits.map((h) => [h.id, h.sponsor])).toEqual([["UP", "Apify"]]);
    expect(r.ambiguous).toBe(1);
  });
});

describe("signal 2's authority: a reply in an authority channel carries none", () => {
  test("top-level posts there count; anyone's thread reply there doesn't; an authority account's reply does", () => {
    const auth = mentionAuthority(new Set(["UORG"]), new Set(["0-announcements"]));
    const p = (author_id: string, reply: boolean): MentionPost => ({ author_id, channel_name: "0-announcements", text: "@me from Apify", mentions: [{ id: "UHACK", label: "@me" }], permalink: "p", reply });
    expect([auth(p("UANY", false)), auth(p("UHACK", true)), auth(p("UORG", true))]).toEqual([true, false, true]);
    expect(mentionReps([p("UHACK", true)], sponsors, auth, () => false).hits).toEqual([]);
  });
});

describe("signal 3: likely staff", () => {
  const msg = (id: string, author_id: string, extra: Partial<Message> = {}): Message => ({ id: `C:${id}`, channel_id: "C", channel_name: "spons-apify", ts: id, author_id, author_name: author_id, text: "hi", links: [], permalink: `p/${id}`, captured_at: "", run_id: "r", ...extra });
  const item = (id: string, kind: string) => ({ message_id: `C:${id}`, kind }) as unknown as Item;
  const messages = [
    msg("1", "UP"), // Pat's offer post
    msg("2", "UH", { text: "does the actor need to be new?" }), // a hacker's question
    msg("3", "UQ"), // a second poster's workshop post, but they never answer
    msg("4", "UX"), // a third poster: offer post and answer, but also in team formation
    msg("5", "UH2", { text: "thanks" }), // a hacker's post with no question
  ];
  const replies = [msg("2.1", "UP", { thread_ts: "2" }), msg("2.2", "UX", { thread_ts: "2" }), msg("5.1", "UQ", { thread_ts: "5" })];
  const items = [item("1", "credit"), item("3", "workshop"), item("4", "prize"), item("2", "other")];
  const base = { messages: [...messages, msg("4", "UX")], replies, items, sponsors, person: (id: string) => id };
  test("a staff post at the top of the channel AND an answer to a hacker's question AND never in a hacker-only channel", () => {
    const role = rolesById(messages, sponsors, new Set());
    const r = likelyReps({ ...base, role, hackerPosters: new Set(["UX", "UH"]) });
    expect(r.map((x) => [x.person, x.sponsor, x.posts.map((e) => e.permalink), x.answers.map((e) => e.permalink)])).toEqual([["UP", "Apify", ["p/1"], ["p/2.1"]]]);
  });
  test("hacker-only channels not read: no one is likely staff", () => {
    expect(likelyReps({ ...base, role: rolesById(messages, sponsors, new Set()), hackerPosters: null })).toEqual([]);
  });
  test("likely staff never gains a role, so no authority over links or offers and no classifier hint", () => {
    const likely = likelyReps({ ...base, role: rolesById(messages, sponsors, new Set()), hackerPosters: new Set() });
    const ix = repIndex({ built_at: "", sources: { emails: "", mentions: "", replies: "", hacker_only: "" }, hacker_only_channels: [], rule_notes: [], reps: repEvidence({ email: [], mention: [], likely, person: (id) => id }) });
    expect([...ix.likely.keys()]).toContain("UP");
    expect(ix.confirmed.size).toBe(0);
    const role = rolesById(messages, sponsors, new Set(), (id) => id, ix.confirmed);
    expect(role(messages[0]!)).toBe("other");
  });
  test("hacker-only by name when event.json lists none", () => {
    expect(["1-team-formation", "1-introductions", "team_formation", "intro-to-hackathons", "spons-apify"].filter((c) => HACKER_ONLY.test(c))).toEqual(["1-team-formation", "1-introductions", "team_formation"]);
  });
});

describe("evidence: one entry per person and sponsor, confirmed outranks likely", () => {
  test("confirmed signals make the person sponsor-side through rolesById; labels list strongest first", () => {
    const person = personKeys([{ ids: ["U1", "U9"] }]);
    const ev = repEvidence({
      email: [{ id: "U9", sponsor: "Apify", domain: "apify.com" }],
      mention: [{ id: "U1", sponsor: "Apify", by: "UORG", permalink: "p/m" }],
      likely: [{ person: "U1", accounts: ["U1"], sponsor: "Apify", posts: [{ ts: 1, permalink: "p/1" }], answers: [{ ts: 2, permalink: "p/2" }] }],
      person,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ person: "U1", accounts: ["U1", "U9"], standing: "confirmed" });
    const ix = repIndex({ built_at: "", sources: { emails: "", mentions: "", replies: "", hacker_only: "" }, hacker_only_channels: [], rule_notes: [], reps: ev }, person);
    const m = { id: "C:1", channel_id: "C", channel_name: "spons-apify", ts: "1", author_id: "U9", author_name: "x", text: "", links: [], permalink: "", captured_at: "", run_id: "r" } as Message;
    expect(rolesById([m], sponsors, new Set(), person, ix.confirmed)(m)).toBe("sponsor-side");
    expect(signalLabels(["name or title", "external badge"], ix.signals.get("U1|Apify"))).toEqual([
      "email on apify.com",
      "named by an organizer",
      "external badge",
      "name or title",
      "likely staff: 1 offer, prize or workshop post, 1 answer to hackers",
    ]);
  });
});

describe("signal 2b: says they work there, in four phrasings anchored on the writer", () => {
  const hit = (t: string, names = ["Apify"]) => selfIdentification(t, names)?.form ?? null;
  test("role + at X, in the writer's introduction", () => {
    expect(hit("Hi everyone!\n\nMy name is Tomas, I'm a Senior Software Engineer at CRS. This year…", ["CRS Credit API", "CRS"])).toBe("role at");
    expect(hit("Hey Cal Hacks!\n\nI am Maya, a technical recruiter at Armadin. Thank you", ["Armadin"])).toBe("role at");
    expect(hit("I'm a developer advocate at Apify")).toBe("role at");
  });
  test("with X, as an introduction", () => {
    expect(hit("Hi all, I'm Pat with Apify, ask me anything")).toBe("with");
    expect(hit("Hello everyone! My name is Sam and I am a recruiter with Microsoft!", ["Microsoft", "Azure"])).toBe("with");
  });
  test("founder(s) of X, said of the writer", () => {
    expect(hit("Hey everyone! I'm Ben, one of the founders of Mana. We're sponsoring", ["Mana"])).toBe("founder of");
    expect(hit("we're the co-founders of Apify")).toBe("founder of");
  });
  test("We're X only as the post's first sentence, after an optional greeting", () => {
    expect(hit("Hey Cal Hacks! :wave:\nWe’re Bitdeer AI, a sponsor of Cal Hacks", ["Bitdeer AI", "Bitdeer"])).toBe("we're");
    expect(hit("Hi everyone! :wave:\nWe're Wajo,\u00a0 we build Fo", ["Wajo AI", "Wajo"])).toBe("we're");
    expect(hit("We're Apify. Come say hi")).toBe("we're");
  });
  test("misfires: using or building with X, X as a thing, someone else's role, questions, We're X mid-post", () => {
    for (const [t, names] of [
      ["we're using Bitdeer for inference", ["Bitdeer"]],
      ["We're using Bitdeer AI and it's great", ["Bitdeer AI", "Bitdeer"]],
      ["Hey! We're Bitdeer users and love it", ["Bitdeer"]],
      ["We're Apify fans", ["Apify"]],
      ["We're building with Apify", ["Apify"]],
      ["Hi! Some news first. We're Apify", ["Apify"]], // not the first sentence
      ["Jaroslav Hejlek <https://linkedin.com/in/j> - Founding Engineer at Apify", ["Apify"]], // a judge list
      ["an exclusive session with an Early Career Recruiter at Figma", ["Figma"]],
      ["I talked to an engineer at Apify", ["Apify"]],
      ["Is anyone here an engineer at Apify?", ["Apify"]],
      ["Thanks to the founders of Mana for the talk", ["Mana"]],
      ["I'm Lee from the Apify workshop", ["Apify"]],
      ["I am an intern at Amazon AWS on the Redshift Team", ["Annapurna Labs", "Amazon", "AWS"]], // a hacker's introduction
      ["I'm a student at Berkeley working with Apify", ["Apify"]],
      ["I'm Pat with Apifyx", ["Apify"]],
      ["Amir from Mana team here", ["Mana"]], // not one of the four phrasings
      ["Sara here from Wajo AI.", ["Wajo AI"]],
      ["we’re the team behind moss :wave:", ["Moss"]],
    ] as [string, string[]][])
      expect([t, hit(t, names)]).toEqual([t, null]);
  });
  test("in a hacker-only channel the page asks which sponsors, and keeps only that", () => {
    const sp = [{ id: "Microsoft", names: ["Microsoft", "Azure"] }, { id: "Apify", names: ["Apify"] }];
    expect(selfIdSponsors("My name is Sam and I am a recruiter with Microsoft! Looking for teams using Apify", sp)).toEqual(["Microsoft"]);
    expect(selfIdSponsors("Looking for a team, I know Apify and Azure", sp)).toEqual([]);
  });
  test("only the poster's own posts in that sponsor's channel; hacker-channel flags join by sponsor", () => {
    const sp = { ...sponsors, "spons-crs": { sponsor: "CRS Credit API", kind: "sponsor", aliases: ["CRS"] } } as Sponsors;
    const m = (author_id: string, channel_name: string, text: string, extra: Partial<Message> = {}): Message => ({ id: `C:${text.length}`, channel_id: "C", channel_name, ts: String(text.length), author_id, author_name: author_id, text, links: [], permalink: `p/${text.length}`, captured_at: "", run_id: "r", ...extra });
    const r = selfIdReps(
      [
        m("UT", "spons-crs", "My name is Tomas, I'm a Senior Software Engineer at CRS. Happy to help"),
        m("UP", "0-announcements", "I'm Pat with Apify"), // event channel
        m("UQ", "spons-fetch-ai", "I'm Quinn with Apify"), // not Apify's channel
        m("UB", "spons-apify", "We're Apify", { author_kind: "bot" }),
      ],
      sp,
      (id) => id,
      [{ id: "US", sponsor: "Apify", channel: "1-introductions", ts: 900 }, { id: "UZ", sponsor: "Nobody", channel: "1-introductions", ts: 900 }],
    );
    expect(r.map((x) => [x.person, x.sponsor, x.posts[0]!.phrase ?? x.posts[0]!.channel])).toEqual([
      ["UT", "CRS Credit API", "My name is Tomas, I'm a Senior Software Engineer at CRS"],
      ["US", "Apify", "1-introductions"],
    ]);
    expect(r[1]!.posts[0]).toEqual({ ts: 900, permalink: "", channel: "1-introductions" });
  });
});

describe("2b alone, and with the hacker-channel counter-signal", () => {
  const msg = (id: string, author_id: string, extra: Partial<Message> = {}): Message => ({ id: `C:${id}`, channel_id: "C", channel_name: "spons-apify", ts: id, author_id, author_name: author_id, text: "hi", links: [], permalink: `p/${id}`, captured_at: "", run_id: "r", ...extra });
  const item = (id: string, kind: string) => ({ message_id: `C:${id}`, kind }) as unknown as Item;
  const messages = [msg("1", "UX"), msg("2", "UH", { text: "can we use the free tier?" })];
  const o = { messages, replies: [msg("2.1", "UX", { thread_ts: "2" })], items: [item("1", "credit")], sponsors, person: (id: string) => id, hackerPosters: new Set(["UX"]) };
  const ix = (ev: ReturnType<typeof repEvidence>) => repIndex({ built_at: "", sources: { emails: "", mentions: "", replies: "", hacker_only: "" }, hacker_only_channels: [], rule_notes: [], reps: ev });
  test("2b alone makes likely staff, never a role, labeled says they work there", () => {
    const ev = repEvidence({ email: [], mention: [], selfId: [{ person: "UM", accounts: ["UM"], sponsor: "Apify", posts: [{ ts: 5, permalink: "p/5", phrase: "I am Maya, a recruiter at Apify" }] }], likely: [], person: (id) => id });
    expect(ev.map((e) => [e.person, e.standing])).toEqual([["UM", "likely"]]);
    const x = ix(ev);
    expect([x.confirmed.size, [...x.likely.keys()]]).toEqual([0, ["UM"]]);
    const file = x.signals.get("UM|Apify");
    expect([likelySince(file), staffSince(file)]).toEqual([5, null]);
    expect(signalLabels([], file)).toEqual(["says they work there: “I am Maya, a recruiter at Apify”"]);
    expect(signalLabels([], file, 4)).toEqual([]);
  });
  test("a hacker-channel flag has no phrase: the label names the channel", () => {
    const ev = repEvidence({ email: [], mention: [], selfId: [{ person: "US", accounts: ["US"], sponsor: "Apify", posts: [{ ts: 900, permalink: "", channel: "1-introductions" }] }], likely: [], person: (id) => id });
    expect(signalLabels([], ix(ev).signals.get("US|Apify"))).toEqual(["says they work there (in #1-introductions)"]);
  });
  test("without 2b a hacker-channel post excludes; with it, signal 3 holds from the self-identification on", () => {
    const role = rolesById(messages, sponsors, new Set());
    expect(likelyReps({ ...o, role })).toEqual([]);
    const likely = likelyReps({ ...o, role, selfIdentified: new Set(["UX|Apify"]) });
    const self = [{ person: "UX", accounts: ["UX"], sponsor: "Apify", posts: [{ ts: 3, permalink: "p/3", phrase: "I'm UX with Apify" }] }];
    const ev = repEvidence({ email: [], mention: [], selfId: self, likely, hacker: new Map([["UX", [{ channel: "1-introductions", posts: 1 }]]]), person: (id) => id });
    const file = ix(ev).signals.get("UX|Apify");
    expect(signalLabels([], file)).toEqual(["says they work there: “I'm UX with Apify”", "likely staff: 1 offer, prize or workshop post, 1 answer to hackers", "counter-signal: posted in #1-introductions (1)"]);
    expect([staffSince(file), likelySince(file)]).toEqual([3, 3]);
    expect(signalLabels([], file, 2.5)).toEqual(["counter-signal: posted in #1-introductions (1)"]);
  });
});
