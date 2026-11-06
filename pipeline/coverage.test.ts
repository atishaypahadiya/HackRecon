import { describe, expect, test } from "bun:test";
import { statedPlaces } from "./coverage.ts";

describe("stated places (D15 (2), user 2026-11-06), on Cal Hacks 13.0's own lines", () => {
  test.each([
    ["1st place: $1250 + Interview / 2nd place: $750 + Interview / 3rd place: $500 + Interview / Special Recognition: $250 each", 4],
    ["1st Place: $2,000 / 2nd Place: $1,000 / 3rd, 4th & 5th Place: $500 each", 5],
    ["1st place - $2048, 2nd place - $1,024, 3rd - $512 || Scrabblebot Tournament: 1st place - 1024, 2nd place - 512, 3rd place - $256", 6],
    ["$200 for first 2 teams / $100 for second 2 teams", 2],
    ["Cash prizes of 8000$, 5000$, 3000$ for the top 3 teams and expedited interview process for top 5 teams", 4],
    ["$5000 in Claude credits and 1 year of Claude Max 20x + Office Hours", 0],
    ["Build it on Convex: database, functions, workflows. Be the first to ship.", 0],
  ])("%s → %d", (line, n) => expect(statedPlaces([line])).toBe(n));
});
