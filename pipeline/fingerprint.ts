// The v1 Claim board's fingerprint (v2 D14): what board.json says, with every piece of workspace text
// replaced by a short keyed hash (HMAC-SHA256), so it can be checked into git. Ids, counts, times, amounts
// and names from tracked config stay readable; titles, excerpts, codes, links and how-to text are hashed
// with a per-event key kept in the gitignored data/ dir, so a short promo code can't be guessed back from
// the committed digest. pipeline/fingerprint.test.ts compares each build with the checked-in fingerprint.
//
// Regenerate after an approved change (and list it in ALLOWED in the test):
//   bun pipeline/fingerprint.ts events/calhacks-13
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardData } from "./board.ts";
import { BOARD_DATA_PATH } from "./event.ts";

export const FINGERPRINT_FILE = "board.fingerprint.json";
/** Event-relative and gitignored (data/): the HMAC key never leaves the machine. */
export const FINGERPRINT_KEY_PATH = "data/fingerprint.key";

export function readFingerprintKey(dir: string, create = false): string | null {
  const p = join(dir, FINGERPRINT_KEY_PATH);
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  if (!create) return null;
  const key = randomBytes(32).toString("hex");
  writeFileSync(p, key + "\n", { mode: 0o600 });
  return key;
}

export function fingerprint(b: BoardData, key: string) {
  const h = (s: string | null | undefined) => (s ? createHmac("sha256", key).update(s).digest("hex").slice(0, 16) : "");
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
    // `what` comes from the tracked event.json; the source permalink is hashed.
    event_deadlines: b.event_deadlines.map((d) => ({ what: d.what, at: d.at, until: d.until, posted: d.posted, source: h(d.source) })),
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
  const fp = fingerprint(JSON.parse(readFileSync(join(dir, BOARD_DATA_PATH), "utf8")) as BoardData, readFingerprintKey(dir, true)!);
  writeFileSync(join(dir, FINGERPRINT_FILE), JSON.stringify(fp, null, 1) + "\n");
  console.log(`wrote ${join(dir, FINGERPRINT_FILE)}: ${fp.offers.length} offers, ${fp.post_count} posts`);
}
