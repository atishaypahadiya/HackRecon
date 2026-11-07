import { describe, expect, test } from "bun:test";
import { normalizedText, pageCoverage, pageKey, snapshotHash, type LoadedPage } from "./pages.ts";
import type { PageSnapshot } from "./schema.ts";

const page = (texts: string[], url = "https://e.devpost.com/", at = "2026-11-06T00:00:00Z"): PageSnapshot => ({
  schema_version: 1,
  kind: "page",
  url,
  title: "E",
  captured_at: at,
  captured_by: "fixture",
  access: "public",
  blocks: texts.map((text, i) => ({ i, path: [], text })),
  links: [],
  embeds: { iframes: 0, pdfs: 0 },
});

describe("snapshotHash (OV13)", () => {
  test("ignores volatile counters", () => {
    expect(snapshotHash(page(["3 days left", "1,204 participants", "$500 in cash"]))).toBe(snapshotHash(page(["2 days left", "1,377 participants", "$500 in cash"])));
  });
  test("changes when a real value changes", () => {
    expect(snapshotHash(page(["$500 in cash"]))).not.toBe(snapshotHash(page(["$600 in cash"])));
    expect(snapshotHash(page(["by Oct 25 @ 9 AM PST"]))).not.toBe(snapshotHash(page(["by Oct 25 @ 9:30 AM PST"])));
  });
  test("normalizedText keeps amounts and dates", () => {
    expect(normalizedText(page(["Submit by October 25th @ 9 AM PST", "about 4 hours ago"]))).toBe("Submit by October 25th @ 9 AM PST\n<n>");
  });
});

test("pageKey drops query, fragment and trailing slash", () => {
  expect(pageKey("https://e.devpost.com/rules/?a=1#x")).toBe("https://e.devpost.com/rules");
  expect(pageKey("https://e.devpost.com/")).toBe(pageKey("https://e.devpost.com"));
});

test("pageCoverage keeps the latest per page and names missing ones", () => {
  const lp = (s: PageSnapshot): LoadedPage => ({ file: "", snapshot: s, hash: snapshotHash(s) });
  const old = lp(page(["a"], "https://e.devpost.com/", "2026-11-01T00:00:00Z"));
  const now = lp(page(["b"], "https://e.devpost.com/", "2026-11-06T00:00:00Z"));
  const { latest, missing } = pageCoverage([old, now], ["https://e.devpost.com", "https://e.devpost.com/rules"]);
  expect(latest.get("https://e.devpost.com")).toBe(now);
  expect(missing).toEqual(["https://e.devpost.com/rules"]);
});
