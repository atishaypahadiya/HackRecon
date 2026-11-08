// SMS rules (user 2026-11-07): what alerts, how urgently, why it matters to the Plan; important texts rate-limited,
// the rest batched; a failed send goes back in the queue.
import { describe, expect, test } from "bun:test";
import { alertFor, ALERT_MAX_AGE_MS, ALERT_SKEW_MS, deliver, isFresh, digestBody, EMPTY_NOTIFY, NOW_MIN_GAP_MS, planHits, MESSAGE_MAX_CHARS, unreadAlert, unsend, type Alert, type PlanFacts } from "./alerts.ts";
import type { Item, Message } from "./schema.ts";
import { replay } from "./testdata/discord-replay.ts";

const plan = replay.plan as PlanFacts;
const TZ = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);
const msg = (text: string, o: Partial<Message> = {}): Message => ({ id: `discord-1:${Date.parse("2026-11-14T10:00:00-08:00") / 1000}.000000`, channel_id: "discord-1", channel_name: "announcements", ts: `${Date.parse("2026-11-14T10:00:00-08:00") / 1000}.000000`, author_name: "Example Hacks Team", text, links: [], permalink: "https://discord.com/channels/1/1/1", captured_at: "", run_id: "r", ...o });
const item = (o: Partial<Item>): Item => ({ message_id: "x", item_index: 0, kind: "credit", sponsor: "event", offer_key: "", amount_text: "", amount_unit: "other", amount_basis: "unknown", deadline_status: "none", urls: [], model: "m", classified_at: "", ...o });
const opts = { nowMs: at("2026-11-14T10:01:00-08:00"), tz: TZ, guildName: "Example Hacks", organizer: false };

describe("planHits", () => {
  test("a stack item or a Plan track's sponsor named in the post, or the item's sponsor", () => {
    expect(planHits("Build agents on Modal at 3pm", "event", plan)).toEqual(["It's about Modal, in your stack (GPU inference for the planner)", "Your Plan's likely track: Best Use of Modal"]);
    expect(planHits("$50 for everyone", "Modal", plan)).toEqual(["It's about Modal, in your stack (GPU inference for the planner)", "Your Plan's likely track: Best Use of Modal"]);
    expect(planHits("Acme is hiring", "Acme", plan)).toEqual([]);
    expect(planHits("Modalities of learning", "event", plan)).toEqual([]);
    expect(planHits("anything", "Modal", null)).toEqual([]);
  });
});

test("fresh: posted at most 6 hours ago, and not after now (5 minutes of clock skew allowed)", () => {
  // Live replay, 2026-11-07: with no lower bound, a 09:01 check texted the 16:00 deadline.
  const now = Date.parse("2026-11-14T09:01:00-08:00");
  expect([now - ALERT_MAX_AGE_MS, now, now + ALERT_SKEW_MS].map((t) => isFresh(t, now))).toEqual([true, true, true]);
  expect([now - ALERT_MAX_AGE_MS - 1, now + ALERT_SKEW_MS + 1, Date.parse("2026-11-14T16:00:00-08:00")].map((t) => isFresh(t, now))).toEqual([false, false, false]);
});

describe("alertFor", () => {
  const auth = { authority: true as const };
  test("tracks and judging posted: only where organizers post", () => {
    expect(alertFor(msg("Tracks and prizes are live! See every track on Devpost", auth), [], plan, opts)).toMatchObject({ kind: "tracks", level: "now", why: "Check your Plan's likely tracks are there as you expect: Best Use of Modal" });
    expect(alertFor(msg("Judging criteria: technical depth. Judging starts Sunday 10:00 AM.", auth), [], plan, opts)).toMatchObject({ kind: "judging", level: "now" });
    expect(alertFor(msg("are the tracks out yet??", { channel_name: "general" }), [], plan, opts)).toBeNull();
  });
  test("a room or time change from organizers is urgent, with the Plan's reason when it names one", () => {
    expect(alertFor(msg("Room change: the Modal workshop has moved to Room 210, same time.", auth), [], plan, opts)).toMatchObject({ kind: "change", level: "now", why: "It's about Modal, in your stack (GPU inference for the planner); Your Plan's likely track: Best Use of Modal" });
    expect(alertFor(msg("my team moved to room 210 lol"), [], plan, opts)).toBeNull();
  });
  test("deadlines: urgent from organizers, with the time left; a hacker's mention waits for the digest", () => {
    const d = item({ kind: "deadline", deadline_iso: "2026-11-15T09:00:00-08:00", deadline_status: "resolved_relative" });
    expect(alertFor(msg("Submissions are due Sunday at 9:00 AM.", auth), [d], plan, opts)).toMatchObject({ kind: "deadline", level: "now", why: "Due Sun 9:00 AM (in 23 h)" });
    expect(alertFor(msg("isn't the form due tonight?", { channel_name: "general" }), [d], plan, opts)!.level).toBe("digest");
  });
  test("workshops and offers: at once when they match the Plan, else the digest; jobs always wait", () => {
    expect(alertFor(msg("Workshop: deploy agents on Modal, 3:00 PM in Room 105.", auth), [item({ kind: "workshop", sponsor: "Modal", event_start_iso: "2026-11-14T15:00:00-08:00" })], plan, opts)).toMatchObject({ kind: "workshop", level: "now" });
    expect(alertFor(msg("Intro to Figma plugins, 4pm"), [item({ kind: "workshop", sponsor: "Figma" })], plan, opts)).toMatchObject({ kind: "workshop", level: "digest", why: "Not tied to your stack or tracks" });
    expect(alertFor(msg("Every hacker gets $50 in Modal credits"), [item({ kind: "credit", sponsor: "Modal", amount_text: "$50" })], plan, opts)).toMatchObject({ kind: "offer", level: "now", what: "Modal: $50 in credits" });
    // Live replay: Haiku's amount_text is the post's phrase; nothing is added twice.
    expect(alertFor(msg("Every hacker gets $50 in Modal credits"), [item({ kind: "credit", sponsor: "Modal", amount_text: "$50 in Modal credits" })], plan, opts)!.what).toBe("$50 in Modal credits");
    expect(alertFor(msg("Acme is hiring interns"), [item({ kind: "job", sponsor: "Acme" })], plan, opts)).toMatchObject({ kind: "offer", level: "digest" });
    expect(alertFor(msg("anyone want to team up?"), [], plan, opts)).toBeNull();
    // Live replay, 2026-11-07: Haiku files "Dinner is served" as an event-wide "other" item; that's no sponsor offer.
    expect(alertFor(msg("Dinner is served in the main hall.", auth), [item({ kind: "other", sponsor: "event" })], plan, opts)).toBeNull();
    expect(alertFor(msg("Free Modal hoodies at our booth"), [item({ kind: "other", sponsor: "Modal" })], plan, opts)).toMatchObject({ kind: "offer", level: "now" });
  });
  test("unread badges: an announcement channel at once, a sponsor channel in the digest", () => {
    const u = { channel_id: "9", channel_name: "announcements", role: "announcement", since: "2026-11-14T10:00:00-08:00", guild_id: "1", guild_name: "Example Hacks" };
    expect(unreadAlert(u)).toMatchObject({ kind: "unread", level: "now", what: "New post in #announcements", link: "https://discord.com/channels/1/9" });
    expect(unreadAlert({ ...u, role: "sponsor", channel_name: "sponsor-modal" }).level).toBe("digest");
  });
});

