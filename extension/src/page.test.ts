// Page snapshot outline (v2 D3, D7, D12) on small hand-written pages; real Devpost HTML is in page.fixtures.test.ts.
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { pageFileName, parsePageSnapshot } from "../../pipeline/schema.ts";
import { snapshotPage } from "./page.ts";

const snap = (body: string, access: "public" | "authenticated" | null = "public") =>
  snapshotPage(parseHTML(`<html><head><title> T </title></head><body>${body}</body></html>`).document as unknown as Document, {
    url: "https://example.devpost.com/",
    captured_at: "2026-11-06T00:00:00Z",
    access,
    captured_by: "fixture",
  });

describe("snapshotPage", () => {
  test("blocks carry their heading path and nearest anchor id", () => {
    const s = snap(`<h1>Event</h1><article id="prizes"><h3>Prizes</h3><div id="prize_1"><h6><div>Best Hack</div></h6><div class="v">$500 in cash</div><p>For the team</p></div></article>`);
    expect(s.blocks.map((b) => [b.heading ?? 0, b.path.join(" > "), b.text, b.anchor ?? ""])).toEqual([
      [1, "", "Event", ""],
      [3, "Event", "Prizes", "prizes"],
      [6, "Event > Prizes", "Best Hack", "prize_1"],
      [0, "Event > Prizes > Best Hack", "$500 in cash", "prize_1"],
      [0, "Event > Prizes > Best Hack", "For the team", "prize_1"],
    ]);
  });

  test("a heading replaces its level and everything deeper", () => {
    const s = snap(`<h2>A</h2><h4>A1</h4><p>x</p><h3>B</h3><p>y</p>`);
    expect(s.blocks.filter((b) => !b.heading).map((b) => b.path)).toEqual([["A", "A1"], ["A", "B"]]);
  });

  test("inline text keeps its spaces; whitespace collapses once", () => {
    const s = snap(`<li><strong>By Oct 25 @ 9<span>&nbsp;AM&nbsp;</span>PST. </strong>Hard   deadline.</li>`);
    expect(s.blocks[0]!.text).toBe("By Oct 25 @ 9 AM PST. Hard deadline.");
  });

  test("<br> is a line break inside a block", () => {
    const s = snap(`<li><strong>Application</strong><br>\n   Projects should work.</li>`);
    expect(s.blocks[0]!.text).toBe("Application\nProjects should work.");
  });

  test("scripts, hidden elements and form controls are skipped", () => {
    const s = snap(`<p>shown</p><script>var x=1</script><div hidden>h</div><div style="display: none">n</div><div aria-hidden="true">a</div><button>Register</button>`);
    expect(s.blocks.map((b) => b.text)).toEqual(["shown"]);
  });

  test("links are absolute and point at their block", () => {
    const s = snap(`<p>See <a href="/rules">the rules</a></p><a href="https://x.com"><img alt="X logo"></a>`);
    expect(s.links).toEqual([
      { text: "the rules", href: "https://example.devpost.com/rules", block: 0 },
      { text: "X logo", href: "https://x.com/", block: 0 },
    ]);
  });

  test("a page whose content is in an iframe or PDF reports no text", () => {
    const s = snap(`<h1>Schedule</h1><iframe src="https://docs.google.com/x"></iframe><embed type="application/pdf" src="s.pdf">`);
    expect(s.embeds).toEqual({ iframes: 1, pdfs: 1 });
    expect(s.no_text).toBe("no text captured: the page shows 1 iframe(s) and 1 PDF(s)");
  });

  test("access flag is recorded as given, including missing (D12)", () => {
    expect(snap("<p>x</p>", "authenticated").access).toBe("authenticated");
    expect(snap("<p>x</p>", null).access).toBeNull();
  });

  test("output passes the schema validator", () => {
    expect(() => parsePageSnapshot(JSON.parse(JSON.stringify(snap("<h1>a</h1><p>b</p>"))))).not.toThrow();
  });
});

test("pageFileName", () => {
  expect(pageFileName("https://cal-hacks-13-0.devpost.com/")).toBe("cal-hacks-13-0.devpost.com.page.json");
  expect(pageFileName("https://cal-hacks-13-0.devpost.com/rules?x=1#top")).toBe("cal-hacks-13-0.devpost.com-rules.page.json");
});
