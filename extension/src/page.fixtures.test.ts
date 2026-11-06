// The outline on Cal Hacks 13.0's real Devpost overview (public page, saved 2026-11-06 into the gitignored
// events/calhacks-13/fixtures/pages/). Skipped, loudly, when the HTML isn't there.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { EVENTS_DIR } from "../../pipeline/event.ts";
import { snapshotPage } from "./page.ts";

const FILE = join(EVENTS_DIR, "calhacks-13", "fixtures/pages/devpost-overview.html");
if (!existsSync(FILE)) console.warn(`SKIPPED Devpost outline fixture: ${FILE} not found (gitignored)`);

describe.skipIf(!existsSync(FILE))("Devpost overview outline (Cal Hacks 13.0)", () => {
  const s = snapshotPage(parseHTML(readFileSync(FILE, "utf8")).document as unknown as Document, {
    url: "https://cal-hacks-13-0.devpost.com/",
    captured_at: "fixture",
    access: "public",
    captured_by: "fixture",
  });
  const prizes = s.blocks.filter((b) => b.heading === 6 && b.path.at(-1) === "Prizes");

  test("every prize block is an h6 under Prizes, anchored to its prize_ id", () => {
    const html = readFileSync(FILE, "utf8");
    const blocks = html.match(/id="prize_\d+"/g)!.length;
    expect(prizes.length).toBe(blocks);
    expect(prizes.every((p) => /^prize_\d+$/.test(p.anchor ?? ""))).toBe(true);
    expect(new Set(prizes.map((p) => p.anchor)).size).toBe(prizes.length);
  });

  test("a prize's value and description sit under its heading", () => {
    const first = s.blocks.filter((b) => b.path.at(-1) === "Cal Hacks First Overall").map((b) => b.text);
    expect(first).toContain("$3,600 in cash");
  });

  test("the submission deadline reads as one sentence", () => {
    expect(s.blocks.some((b) => b.path.at(-1) === "Requirements" && b.text.includes("October 25th @ 9 AM PST"))).toBe(true);
  });

  test("judging criteria are under their heading", () => {
    const names = s.blocks.filter((b) => b.path.at(-1) === "Judging Criteria" && b.anchor === "judging-criteria").map((b) => b.text.split("\n")[0]);
    expect(names).toEqual(["Application", "Intentionality", "Functionality", "Creativity", "Technical Complexity"]);
  });
});
