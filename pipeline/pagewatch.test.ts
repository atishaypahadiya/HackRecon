// hr watch's hourly look at the event's page (user 2026-11-08, Iterate): hand-noted canon lines, the track diff that
// a re-read alerts on, the alert's wording, and the event's own track shown unranked in the Plan.
import { describe, expect, test } from "bun:test";
import { pageChangeAlert } from "./alerts.ts";
import { applyNotes } from "./canon.ts";
import type { CanonNote, EventConfig } from "./classify.ts";
import { overallTracks } from "./plan.ts";
import { PAGE_SCHEMA_VERSION, type Entity, type PageSnapshot } from "./schema.ts";
import { canonTrackDiff } from "./watch.ts";

const URL_ = "https://luma.com/abc";
const snap = (texts: string[]): PageSnapshot => ({
  schema_version: PAGE_SCHEMA_VERSION,
  kind: "page",
  url: URL_,
  title: "AI Research Hackathon",
  captured_at: "2026-11-08T16:00:00.000Z",
  captured_by: "fetch",
  access: "public",
  blocks: texts.map((text, i) => ({ i, path: ["AI Research Hackathon"], text })),
  links: [],
  embeds: { iframes: 0, pdfs: 0 },
});
const src = (quote: string, block = 0) => ({ kind: "page" as const, url: URL_, quote, captured_at: "2026-11-08T16:00:00.000Z", block });
const entity = (id: string, kind: Entity["kind"], sponsor: string, name: string, fields: Entity["fields"] = {}): Entity => ({ id, kind, sponsor, name: { value: name, source: src(name) }, fields, history: [], origin: "page" });
const NOTE: CanonNote = { kind: "prize", sponsor: "event", name: "Thematic prizes from challenge partners", quote: "Thematic prizes from challenge partners", url: URL_ };
const overall = entity("track:luma.com/abc#ai-research-hackathon", "track", "event", "AI Research Hackathon", { "descriptions[0]": { value: "Teams push AI to do research on its own", source: src("Teams push AI to do research on its own") } });

describe("canon_notes (applyNotes)", () => {
  test("a noted line still on the page joins canon, hand-noted, quoting its block, under the one event track", () => {
    const r = applyNotes([overall], [NOTE], snap(["Prizes", "​Thematic prizes from challenge partners"]), "h1");
    expect(r.gone).toEqual([]);
    const e = r.entities.find((x) => x.noted)!;
    expect([e.kind, e.sponsor, e.name.source.quote, e.name.source.block, e.fields.track_id?.value]).toEqual(["prize", "event", NOTE.quote, 1, overall.id]);
    expect(r.added).toEqual([e.id]);
  });
  test("a line the read already quotes isn't added twice", () => {
    const read = entity("prize:x", "prize", "event", "Thematic prizes from challenge partners");
    expect(applyNotes([overall, read], [NOTE], snap([NOTE.quote]), "h1").added).toEqual([]);
  });
  test("a line gone from the page is reported gone and never kept", () => {
    const r = applyNotes([overall], [NOTE], snap(["Tracks", "Best Use of Modal"]), "h2");
    expect([r.added, r.gone, r.entities.some((e) => e.noted)]).toEqual([[], [NOTE], false]);
  });
  test("a note for another page is ignored", () => {
    expect(applyNotes([], [{ ...NOTE, url: "https://luma.com/other" }], snap([NOTE.quote]), "h1")).toEqual({ entities: [], added: [], gone: [] });
  });
});

describe("canonTrackDiff: what a re-read alerts on", () => {
  const at = "2026-11-14T18:00:00.000Z";
  const modal = entity("track:luma.com/abc#modal", "track", "Modal", "Best Use of Modal");
  test("a track canon didn't have is new; one it had isn't", () => {
    const d = canonTrackDiff([{ url: URL_, entities: [overall] }], [{ url: URL_, entities: [overall, modal] }], at);
    expect(d).toEqual([{ at, url: URL_, tracks: [{ id: modal.id, name: "Best Use of Modal", sponsor: "Modal" }], notes_gone: [] }]);
    expect(canonTrackDiff([{ url: URL_, entities: [overall, modal] }], [{ url: URL_, entities: [overall, modal] }], at)).toEqual([]);
  });
  test("a noted line newly gone is listed once, not again on the next read", () => {
    const gone = [{ quote: NOTE.quote }];
    expect(canonTrackDiff([{ url: URL_, entities: [overall] }], [{ url: URL_, entities: [overall], notes_gone: gone }], at)[0]!.notes_gone).toEqual([NOTE.quote]);
    expect(canonTrackDiff([{ url: URL_, entities: [overall], notes_gone: gone }], [{ url: URL_, entities: [overall], notes_gone: gone }], at)).toEqual([]);
  });
});

describe("pageChangeAlert", () => {
  const base = { at: "2026-11-14T18:00:00.000Z", url: URL_ };
  test("new tracks: sent at once, naming each, with the Plan's likely fits", () => {
    const a = pageChangeAlert({ ...base, tracks: [{ name: "Best Use of Tinker", sponsor: "Tinker", fit: "likely" }, { name: "Best Agent Swarm", sponsor: "event", fit: "possible" }], notes_gone: [NOTE.quote] });
    expect([a.kind, a.level, a.link]).toEqual(["tracks", "now", URL_]);
    expect(a.what).toBe(`New tracks on the event page: Best Use of Tinker (Tinker), Best Agent Swarm. "${NOTE.quote}" is no longer on the event page`);
    expect(a.why).toBe("Your Plan likely fits Best Use of Tinker");
  });
  test("unranked tracks and a gone line say so plainly", () => {
    expect(pageChangeAlert({ ...base, tracks: [{ name: "X", sponsor: "Exa", fit: null }], notes_gone: [] }).why).toBe("Not ranked against your Plan yet");
    expect(pageChangeAlert({ ...base, tracks: [], notes_gone: [NOTE.quote] }).why).toBe("Its prizes may now be named tracks");
  });
});

test("overallTracks: the event's own track, unranked, with its description and prizes verbatim", () => {
  const e = { event: "Iterate", timezone: "America/Los_Angeles" } as EventConfig;
  const prize = entity("prize:p", "prize", "OpenAI", "Prizes from OpenAI", { track_id: { value: overall.id, source: src("x") }, award_text: { value: "Prizes from OpenAI for the top 3 teams", source: src("Prizes from OpenAI for the top 3 teams") } });
  const modal = entity("track:luma.com/abc#modal", "track", "Modal", "Best Use of Modal");
  expect(overallTracks([overall, prize, modal], e)).toEqual([{ track_id: overall.id, name: "AI Research Hackathon", descriptions: ["Teams push AI to do research on its own"], prizes: ["Prizes from OpenAI for the top 3 teams"], source_url: URL_ }]);
});
