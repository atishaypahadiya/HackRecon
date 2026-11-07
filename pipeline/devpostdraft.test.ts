// The read-only visit to the user's own submission (user 2026-11-07): which links the worker may load, in which
// order, when it stops, and what the saved sample keeps. Synthetic pages; Devpost's real structure comes from the
// first sample.
import { beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { findTokens, total } from "./domscrub.ts";
import { draftStep, eventSlug, MAX_HOPS, safeHop, scrubDevpostHtml, startDraft, type DraftLink, type DraftPage, type DraftState } from "./devpostdraft.ts";

const ROOT = "https://cal-hacks-13-0.devpost.com/";
const page = (url: string, links: DraftLink[], prize_boxes = 0, track_mentions = 0): DraftPage => ({ url, links, prize_boxes, track_mentions });
const a = (href: string, text = "", method?: string): DraftLink => ({ href, text, ...(method ? { method } : {}) });
const SUB = "https://devpost.com/submit-to/26000-cal-hacks-13-0/manage/submissions/123456-hindsight";

describe("which links the worker may load", () => {
  test("only https Devpost (or the event's host), GET, nothing destructive", () => {
    const ok = (l: DraftLink) => safeHop(l, "cal-hacks-13-0")?.href ?? null;
    expect(ok(a("https://devpost.com/software/hindsight-68sruh#top"))).toBe("https://devpost.com/software/hindsight-68sruh");
    expect(ok(a("https://cal-hacks-13-0.devpost.com/submissions"))).not.toBeNull();
    for (const bad of [
      a("http://devpost.com/software/x"),
      a("https://evil.example/devpost.com/"),
      a("https://secure.devpost.com/users/edit"),
      a("https://other-hack.devpost.com/"),
      a(`${SUB}/withdraw`),
      a("https://devpost.com/users/sign_out"),
      a(`${SUB}/team`, "Leave team", "delete"),
      a("https://devpost.com/software/x?_method=delete"),
      a("javascript:alert(1)"),
    ])
      expect([bad.href, ok(bad)]).toEqual([bad.href, null]);
  });
  test("the event's slug comes from its own subdomain, never Devpost's", () => {
    expect([eventSlug(ROOT), eventSlug("https://www.devpost.com/"), eventSlug("https://x.devpost.com/rules")]).toEqual(["cal-hacks-13-0", null, null]);
  });
});

describe("the order: event page → My projects → this event's project → its submission → its steps", () => {
  const walk = (pages: DraftPage[]) => {
    let s = startDraft(ROOT) as DraftState;
    const went: string[] = [];
    for (const p of pages) {
      const r = draftStep(s, p);
      s = r.state;
      if (!r.go) return { went, why: r.why, s };
      went.push(r.go);
    }
    return { went, why: "", s };
  };
  test("a project with no submission for this event is skipped; the submission's steps are read until prize checkboxes show", () => {
    const r = walk([
      page(ROOT, [a(`${SUB}`, "Edit submission"), a("https://devpost.com/portfolio/redirect?page=projects", "My projects")]),
      page("https://devpost.com/atishay", [a("https://devpost.com/software/old-hack", "Old hack"), a("https://devpost.com/software/hindsight-68sruh", "Hindsight"), a("https://devpost.com/software/old-hack/edit", "Edit")]),
      page("https://devpost.com/software/old-hack", [a("https://devpost.com/submit-to/1-other-hack/manage/submissions/9-old", "Manage")]),
      page("https://devpost.com/software/hindsight-68sruh", [a(SUB, "Manage submission"), a("https://cal-hacks-13-0.devpost.com/", "Cal Hacks 13.0")]),
      page(SUB, [a(`${SUB}/project-overview`, "Project overview"), a(`${SUB}/additional-info`, "Additional info"), a("https://devpost.com/submit-to/1-other-hack/manage/submissions/9-old/x", "Other")], 0, 3),
      page(`${SUB}/project-overview`, [a(`${SUB}/additional-info`, "Additional info")], 0, 1),
      page(`${SUB}/additional-info`, [a(`${SUB}/submit`, "Submit")], 4, 6),
    ]);
    // The event page's own "Edit submission" link is passed over: the user asked for it from their projects.
    expect(r.went).toEqual([
      "https://devpost.com/portfolio/redirect?page=projects",
      "https://devpost.com/software/old-hack",
      "https://devpost.com/software/hindsight-68sruh",
      SUB,
      `${SUB}/project-overview`,
      `${SUB}/additional-info`,
    ]);
    expect(r.why).toBe("prize checkboxes found");
    expect(r.s.best).toEqual({ url: `${SUB}/additional-info`, score: 4006 });
    expect(r.s.log.map((l) => l.stage)).toEqual(["event", "portfolio", "project", "project", "submission", "submission", "submission"]);
    expect(r.s.log.at(-1)!.links).toBeUndefined();
  });
  test("signed out: no My projects link, nothing loaded; the log lists the safe links seen, for fixing a rule", () => {
    const r = walk([page(ROOT, [a("https://secure.devpost.com/users/login", "Log in"), a("https://devpost.com/hackathons", "Hackathons")])]);
    expect(r).toMatchObject({ went: [], why: "no My projects link (not signed in to Devpost?)" });
    expect(r.s.log[0]!.links).toEqual([{ href: "https://devpost.com/hackathons", text: "Hackathons" }]);
  });
  test("no checkboxes anywhere: the page naming the most tracks is kept as the sample", () => {
    const r = walk([
      page(ROOT, [a("https://devpost.com/portfolio/redirect?page=projects", "My projects")]),
      page("https://devpost.com/atishay", [a("https://devpost.com/software/hindsight-68sruh", "Hindsight")]),
      page("https://devpost.com/software/hindsight-68sruh", [a(SUB, "Manage submission")]),
      page(SUB, [], 0, 5),
    ]);
    expect([r.why, r.s.best]).toEqual(["no more submission steps", { url: SUB, score: 5 }]);
  });
  test("never more than MAX_HOPS pages", () => {
    let s = startDraft(ROOT) as DraftState;
    s = draftStep(s, page(ROOT, [a("https://devpost.com/p", "My projects")])).state;
    s = draftStep(s, page("https://devpost.com/p", Array.from({ length: 20 }, (_, k) => a(`https://devpost.com/software/p${k}`, `P${k}`)))).state;
    let n = 3; // the event page, My projects, and the first project
    for (let r = draftStep(s, page("x", [])); r.go; r = draftStep(r.state, page(r.go, []))) n++;
    expect(n).toBe(MAX_HOPS);
  });
});

const FORM = `<!doctype html><html><head><meta name="csrf-token" content="Zm9vYmFyQ1NSRnRva2VuMTIzNDU2Nzg5MA=="><script>window.user={"session_id":"abcdefabcdefabcdef12"}</script><style>.x{}</style></head><body>
<form action="/submit-to/26000-cal-hacks-13-0/manage/submissions/123456-hindsight" method="post">
<input type="hidden" name="authenticity_token" value="YXV0aGVudGljaXR5VG9rZW4xMjM0NTY=">
<label><input type="checkbox" name="prizes[]" value="1" checked> [Apify] Best Use of Apify</label>
<label><input type="checkbox" name="prizes[]" value="2"> [Figma] Best Design</label>
<input type="text" name="project[title]" value="Hindsight" onfocus="track()">
</form></body></html>`;

describe("the sample", () => {
  test("the worker's scrub: no script or style bodies, no token values; the prize boxes and labels stay", () => {
    const { html, stripped } = scrubDevpostHtml(FORM);
    expect(stripped).toBeGreaterThanOrEqual(4);
    expect(total(findTokens(html))).toBe(0);
    for (const v of ["Zm9vYmFy", "YXV0aGVu", "abcdefabcdef", ".x{}"]) expect(html).not.toContain(v);
    expect(html).toContain('<input type="checkbox" name="prizes[]" value="1" checked> [Apify] Best Use of Apify');
    expect(html).toContain('value="Hindsight"');
  });

  type Snap = { inspect: (t: string[]) => DraftPage; sample: () => string };
  let snap: Snap;
  beforeAll(async () => {
    const { window } = parseHTML(FORM);
    Object.assign(globalThis, { window, document: window.document, location: { href: SUB }, HTMLInputElement: window.HTMLInputElement, HTMLOptionElement: window.HTMLOptionElement });
    await import("../extension/src/devpost-snap.ts");
    snap = (window as unknown as { __hackreconDevpost: Snap }).__hackreconDevpost;
  });
  test("in the tab: prize boxes are counted by track name (with or without the [Sponsor] prefix)", () => {
    const p = snap.inspect(["[Apify] Best Use of Apify", "[Figma] Best Design", "[Moss] Best Use of Moss"]);
    expect([p.prize_boxes, p.track_mentions]).toEqual([2, 2]);
  });
  test("in the tab: the copy keeps what's ticked, and loses the token values, script bodies and handlers before it leaves", () => {
    // A browser always has .checked (linkedom only once it's set): the live state, as a page would show it.
    const boxes = [...(globalThis as unknown as { document: Document }).document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    boxes[0]!.checked = true;
    boxes[1]!.checked = false;
    const html = snap.sample();
    expect(html).toMatch(/value="1" checked/);
    expect(html).not.toMatch(/value="2" checked/);
    expect(total(findTokens(html))).toBe(0);
    for (const v of ["Zm9vYmFy", "YXV0aGVu", "abcdefabcdef", "onfocus"]) expect(html).not.toContain(v);
  });
});
