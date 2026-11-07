// D14: v2 must not quietly change v1's Claim board. Every build of Cal Hacks' board.json must match the
// checked-in fingerprint, field by field, except the differences listed in ALLOWED, each with the
// decision that allows it. board.json is gitignored, so on a clean checkout this is skipped, loudly.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardData } from "./board.ts";
import { BOARD_DATA_PATH, EVENTS_DIR } from "./event.ts";
import { fingerprint, FINGERPRINT_FILE, FINGERPRINT_KEY_PATH, readFingerprintKey, type Fingerprint } from "./fingerprint.ts";

const DIR = join(EVENTS_DIR, "calhacks-13");
const BOARD = join(DIR, BOARD_DATA_PATH);

/** Top-level fingerprint fields allowed to differ from the checked-in v1 fingerprint, with the decision. */
const ALLOWED: Partial<Record<keyof Fingerprint, string>> = {};
/** Field-level differences inside a field that is otherwise compared exactly, with the decision. */
const ALLOWED_WITHIN = {
  "offers[].id": "OV5 (D21): ids come from each offer's first post; compared through board.json's v1_ids map",
  "offers[].excerpt": "user 2026-11-07: quotes show the post as written, names included (v1 redacted them); every other offer field is still exact",
};

const key = readFingerprintKey(DIR);
const ready = existsSync(BOARD) && key !== null;
if (!ready)
  console.warn(`SKIPPED D14 Claim regression: ${existsSync(BOARD) ? join(DIR, FINGERPRINT_KEY_PATH) : BOARD} not found (gitignored workspace data). Run \`bun run hr board --build-only\`.`);

// describe.skipIf would still run the body, which reads the missing files; a skipped placeholder counts it instead.
if (!ready) test.skip("v1 Claim board fingerprint (D14)", () => {});
else describe("v1 Claim board fingerprint (D14)", () => {
  const want = JSON.parse(readFileSync(join(DIR, FINGERPRINT_FILE), "utf8")) as Fingerprint;
  const board = JSON.parse(readFileSync(BOARD, "utf8")) as BoardData;
  const got = fingerprint(board, key!);
  // OV5: translate today's ids back to v1's, so every other offer field is still compared exactly.
  const toV1 = new Map(Object.entries(board.v1_ids ?? {}).map(([v1, id]) => [id, v1]));
  got.offers = got.offers.map((o) => ({ ...o, id: toV1.get(o.id) ?? o.id }));

  test(`offer ids are first-post ids (allowed to differ: ${ALLOWED_WITHIN["offers[].id"]})`, () => {
    for (const o of board.offers) {
      const p = o.posts.reduce((a, b) => (b.ts < a.ts ? b : a));
      expect(o.id).toMatch(new RegExp(`^o-${p.channel}-${/\/p(\d{16})/.exec(p.permalink)?.[1] ?? "\\d+"}(~\\d+)?$`));
    }
    expect(toV1.size).toBe(board.offers.length);
  });

  for (const field of Object.keys(want) as (keyof Fingerprint)[]) {
    test(ALLOWED[field] ? `${field} (allowed to differ: ${ALLOWED[field]})` : `${field} unchanged`, () => {
      if (ALLOWED[field]) return;
      if (field !== "offers") return expect(got[field]).toEqual(want[field]);
      const noExcerpt = (xs: Fingerprint["offers"]) => xs.map(({ excerpt: _, ...o }) => o);
      expect(noExcerpt(got.offers)).toEqual(noExcerpt(want.offers));
    });
  }

  test("no new top-level fields without a decision", () => {
    expect(Object.keys(got).filter((k) => !(k in want) && !ALLOWED[k as keyof Fingerprint])).toEqual([]);
  });
});
