// Cases are the exact rows observed in the day-1 capture of the locked 25 (2026-10-27).
import { describe, expect, test } from "bun:test";
import { normalizeCapture } from "./captures.ts";
import { broadcastParent, LIST_TOP_TS, nonPostReason } from "./rows.ts";
import { messageId, type CaptureFile, type Message } from "./schema.ts";

const W = "https://cal-hacks-13-0.slack.com/archives";

describe("nonPostReason (observed day-1 rows)", () => {
  test("cohost-hyphenate 1792960234.096399: deleted parent, no permalink, no body", () => {
    expect(nonPostReason({ ts: "1792960234.096399", permalink: "", text: "", hasBody: false })).toBe("tombstone");
  });
  test("0-announcements 0000000000.000001: empty list-top slot", () => {
    expect(nonPostReason({ ts: LIST_TOP_TS, permalink: "", text: "", hasBody: false })).toBe("list_top");
  });
  test("spons-wajo-ai 1793061633.116200: GitHub's \"You won't see this prompt again.\"", () => {
    const permalink = `${W}/C0C6X92JH62/p1793061633116200`;
    expect(nonPostReason({ ts: "1793061633.116200", permalink, text: "You won't see this prompt again.", hasBody: true })).toBe(
      "slack_ui_notice",
    );
    expect(nonPostReason({ ts: "1793061633.116200", permalink, text: "You won’t see this prompt again", hasBody: true })).toBe(
      "slack_ui_notice",
    );
  });
  test("spons-capital-one 1793786567.074499 (2026-11-07 sync): Slack's \"Upgrade to reconnect this channel\" banner", () => {
    const permalink = `${W}/C0C6HQPNJET/p1793786567074499`;
    const text = "Upgrade to reconnect this channel\n\nYour trial has ended. Capital One has been removed from this channel. To automatically reconnect this channel, upgrade to a paid plan by Sunday, November 8th.";
    expect(nonPostReason({ ts: "1793786567.074499", permalink, text, hasBody: true })).toBe("slack_banner");
    expect(nonPostReason({ ts: "1793786567.074499", permalink, text: "Your trial has ended. Upgrade to keep using Slack Connect.", hasBody: true })).toBe("slack_banner");
    // A person talking about it is a post.
    expect(nonPostReason({ ts: "1793786567.074499", permalink, text: "Did anyone else see the upgrade to reconnect this channel message?", hasBody: true })).toBeNull();
  });
  test("real posts pass, including grouped posts and image-only posts with a permalink", () => {
    const permalink = `${W}/C0C6X7DK13Q/p1792825421745369`;
    expect(nonPostReason({ ts: "1792825421.745369", permalink, text: "And since you mentioned OpenAI…", hasBody: true })).toBeNull();
    expect(nonPostReason({ ts: "1792825421.745369", permalink, text: "", hasBody: false })).toBeNull();
    expect(nonPostReason({ ts: "1792825421.745369", permalink, text: "Will we see this prompt again?", hasBody: true })).toBeNull();
  });
});

describe("broadcastParent", () => {
  test("spons-cartesia 1792882762.278609: reply also sent to the channel", () => {
    expect(broadcastParent(`${W}/C0C72S4D3LL/p1792882762278609?thread_ts=1792867132.187939&cid=C0C72S4D3LL`, "1792882762.278609")).toBe(
      "1792867132.187939",
    );
  });
  test("plain posts and thread parents aren't broadcasts", () => {
    expect(broadcastParent(`${W}/C0C7TCNCR1N/p1792819005075629`, "1792819005.075629")).toBeNull();
    expect(broadcastParent(`${W}/C0C7TCNCR1N/p1792819005075629?thread_ts=1792819005.075629&cid=C0C7TCNCR1N`, "1792819005.075629")).toBeNull();
  });
});

describe("normalizeCapture (captures made before the rules)", () => {
  const cid = "C0C7TCNCR1N";
  const m = (ts: string, permalink: string, text: string): Message => ({
    id: messageId(cid, ts),
    channel_id: cid,
    channel_name: "0-announcements",
    ts,
    author_name: ts === LIST_TOP_TS ? "" : "Charlie [Cal Hacks]",
    text,
    links: [],
    permalink,
    captured_at: "2026-10-27T12:00:00.000Z",
    run_id: "r",
  });
  const cap: CaptureFile = {
    schema_version: 1,
    run_id: "r",
    source: "extension",
    channel_id: cid,
    channel_name: "0-announcements",
    started_at: "2026-10-27T12:00:00.000Z",
    finished_at: "2026-10-27T12:00:26.000Z",
    stop_reason: "no_new_keys",
    scroll_steps: 20,
    system_rows_skipped: 0,
    unresolved_authors: [LIST_TOP_TS],
    messages: [
      m(LIST_TOP_TS, "", ""),
      m("1792819005.075629", `${W}/${cid}/p1792819005075629`, "Welcome to Cal Hacks!"),
      m("1792871287.546279", `${W}/${cid}/p1792871287546279?thread_ts=1792819005.075629&cid=${cid}`, "@channel Welcome to Day 2."),
    ],
  };

  test("drops the non-post, marks the broadcast, and keeps counts consistent", () => {
    const { capture, dropped } = normalizeCapture(cap);
    expect(dropped).toEqual([{ ts: LIST_TOP_TS, reason: "list_top" }]);
    expect(capture.messages.map((x) => [x.ts, x.subtype, x.thread_ts])).toEqual([
      ["1792819005.075629", undefined, undefined],
      ["1792871287.546279", "thread_broadcast", "1792819005.075629"],
    ]);
    expect(capture.system_rows_skipped).toBe(1);
    expect(capture.non_posts_skipped).toEqual({ list_top: 1 });
    expect(capture.unresolved_authors).toEqual([]);
  });

  test("is idempotent", () => {
    const once = normalizeCapture(cap).capture;
    const twice = normalizeCapture(once);
    expect(twice.dropped).toEqual([]);
    expect(twice.capture).toEqual(once);
  });
});
