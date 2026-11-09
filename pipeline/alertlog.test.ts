import { describe, expect, test } from "bun:test";
import { alertCategory, alertOutcomes, alertSends, outcomeSummary, type AlertSend } from "./alertlog.ts";
import type { Alert, Notice } from "./alerts.ts";
import type { ChatTurn } from "./agent.ts";
import type { WriteRecord } from "./told.ts";

const alert = (key: string, kind: Alert["kind"], o: Partial<Alert & { queued_at: string }> = {}): Alert & { queued_at: string } => ({
  key, kind, level: "now", what: key, why: "", source: "#announcements", link: "", posted_at: "2026-11-14T17:00:00.000Z", queued_at: "2026-11-14T17:01:00.000Z", ...o,
});
const send = (key: string, sent_at: string, o: Partial<AlertSend> = {}): AlertSend => ({
  key, kind: "deadline", category: "deadline", level: "now", what: key, source: "", posted_at: sent_at, queued_at: sent_at, sent_at, via: "now", batch: 1, status: "sent", ref: key, ...o,
});
const turn = (at: string, q: string, reply_to?: string): ChatTurn => ({ at, q, a: "", status: "answered", ...(reply_to ? { reply_to } : {}) });
const write = (at: string, op: string): WriteRecord => ({ at, source: "chat", quote: null, op, input: {}, result: "" });
const T = (hm: string) => `2026-11-14T${hm}:00.000Z`;

describe("alert categories (user 2026-11-08)", () => {
  test("deadline, workshop, credit, track; other keeps the rest; no rule makes intro yet", () => {
    expect(alertCategory({ kind: "deadline" })).toBe("deadline");
    expect(alertCategory({ kind: "workshop" })).toBe("workshop");
    expect(alertCategory({ kind: "offer", offer_kind: "credit" })).toBe("credit");
    expect(alertCategory({ kind: "tracks" })).toBe("track");
    expect(["change", "submission", "judging", "unread"].map((kind) => alertCategory({ kind: kind as Alert["kind"] }))).toEqual(["other", "other", "other", "other"]);
    expect(alertCategory({ kind: "offer", offer_kind: "job" })).toBe("other");
  });
});

describe("alertSends: one line per alert per message", () => {
  test("each alert in a batched text, with when it was queued and sent, the batch size and the message id", () => {
    const n: Notice = { level: "now", body: "", keys: ["a", "b"], alerts: [alert("a", "judging"), alert("b", "offer", { offer_kind: "credit", queued_at: T("17:05") })] };
    expect(alertSends(n, { at: T("17:20"), level: "now", status: "sent", body: "", channel: "telegram", ref: "42" })).toEqual([
      { key: "a", kind: "judging", category: "other", level: "now", what: "a", source: "#announcements", posted_at: "2026-11-14T17:00:00.000Z", queued_at: "2026-11-14T17:01:00.000Z", sent_at: T("17:20"), via: "now", batch: 2, status: "sent", channel: "telegram", ref: "42" },
      { key: "b", kind: "offer", category: "credit", level: "now", what: "b", source: "#announcements", posted_at: "2026-11-14T17:00:00.000Z", queued_at: T("17:05"), sent_at: T("17:20"), via: "now", batch: 2, status: "sent", channel: "telegram", ref: "42" },
    ]);
  });
});

describe("alertOutcomes: what the user did within 30 minutes", () => {
  const sends = [
    send("d", T("17:00"), { ref: "10" }),
    send("w", T("17:10"), { kind: "workshop", category: "workshop", ref: "11" }),
    send("c", T("18:00"), { kind: "offer", category: "credit", ref: "12" }),
    send("f", T("19:00"), { status: "failed", ref: undefined }),
    send("f", T("19:10"), { ref: "13" }),
    send("open", T("20:00")),
  ];
  const turns = [turn(T("17:12"), "when is dinner?"), turn(T("17:20"), "thanks", "10"), turn(T("18:40"), "too late")];
  const writes = [write(T("18:05"), "mark_claimed"), write(T("18:06"), "set_entered asked"), write(T("18:50"), "tick_ship_item")];
  const o = alertOutcomes(sends, turns, writes, Date.parse(T("20:10")));

  test("a reply to the alert's own message beats an earlier message; otherwise the first message in the window", () => {
    expect(o.find((x) => x.key === "d")!.responded).toEqual({ at: T("17:20"), minutes: 20, reply: true, text: "thanks" });
    expect(o.find((x) => x.key === "w")!.responded).toEqual({ at: T("17:12"), minutes: 2, reply: false, text: "when is dinner?" });
  });
  test("acted: writes within 30 minutes, not a question asked back or a cancel; none after the window", () => {
    expect(o.find((x) => x.key === "c")!.acted).toEqual([{ at: T("18:05"), minutes: 5, op: "mark_claimed", source: "chat", result: "" }]);
    expect(o.find((x) => x.key === "c")!.responded).toBeNull();
  });
  test("sent alerts only, once each (a failed attempt then a send counts the send); an open window says so", () => {
    expect(o.map((x) => [x.key, x.sent_at, x.window_closed])).toEqual([["d", T("17:00"), true], ["w", T("17:10"), true], ["c", T("18:00"), true], ["f", T("19:10"), true], ["open", T("20:00"), false]]);
  });
  test("per category, closed windows only", () => {
    const s = Object.fromEntries(outcomeSummary(o).map((x) => [x.category, [x.sent, x.closed, x.responded, x.replied, x.acted]]));
    expect(s).toEqual({ deadline: [3, 2, 1, 1, 0], workshop: [1, 1, 1, 0, 0], credit: [1, 1, 0, 0, 1], track: [0, 0, 0, 0, 0], intro: [0, 0, 0, 0, 0], other: [0, 0, 0, 0, 0] });
  });
});
