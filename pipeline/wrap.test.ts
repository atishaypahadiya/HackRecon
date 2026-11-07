import { describe, expect, test } from "bun:test";
import { wrapLine, wrapText } from "./wrap.ts";

// Undo a wrap: each break plus its continuation indent becomes the one space it replaced.
const unwrap = (s: string, indent: string, hang = 2) => s.split(`\n${indent}${" ".repeat(hang)}`).join(" ");

describe("CLI wrapping", () => {
  const line = `    page (requirement): "We have a Best Actor award for building an actor for this event." We use Apify to scrape campus calendars, club feeds, hackathon listings and university guide pages; does that count?`;
  test("no space or word is lost at a break (the 'actorfor' / 'universityguide' report)", () => {
    for (const width of [30, 41, 57, 80, 100]) {
      const w = wrapLine(line, width);
      expect(unwrap(w, "    ")).toBe(line);
      expect(w).not.toMatch(/actorfor|universityguide/);
      for (const l of w.split("\n")) expect(l.length <= width || !l.trim().includes(" ")).toBe(true);
    }
  });
  test("continuation lines keep the indent plus a hang; short lines are unchanged", () => {
    expect(wrapLine("  alpha beta gamma delta", 14)).toBe("  alpha beta\n    gamma\n    delta");
    expect(wrapLine("  short", 80)).toBe("  short");
  });
  test("a word longer than the width (a URL) stays whole", () => {
    const url = "https://github.com/Cal-Hacks-2026/Hindsight/blob/db92f7d/apps/actor/README.md#L7";
    expect(wrapLine(`    apps/actor/README.md:7 ${url}`, 40).split("\n")).toEqual(["    apps/actor/README.md:7", `      ${url}`]);
  });
  test("multi-line text wraps line by line", () => {
    expect(wrapText("a b c d\nshort", 4)).toBe("a b\n  c\n  d\nshort");
  });
});
