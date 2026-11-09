import { describe, expect, test } from "bun:test";
import { COLUMNS, type LabelRow } from "./labels.ts";
import type { Sponsors } from "./pool.ts";
import { creditOffers, deadlineKeys, formatPreview, preview, repCandidates, urlMerge, type CreditOffer } from "./preview.ts";
import type { Item, Message } from "./schema.ts";

const item = (message_id: string, o: Partial<Item> = {}): Item => ({
  message_id,
  item_index: 0,
  kind: "credit",
  sponsor: "Acme",
  offer_key: "",
  amount_text: "$50 credits",
  amount_unit: "USD",
  amount_basis: "per_person",
  amount_usd_per_person: 50,
  deadline_status: "none",
  urls: [],
  model: "m",
  classified_at: "t",
  ...o,
});
const label = (message_id: string, o: Partial<LabelRow>): LabelRow => ({
  ...(Object.fromEntries(COLUMNS.map((c) => [c, ""])) as LabelRow),
  message_id,
  sponsor: "Acme",
  labeler: "opus-5-5",
  ...o,
});
const offer = (o: Partial<CreditOffer>): CreditOffer => ({
  message_id: "C1:1",
  ts: "1",
  sponsor: "Acme",
  permalink: "p",
  amount_text: "",
  limit_unresolved: false,
  urls: [],
  source: "classifier",
  ...o,
});

describe("creditOffers: classifier items with the Opus label overlaid (what hr sheet pre-fills)", () => {
  test("a 'not a credit' label drops the items; a single-credit label supplies amount and limit; a missed credit is added", () => {
    const items = [
      item("C1:1"),
      item("C1:2", { amount_usd_per_person: undefined, amount_basis: "unknown", urls: ["https://a.dev/x"] }),
      item("C1:4", { amount_usd_per_person: undefined, amount_basis: "pool" }),
    ];
    const labels = [
      label("C1:1", { is_credit: "n", is_dated: "n" }),
      label("C1:2", { is_credit: "y", is_dated: "y", credits_in_post: "1", amount_text: "$20", amount_usd_per_person: "20", amount_basis: "per_person", window_end: "2026-10-24T19:00-07:00", deadline_status: "none" }),
      label("C1:3", { is_credit: "y", is_dated: "n", credits_in_post: "1", amount_basis: "unknown", amount_text: "credits" }),
      label("C1:9", { is_credit: "y" }), // incomplete: ignored
    ];
    const r = creditOffers(items, labels, new Map());
    expect(r.dropped_by_label).toBe(1);
    expect(r.added_by_label).toBe(1);
    const by = new Map(r.offers.map((o) => [o.message_id, o]));
    expect(by.has("C1:1")).toBe(false);
    expect(by.get("C1:2")).toMatchObject({ usd_per_person: 20, limit_iso: "2026-10-24T19:00-07:00", urls: ["https://a.dev/x"], source: "opus label" });
    expect(by.get("C1:3")).toMatchObject({ source: "opus label" });
    expect(by.get("C1:3")!.usd_per_person).toBeUndefined();
    expect(by.get("C1:4")).toMatchObject({ source: "classifier" });
  });
});

describe("urlMerge", () => {
  test("merges offers sharing a URL within a sponsor, transitively; first priced amount by time wins", () => {
    const g = urlMerge([
      offer({ message_id: "a", ts: "3", urls: ["u1"], usd_per_person: 40 }),
      offer({ message_id: "b", ts: "1", urls: ["u1", "u2"] }),
      offer({ message_id: "c", ts: "2", urls: ["u2"], usd_per_person: 30 }),
      offer({ message_id: "d", ts: "4", urls: ["u1"], sponsor: "Other" }),
      offer({ message_id: "e", ts: "5" }),
    ]);
    expect(g).toHaveLength(3);
    const merged = g.find((x) => x.offers.length === 3)!;
    expect(merged.offers.map((o) => o.message_id)).toEqual(["b", "c", "a"]);
    expect(merged.usd_per_person).toBe(30);
    expect(merged.amount_conflict).toBe(true);
  });
});

describe("deadlineKeys (K)", () => {
  test("same sponsor and deadline within 30 minutes count once; start times never count", () => {
    const k = deadlineKeys([
      item("a", { kind: "deadline", deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "explicit" }),
      item("b", { kind: "deadline", deadline_iso: "2026-10-25T09:10:00-07:00", deadline_status: "explicit" }),
      item("c", { kind: "deadline", sponsor: "Other", deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "explicit" }),
      item("d", { kind: "workshop", event_start_iso: "2026-10-24T18:00:00-07:00" }),
    ]);
    expect(k).toBe(2);
  });
});

describe("repCandidates and preview", () => {
  const sponsors = {
    "spons-acme": { sponsor: "Acme", kind: "sponsor", aliases: [] },
    "0-announcements": { sponsor: "event", kind: "event", aliases: [] },
  } as Sponsors;
  const msg = (id: string, channel: string, author: string): Message =>
    ({ id, channel_id: "C", channel_name: channel, ts: id.split(":")[1]!, author_name: author, author_id: `U${author.split(" ")[0]}`, text: "", links: [], permalink: `p/${id}`, captured_at: "", run_id: "r" }) as Message;
  const messages = [msg("C:1", "spons-acme", "Ann (Acme)"), msg("C:2", "spons-acme", "Ann (Acme)"), msg("C:3", "0-announcements", "Bo (Acme)"), msg("C:4", "spons-acme", "Hacker")];
  const role = (m: Message): "sponsor-side" | "other" => (m.author_name.includes("Acme") ? "sponsor-side" : "other");

  test("distinct sponsor-side posters in sponsor channels; event channels don't count", () => {
    expect(repCandidates(messages, sponsors, role)).toEqual({ candidates: 1, sponsors: 1 });
  });

  test("totals: only stated per-person amounts are summed; event isn't a sponsor", () => {
    const p = preview({
      items: [item("C:1"), item("C:4", { amount_usd_per_person: undefined, amount_basis: "up_to", deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "explicit" })],
      labels: [],
      messages,
      sponsors,
      channels: ["spons-acme", "0-announcements"],
      role,
    });
    expect(p).toMatchObject({ channels: 2, sponsors_in_capture: 1, offers: 2, priced: 1, unpriced: 1, usd_total: 50, with_limit: 1, no_limit: 1, sponsors_with_credit: 1 });
    const text = formatPreview(p, "test", "America/Los_Angeles");
    expect(text).toContain("RECEIPT PREVIEW (not the receipt)");
    expect(text).toContain("$ total of priced per-person offers        $50");
    expect(text).toContain('$50  Acme  "$50 credits"  p/C:1');
  });
});