const alert = (key: string, level: Alert["level"] = "now"): Alert => ({ key, kind: "tracks", level, what: `post ${key}`, why: "why", source: "#announcements, Example Hacks", link: "https://discord.com/channels/1/1/1", posted_at: "" });

describe("deliver", () => {
  const t0 = at("2026-11-14T10:00:00-08:00");
  test("important: up to three in one text, then one text per 10 minutes and four an hour; nothing twice", () => {
    let r = deliver(EMPTY_NOTIFY, ["a", "b", "c", "d", "e"].map((k) => alert(k)), t0);
    expect(r.notices.map((s) => s.keys)).toEqual([["a", "b", "c"]]);
    expect(r.notices[0]!.body).toContain("+2 more in the next message");
    r = deliver(r.state, [alert("a"), alert("f")], t0 + 5 * 60_000);
    expect(r.notices).toEqual([]);
    r = deliver(r.state, [], t0 + NOW_MIN_GAP_MS);
    expect(r.notices.map((s) => s.keys)).toEqual([["d", "e", "f"]]);
    let state = r.state;
    for (let i = 2; i <= 5; i++) {
      r = deliver(state, [alert(`x${i}`)], t0 + i * NOW_MIN_GAP_MS);
      state = r.state;
      expect(r.notices.length).toBe(i <= 3 ? 1 : 0); // texts at :00 :10 :20 :30 make four in the hour
    }
    expect(deliver(state, [], t0 + 6 * NOW_MIN_GAP_MS + 1).notices.map((s) => s.keys)).toEqual([["x4", "x5"]]);
  });
  test("the rest: one digest two hours after the first waits, then every two hours", () => {
    let r = deliver(EMPTY_NOTIFY, [alert("j1", "digest")], t0);
    expect(r.notices).toEqual([]);
    r = deliver(r.state, [alert("j2", "digest")], t0 + 3600_000);
    expect(r.notices).toEqual([]);
    r = deliver(r.state, [], t0 + 2 * 3600_000);
    expect(r.notices.map((s) => [s.level, s.keys])).toEqual([["digest", ["j1", "j2"]]]);
    expect(r.notices[0]!.body).toBe("HackRecon digest, 2 items:\n1. Tracks posted: post j1 (#announcements, Example Hacks)\n2. Tracks posted: post j2 (#announcements, Example Hacks)");
    r = deliver(r.state, [alert("j3", "digest")], t0 + 3 * 3600_000);
    expect(r.notices).toEqual([]);
  });
  test("a failed send goes back to the front of its queue and doesn't count against the limit", () => {
    const r = deliver(EMPTY_NOTIFY, [alert("a")], t0);
    const back = unsend(r.state, r.notices[0]!);
    expect(back.sent).toEqual([]);
    expect(deliver(back, [], t0 + 1000).notices.map((s) => s.keys)).toEqual([["a"]]);
  });
  test("texts stay under Twilio's limit", () => {
    const long = { ...alert("l"), what: "x".repeat(5000) };
    expect(deliver(EMPTY_NOTIFY, [long], t0).notices[0]!.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(digestBody(Array.from({ length: 6 }, (_, i) => alert(String(i), "digest")), 4)).toContain("+4 more: bun run hr alerts --list");
  });
});
