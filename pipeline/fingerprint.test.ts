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

const key = readFingerprintKey(DIR);
const ready = existsSync(BOARD) && key !== null;
if (!ready)
  console.warn(`SKIPPED D14 Claim regression: ${existsSync(BOARD) ? join(DIR, FINGERPRINT_KEY_PATH) : BOARD} not found (gitignored workspace data). Run \`bun run hr board --build-only\`.`);

describe.skipIf(!ready)("v1 Claim board fingerprint (D14)", () => {
  const want = JSON.parse(readFileSync(join(DIR, FINGERPRINT_FILE), "utf8")) as Fingerprint;
  const got = fingerprint(JSON.parse(readFileSync(BOARD, "utf8")) as BoardData, key!);

  for (const field of Object.keys(want) as (keyof Fingerprint)[]) {
    test(ALLOWED[field] ? `${field} (allowed to differ: ${ALLOWED[field]})` : `${field} unchanged`, () => {
      if (!ALLOWED[field]) expect(got[field]).toEqual(want[field]);
    });
  }

  test("no new top-level fields without a decision", () => {
    expect(Object.keys(got).filter((k) => !(k in want) && !ALLOWED[k as keyof Fingerprint])).toEqual([]);
  });
});
