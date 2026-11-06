// D14: v2 must not quietly change v1's Claim board. Every build of Cal Hacks' board.json must match the
// checked-in fingerprint, field by field, except the differences listed in ALLOWED, each with the
// decision that allows it. board.json is gitignored, so on a clean checkout this is skipped, loudly.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardData } from "./board.ts";
import { BOARD_DATA_PATH, EVENTS_DIR } from "./event.ts";
import { fingerprint, FINGERPRINT_FILE, type Fingerprint } from "./fingerprint.ts";

const DIR = join(EVENTS_DIR, "calhacks-13");
const BOARD = join(DIR, BOARD_DATA_PATH);

/** Top-level fingerprint fields allowed to differ from the checked-in v1 fingerprint, with the decision. */
const ALLOWED: Partial<Record<keyof Fingerprint, string>> = {};

const hasBoard = existsSync(BOARD);
if (!hasBoard) console.warn(`SKIPPED D14 Claim regression: ${BOARD} not found (gitignored workspace data). Run \`bun run hr board --build-only\`.`);

describe.skipIf(!hasBoard)("v1 Claim board fingerprint (D14)", () => {
  const want = JSON.parse(readFileSync(join(DIR, FINGERPRINT_FILE), "utf8")) as Fingerprint;
  const got = fingerprint(JSON.parse(readFileSync(BOARD, "utf8")) as BoardData);

  for (const key of Object.keys(want) as (keyof Fingerprint)[]) {
    test(ALLOWED[key] ? `${key} (allowed to differ: ${ALLOWED[key]})` : `${key} unchanged`, () => {
      if (!ALLOWED[key]) expect(got[key]).toEqual(want[key]);
    });
  }

  test("no new top-level fields without a decision", () => {
    expect(Object.keys(got).filter((k) => !(k in want) && !ALLOWED[k as keyof Fingerprint])).toEqual([]);
  });
});
