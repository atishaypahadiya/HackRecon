import { describe, expect, test } from "bun:test";
import type { BoardOffer } from "./board.ts";
import type { PlanTrack } from "./plan.ts";
import { firstLine, joinSponsors, planCredits, planPeople, planSessions, quoteHolds, submissionDeadline, type JoinSponsor } from "./planjoin.ts";
import { personKeys } from "./people.ts";
import type { Sponsors } from "./pool.ts";
import { rolesById } from "./roles.ts";
import type { Item, Message } from "./schema.ts";

const aliases = { Anthropic: ["Claude"], Apify: [], Factory: ["Factory AI"], Vercel: [], event: [] };
const products = [{ sponsor: "Anthropic", product: "Claude API", names: ["Claude API", "Anthropic"] }];
const track = (sponsor: string, name: string, fit: "likely" | "possible" = "likely") => ({ sponsor, name, fit }) as PlanTrack;

describe("joinSponsors: the stack's sponsors, then the likely tracks'", () => {
  test("whole-word names, aliases and products; possible tracks add none", () => {
    const s = joinSponsors(
      { idea: "x", stack: [{ name: "Claude API", used_for: null }, { name: "web app on Vercel", used_for: null }, { name: "Supabase", used_for: null }] },
      [track("Apify", "[Apify] Best Use of Apify"), track("Anthropic", "[Anthropic] Claude for Public Benefit"), track("Factory", "[Factory] Droid", "possible")],
      aliases,
      products,
    );
    expect(s).toEqual([
      { sponsor: "Anthropic", why: ["in your stack: Claude API", "likely track: [Anthropic] Claude for Public Benefit"] },
      { sponsor: "Vercel", why: ["in your stack: web app on Vercel"] },
      { sponsor: "Apify", why: ["likely track: [Apify] Best Use of Apify"] },
    ]);
  });
});

describe("quotes", () => {
  test("a quote holds verbatim, less a trailing ellipsis, whitespace-normalized; firstLine cuts at a word", () => {
    expect(quoteHolds("Use code  ABC…", "Hi!\nUse code ABC at checkout")).toBe(true);
    expect(quoteHolds("Use code XYZ", "Use code ABC")).toBe(false);
    expect(quoteHolds("", "anything")).toBe(false);
    expect(firstLine("\n  Workshop at 2pm in the Theater\nmore", 20)).toBe("Workshop at 2pm in…");
  });
});

const S: JoinSponsor[] = [{ sponsor: "Apify", why: ["in your stack: Apify"] }, { sponsor: "Factory", why: ["likely track: [Factory] Droid"] }];
const NOW = Date.parse("2026-10-24T12:00:00-07:00");

describe("planCredits (P3)", () => {
  const offer = (id: string, sponsor: string, first: number, limit: number | null, excerpt = "Use code APIFY for $200"): BoardOffer => ({
    id, sponsor, title: "credits", value_short: "$200 credits", claim_short: "Use coupon", amount_text: "", usd: null, limit, limit_unclear: false, claim_url: "", promo_code: "APIFY", claim_how: "", first, excerpt, posts: [{ ts: first, permalink: `p/${id}`, channel: "c" }],
  });
  const s = NOW / 1000;
  const shown = new Map(["a", "b", "c", "d", "e", "f"].map((id) => [`p/${id}`, "Hey! Use code APIFY for $200 in credits"]));
  test("posted by now, still open, from a joined sponsor; soonest limit first; a quote not in its posts is dropped", () => {
    const r = planCredits(
      [
        offer("a", "Apify", s - 100, null),
        offer("b", "Factory", s - 100, s + 3600),
        offer("c", "Factory", s - 100, s - 1), // closed
        offer("d", "Apify", s + 100, null), // not posted yet
        offer("e", "Mana", s - 100, null), // not a joined sponsor
        offer("f", "Apify", s - 100, null, "Use code OTHER"), // quote not in its post
      ],
      S,
      shown,
      s,
    );
    expect(r.credits.map((c) => c.offer_id)).toEqual(["b", "a"]);
    expect(r.dropped).toBe(1);
    expect(r.credits[1]).toMatchObject({ value: "$200 credits", why: ["in your stack: Apify"], source_url: "p/a" });
  });
});

