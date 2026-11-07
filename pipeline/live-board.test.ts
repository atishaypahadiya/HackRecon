// P6's gate (design doc §4, D5): a synthetic sync diff, with a deadline moved earlier, a session in 45 min and a new
// offer, read through board/live.js as the page reads it.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BOARD_PAGE } from "./board.ts";

type Row = { section: string; key: string; label: string; at: number | null; was?: Row };
type Diff = { added: Row[]; changed: Row[]; removed: Row[]; count: number };
let L: {
  diff: (a: unknown, b: unknown) => Diff;
  urgent: (d: Diff, a: unknown, b: unknown, now: number) => { why: string; key: string; label: string; at: number | null; was?: number }[];
  present: (shown: Plan, next: Plan) => Plan;
};
beforeAll(async () => {
  await import("../board/live.js");
  L = (globalThis as unknown as { HRLive: typeof L }).HRLive;
});

const NOW = Date.parse("2026-10-25T07:30:00-07:00");
const credit = (offer_id: string, value: string, limit: number | null = null) => ({ offer_id, sponsor: "Apify", why: ["you use Apify"], value, quote: value, limit, limit_unclear: false, claim: "", claim_url: "", promo_code: "", first: 1, source_url: `https://x.slack.com/p${offer_id}` });
const session = (start: string, quote: string, source_url = "https://x.slack.com/p1") => ({ sponsor: "Fetch.ai", why: ["you use Fetch.ai"], start, quote, source_url });
const track = (track_id: string, name: string, reason = "fits") => ({ track_id, name, fit: "likely", reason, label: null, steps: [], quote: name });
type Plan = { tracks: ReturnType<typeof track>[]; credits: { credits: ReturnType<typeof credit>[] }; sessions: { sessions: ReturnType<typeof session>[] }; people: { people: unknown[] } };

const before: Plan = {
  tracks: [track("t:a", "Best Use of Apify"), track("t:b", "Best Use of Fetch.ai")],
  credits: { credits: [credit("o:1", "$50 Apify credit")] },
  sessions: { sessions: [session("2026-10-25T10:00:00-07:00", "Fetch.ai office hours at 10am")] },
  people: { people: [] },
};
// The sync: the office hours moved up to 8:15 (45 min away), a new offer, the Fetch.ai track ranked first now.
const after: Plan = {
  tracks: [track("t:b", "Best Use of Fetch.ai", "fits better"), track("t:a", "Best Use of Apify")],
  credits: { credits: [credit("o:2", "$100 Fetch.ai credit"), credit("o:1", "$50 Apify credit")] },
  sessions: { sessions: [session("2026-10-25T08:15:00-07:00", "Fetch.ai office hours moved to 8:15am")] },
  people: { people: [] },
};
const metaBefore = { deadlines: [{ id: "schedule:0", name: "Final Devpost submissions due", at: "2026-10-25T09:30:00-07:00" }] };
const metaAfter = { deadlines: [{ id: "schedule:1", name: "Devpost submission deadline moved up", at: "2026-10-25T09:00:00-07:00" }] };

describe("a synthetic sync diff", () => {
  test("the new offer is added; the session and the re-reasoned track changed; nothing is gone", () => {
    const d = L.diff(before, after);
    expect(d.added.map((r) => [r.section, r.key])).toEqual([["credits", "o:2"]]);
    expect(d.changed.map((r) => [r.section, r.label])).toEqual([["tracks", "Best Use of Fetch.ai"], ["sessions", "Fetch.ai office hours moved to 8:15am"]]);
    expect(d.changed[1]!.was!.at).toBe(Date.parse("2026-10-25T10:00:00-07:00"));
    expect([d.removed, d.count]).toEqual([[], 3]);
  });
  test("urgent: the deadline moved earlier (a renamed schedule entry), and the session 45 minutes away; the new offer queues", () => {
    const u = L.urgent(L.diff(before, after), metaBefore, metaAfter, NOW);
    expect(u.map((x) => [x.why, x.label])).toEqual([["earlier", "Devpost submission deadline moved up"], ["starts soon", "Fetch.ai office hours moved to 8:15am"]]);
    expect(u[0]!.was).toBe(Date.parse("2026-10-25T09:30:00-07:00"));
    // The same sync three hours earlier: the session is no longer within the hour.
    expect(L.urgent(L.diff(before, after), metaBefore, metaAfter, NOW - 3 * 3600_000).map((x) => x.why)).toEqual(["earlier"]);
  });
  test("a deadline moved later is not urgent; a post saying cancelled is, whenever it is", () => {
    expect(L.urgent(L.diff(before, before), metaAfter, metaBefore, NOW)).toEqual([]);
    const cancelled = { ...before, sessions: { sessions: [session("2026-10-25T14:00:00-07:00", "Fetch.ai office hours are cancelled")] } };
    expect(L.urgent(L.diff(before, cancelled), metaBefore, metaBefore, NOW).map((x) => x.why)).toEqual(["cancelled"]);
  });
  test("while updates wait, nothing reorders: changed rows keep their place, the new offer goes last, a gone row stays", () => {
    const p = L.present(before, after);
    expect(p.tracks.map((t) => [t.track_id, t.reason])).toEqual([["t:a", "fits"], ["t:b", "fits better"]]);
    expect(p.credits.credits.map((c) => c.offer_id)).toEqual(["o:1", "o:2"]);
    expect(p.sessions.sessions.map((s) => s.quote)).toEqual(["Fetch.ai office hours moved to 8:15am"]);
    const gone = L.present(before, { ...after, credits: { credits: [] } });
    expect(gone.credits.credits.map((c) => c.offer_id)).toEqual(["o:1"]);
  });
  test("the page inlines live.js", () => {
    expect(readFileSync(BOARD_PAGE, "utf8")).toContain("<!-- live.js -->");
  });
});
