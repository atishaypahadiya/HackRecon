import { describe, expect, test } from "bun:test";
import { personKeys } from "./people.ts";
import type { Sponsors } from "./pool.ts";
import { emailReps, HACKER_ONLY, likelyReps, mentionAuthority, mentionReps, repEvidence, repIndex, signalLabels, type MentionPost } from "./reps.ts";
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
    const ix = repIndex({ built_at: "", sources: { emails: "", mentions: "", replies: "", hacker_only: "" }, hacker_only_channels: [], rule_notes: [], reps: repEvidence([], [], likely, (id) => id) });
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
    const ev = repEvidence(
      [{ id: "U9", sponsor: "Apify", domain: "apify.com" }],
      [{ id: "U1", sponsor: "Apify", by: "UORG", permalink: "p/m" }],
      [{ person: "U1", accounts: ["U1"], sponsor: "Apify", posts: [{ ts: 1, permalink: "p/1" }], answers: [{ ts: 2, permalink: "p/2" }] }],
      person,
    );
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