describe("planSessions (P4)", () => {
  const msg = (id: string, text: string, posted: string): Message => ({ id, channel_id: "C", channel_name: "spons-apify", ts: String(Date.parse(posted) / 1000), author_name: "x", text, links: [], permalink: `p/${id}`, captured_at: "", run_id: "r" });
  const item = (message_id: string, sponsor: string, start?: string): Item => ({ message_id, item_index: 0, kind: "workshop", sponsor, offer_key: "", amount_text: "", amount_unit: "other", amount_basis: "unknown", ...(start ? { event_start_iso: start } : {}), deadline_status: "none", urls: [], model: "m", classified_at: "" }) as unknown as Item;
  const deadline = submissionDeadline([
    { name: "Arrive with the whole team", at: "2026-10-25T09:00:00-07:00", url: "" },
    { name: "Devpost submission deadline extended", at: "2026-10-25T09:30:00-07:00", url: "u" },
  ]);
  test("the submission deadline is the first deadline that names submission", () => {
    expect(deadline).toEqual({ at: "2026-10-25T09:30:00-07:00", name: "Devpost submission deadline extended", source_url: "u" });
    expect(submissionDeadline([{ name: "Judging", at: "2026-10-25T10:30:00-07:00", url: "" }])).toBeNull();
  });
  test("upcoming, before the deadline, posted by now, by time, one per sponsor and start", () => {
    const ms = new Map(
      [
        msg("m1", "Apify office hours at 3pm\nBooth 12", "2026-10-24T09:00:00-07:00"),
        msg("m2", "Factory workshop at 1pm", "2026-10-24T08:00:00-07:00"),
        msg("m3", "Apify workshop this morning", "2026-10-24T08:00:00-07:00"),
        msg("m4", "Apify after-party", "2026-10-24T08:00:00-07:00"),
        msg("m5", "Apify office hours at 3pm (repost)", "2026-10-24T10:00:00-07:00"),
        msg("m6", "Apify talk posted later", "2026-10-24T13:00:00-07:00"),
        msg("m7", "Mana talk", "2026-10-24T08:00:00-07:00"),
      ].map((m) => [m.id, m]),
    );
    const r = planSessions(
      [
        item("m1", "Apify", "2026-10-24T15:00:00-07:00"),
        item("m2", "Factory", "2026-10-24T13:00:00-07:00"),
        item("m3", "Apify", "2026-10-24T11:00:00-07:00"), // already started
        item("m4", "Apify", "2026-10-25T20:00:00-07:00"), // after the deadline
        item("m5", "Apify", "2026-10-24T15:00:00-07:00"), // same sponsor and start
        item("m6", "Apify", "2026-10-24T16:00:00-07:00"), // not posted yet at noon
        item("m7", "Mana", "2026-10-24T14:00:00-07:00"), // not a joined sponsor
        item("m1", "Apify"), // no start time
      ],
      ms,
      S,
      NOW,
      deadline,
    );
    expect(r.map((x) => [x.sponsor, x.quote])).toEqual([["Factory", "Factory workshop at 1pm"], ["Apify", "Apify office hours at 3pm"]]);
  });
});

describe("planPeople (P5)", () => {
  const sponsors = { "spons-factory": { sponsor: "Factory", kind: "sponsor", aliases: [] }, "spons-apify": { sponsor: "Apify", kind: "sponsor", aliases: [] } } as unknown as Sponsors;
  const msg = (ts: number, author_id: string, author_name: string, channel_name = "spons-factory", extra: Partial<Message> = {}): Message => ({ id: `C:${ts}`, channel_id: "C", channel_name, ts: String(ts), author_id, author_name, text: `post ${ts}`, links: [], permalink: `p/${ts}`, captured_at: "", run_id: "r", ...extra });
  const messages = [
    msg(100, "UG", "David [Factory]"),
    msg(200, "UM", "David"), // the same person's second account, renamed: linked
    msg(300, "UH", "a hacker"),
    msg(400, "UB", "Factory bot [Factory]", "spons-factory", { author_kind: "bot" }),
    msg(500, "UA", "Ana [Apify]", "spons-apify"), // Apify isn't a likely track here
    msg(9999, "UL", "Late [Factory]"), // after now
  ];
  test("likely tracks' sponsors only; by person, sponsor-side, posted by now; the latest name, every account counted", () => {
    const person = personKeys([{ ids: ["UG", "UM"] }]);
    const role = rolesById(messages, sponsors, new Set(), person);
    const p = planPeople(messages, S, sponsors, role, person, 1000);
    expect(p).toEqual([{ sponsor: "Factory", why: ["likely track: [Factory] Droid"], reps: [{ person: "UG", name: "David", accounts: 2, posts: 2, first: 100, quote: "post 100", source_url: "p/100" }] }]);
  });
});
