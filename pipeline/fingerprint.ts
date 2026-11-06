// The v1 Claim board's fingerprint (v2 D14): what board.json says, with every piece of workspace text
// replaced by a short hash, so it can be checked into git. Ids, counts, times, amounts and sponsor names
// (all from tracked config or numbers) stay readable; titles, excerpts, codes, links and how-to text are
// hashed. pipeline/fingerprint.test.ts compares each build with the checked-in fingerprint.
//
// Regenerate after an approved change (and list it in ALLOWED in the test):
//   bun pipeline/fingerprint.ts events/calhacks-13
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardData } from "./board.ts";
import { BOARD_DATA_PATH } from "./event.ts";

export const FINGERPRINT_FILE = "board.fingerprint.json";

const h = (s: string | null | undefined) => (s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : "");

export function fingerprint(b: BoardData) {
  return {
    event: b.event,
    timezone: b.timezone,
    channels: b.channels,
    post_count: b.posts.length,
    posts: h(b.posts.join(",")),
    frames: b.frames,
    offers: b.offers.map((o) => ({
      id: o.id,
      sponsor: o.sponsor,
      title: h(o.title),
      value_short: h(o.value_short),
      claim_short: h(o.claim_short),
      amount_text: h(o.amount_text),
      usd: o.usd,
      limit: o.limit,
      limit_unclear: o.limit_unclear,
      claim_url: h(o.claim_url),
      promo_code: h(o.promo_code),
      claim_how: h(o.claim_how),
      first: o.first,
      excerpt: h(o.excerpt),
      posts: o.posts.map((p) => ({ ts: p.ts, channel: p.channel, permalink: h(p.permalink) })),
    })),
    reps: b.reps,
    event_deadlines: b.event_deadlines.map((d) => ({ ...d, source: h(d.source) })),
    // basis.written_at is excluded: it's when the grouping ran, not what the board shows (D10).
    basis: { grouping: b.basis.grouping, model: b.basis.model },
  };
}

export type Fingerprint = ReturnType<typeof fingerprint>;

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun pipeline/fingerprint.ts events/<slug>");
    process.exit(2);
  }
  const fp = fingerprint(JSON.parse(readFileSync(join(dir, BOARD_DATA_PATH), "utf8")) as BoardData);
  writeFileSync(join(dir, FINGERPRINT_FILE), JSON.stringify(fp, null, 1) + "\n");
  console.log(`wrote ${join(dir, FINGERPRINT_FILE)}: ${fp.offers.length} offers, ${fp.post_count} posts`);
}
