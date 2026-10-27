import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, readTable, toCsv } from "./csv.ts";
import { COLUMNS, labelProblems, readLabels, type LabelRow } from "./labels.ts";
import { buildRows, KEYWORD_RE, selectPool, withFlagged, writeSheet, type Candidate, type Sponsors } from "./pool.ts";
import { messageId, type Message } from "./schema.ts";
import { tsToEventIso, tsToEventIsoWithDay } from "./time.ts";

describe("csv", () => {
  test("round-trips quotes, commas, newlines and emoji", () => {
    const rows = [
      ["a", "b"],
      ['say "hi", then', "line one\nline two :tada: 🎉"],
      [" padded", ""],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
  test("readTable reads by header and skips blank rows", () => {
    expect(readTable("x,y\r\n1,2\r\n,\r\n")).toEqual([{ x: "1", y: "2" }]);
    expect(() => readTable("x\n1\n", ["x", "y"])).toThrow("missing columns: y");
  });
});

describe("event time", () => {
  test("ts → America/Los_Angeles with offset (PDT in October 2026; checked against `date -r`)", () => {
    expect(tsToEventIso("1792918203.114859")).toBe("2026-10-25T01:50:03-07:00");
    expect(tsToEventIsoWithDay("1792943981.782739")).toBe("2026-10-25T08:59:41-07:00 (Sunday)");
  });
});

describe("KEYWORD_RE (design doc keyword list)", () => {
  test.each([
    "$50 in credits for every hacker",
    "use promo code CALHACKS",
    "RSVP here",
    "submit by Sunday 9am",
    "applications close by 5pm",
    "free food tonight",
  ])("hits: %s", (t) => expect(KEYWORD_RE.test(t)).toBe(true));
  test.each(["Welcome to the channel!", "great question, ask in #help", "stand by"])("misses: %s", (t) => expect(KEYWORD_RE.test(t)).toBe(false));
});

const cand = (n: number, text: string, cls: Candidate["cls"] = "real", channel = "spons-a"): Candidate => {
  const ts = `17928${String(n).padStart(5, "0")}.000000`;
  return { id: messageId("C1", ts), channel_id: "C1", channel, ts, cls, text, author: "Ada" };
};

describe("selectPool", () => {
  const cands = [
    cand(1, "$25 credits for everyone"),
    cand(2, "hello"),
    cand(3, "more credits in thread", "broadcast"),
    cand(4, "a broadcast without keywords", "broadcast"),
    ...Array.from({ length: 40 }, (_, i) => cand(10 + i, `chatter ${i}`)),
  ];

  test("keyword hits include broadcasts; random draws only real top-level non-hits", () => {
    const s = selectPool(cands, 7, 5);
    expect(s.keyword.map((c) => c.text)).toEqual(["$25 credits for everyone", "more credits in thread"]);
    expect(s.random).toHaveLength(5);
    expect(s.random.every((c) => c.cls === "real" && !KEYWORD_RE.test(c.text))).toBe(true);
  });

  test("deterministic for a seed, different for another", () => {
    const ids = (seed: number) => selectPool(cands, seed, 5).random.map((c) => c.id);
    expect(ids(7)).toEqual(ids(7));
    expect(ids(7)).not.toEqual(ids(8));
  });

  test("random picks already in the sheet are kept, then topped up", () => {
    const keep = new Set([cands[10]!.id, cands[20]!.id]);
    const r = selectPool(cands, 99, 5, keep).random.map((c) => c.id);
    expect(r.slice(0, 2)).toEqual([cands[10]!.id, cands[20]!.id]);
    expect(new Set(r).size).toBe(5);
  });
});

describe("miss checks are blinded in the sheet", () => {
  test("random and flagged rows both show pool = miss_check; flagged skips hits and random picks", () => {
    const cands = [cand(1, "$5 credits"), cand(2, "see you at the booth"), cand(3, "booth closes soon-ish"), cand(4, "hi")];
    const base = { keyword: [cands[0]!], random: [cands[3]!], flagged: [] };
    const sel = withFlagged(base, cands, new Set([cands[0]!.id, cands[1]!.id, cands[3]!.id]));
    expect(sel.flagged.map((c) => c.id)).toEqual([cands[1]!.id]);
    const sponsors: Sponsors = { "spons-a": { sponsor: "A", kind: "sponsor", aliases: [] } };
    const { rows } = buildRows(sel, { sponsors, captured: new Map(), workspace: "https://w", existing: [] });
    expect(rows.map((r) => r.pool)).toEqual(["keyword", "miss_check", "miss_check"]);
  });
});

describe("buildRows", () => {
  const sponsors: Sponsors = {
    "0-announcements": { sponsor: "event", kind: "event", aliases: [] },
    "spons-a": { sponsor: "A Corp", kind: "sponsor", aliases: [] },
  };
  const a = cand(2, "$10 credits");
  const b = { ...cand(1, "deadline tonight", "real", "0-announcements"), channel_id: "C0", id: messageId("C0", cand(1, "").ts) };
  const captured = new Map<string, Message>([
    [
      a.id,
      {
        id: a.id,
        channel_id: "C1",
        channel_name: "spons-a",
        ts: a.ts,
        author_name: "Ada [A Corp]",
        text: "$10 credits <https://a.dev/claim>",
        links: ["https://a.dev/claim"],
        permalink: "https://w.slack.com/archives/C1/p1792800002000000",
        captured_at: "2026-10-27T12:00:00.000Z",
        run_id: "day1",
      },
    ],
  ]);

  test("sponsors.json order, capture text when captured, baseline text and a built permalink when not", () => {
    const { rows } = buildRows({ keyword: [a, b], random: [], flagged: [] }, { sponsors, captured, workspace: "https://w.slack.com", existing: [] });
    expect(rows.map((r) => [r.channel, r.in_capture, r.text, r.author, r.permalink])).toEqual([
      ["0-announcements", "n", "deadline tonight", "Ada", "https://w.slack.com/archives/C0/p1792800001000000"],
      ["spons-a", "y", "$10 credits <https://a.dev/claim>", "Ada [A Corp]", "https://w.slack.com/archives/C1/p1792800002000000"],
    ]);
  });

  test("re-running keeps every label column; labeled rows that left the pool are kept, not dropped", () => {
    const first = buildRows({ keyword: [a, b], random: [], flagged: [] }, { sponsors, captured, workspace: "https://w.slack.com", existing: [] }).rows;
    first[1]!.is_credit = "y";
    first[1]!.amount_usd_per_person = "10";
    first[1]!.amount_basis = "per_person";
    first[0]!.notes = "checked";
    const again = buildRows({ keyword: [a], random: [], flagged: [] }, { sponsors, captured, workspace: "https://w.slack.com", existing: first });
    expect(again.rows[0]).toMatchObject({ message_id: a.id, is_credit: "y", amount_usd_per_person: "10", amount_basis: "per_person" });
    expect(again.orphans.map((r) => [r.message_id, r.notes])).toEqual([[b.id, "checked"]]);

    const dir = mkdtempSync(join(tmpdir(), "hr-pool-"));
    const path = join(dir, "labels.csv");
    writeSheet(path, [...again.rows, ...again.orphans]);
    expect(parseCsv(readFileSync(path, "utf8"))[0]).toEqual([...COLUMNS]);
    expect(readLabels(path)).toEqual([...again.rows, ...again.orphans]);
  });
});

describe("labelProblems", () => {
  const row = (o: Partial<LabelRow>): LabelRow => ({ ...(Object.fromEntries(COLUMNS.map((c) => [c, ""])) as LabelRow), ...o });

  test("unlabeled and well-formed rows pass", () => {
    expect(labelProblems(row({}))).toEqual([]);
    expect(
      labelProblems(
        row({
          is_credit: "y",
          is_dated: "y",
          exclude: "n",
          credits_in_post: "1",
          amount_text: "$50 in credits",
          amount_usd_per_person: "50",
          amount_basis: "per_person",
          deadline_iso: "2026-10-25T09:00-07:00",
          deadline_status: "explicit",
        }),
      ),
    ).toEqual([]);
    expect(labelProblems(row({ is_credit: "y", credits_in_post: "1", is_dated: "y", deadline_status: "unresolved" }))).toEqual([]);
    expect(labelProblems(row({ is_credit: "y", credits_in_post: "1", is_dated: "y", window_end: "2026-10-24T19:00-07:00", deadline_status: "none" }))).toEqual([]);
    expect(labelProblems(row({ is_credit: "n", is_dated: "y", deadline_status: "none" }))).toEqual(["is_dated = y but deadline_status = none and no window_end"]);
  });

  test("catches the mistakes the gate can't score", () => {
    expect(labelProblems(row({ is_credit: "yes" }))).toEqual(["is_credit must be y or n"]);
    expect(labelProblems(row({ amount_usd_per_person: "$50", amount_basis: "per_team" }))).toEqual([
      "amount_usd_per_person must be a plain number (no $)",
      "amount_usd_per_person is set only when amount_basis = per_person",
    ]);
    expect(labelProblems(row({ deadline_iso: "Oct 25 9am", deadline_status: "explicit", is_dated: "y" }))).toEqual([
      "deadline_iso must look like 2026-10-25T09:00-07:00",
    ]);
    expect(labelProblems(row({ is_dated: "n", window_end: "2026-10-24T19:00-07:00" }))).toEqual(["is_dated = n but a deadline or window_end is filled"]);
    expect(labelProblems(row({ is_credit: "y" }))).toEqual(["is_credit = y needs credits_in_post 1 or more"]);
  });
});
