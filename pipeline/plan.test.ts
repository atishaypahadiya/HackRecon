import { describe, expect, test } from "bun:test";
import { fitHash, fitRequest, fitSystemPrompt, trackCards } from "./fit.ts";
import { parseStack, planTracks, type FitCache } from "./plan.ts";
import type { Entity } from "./schema.ts";

const src = { kind: "page" as const, url: "https://e.devpost.com/", quote: "", captured_at: "" };
const track = (id: string, sponsor: string, name: string): Entity => ({ id, kind: "track", sponsor, name: { value: name, source: { ...src, quote: name } }, fields: {}, history: [], origin: "page" });
const ents = [track("t1", "Acme", "[Acme] Best Use"), track("t2", "Beta", "[Beta] Best Design")];
const e = { event: "Test Hacks", timezone: "UTC" } as never;

describe("Plan tracks", () => {
  test("cached ranking: no client needed, likely before possible, source link from canon", async () => {
    const input = { idea: "an app", stack: parseStack("Acme, Figma") };
    const hash = fitHash(fitSystemPrompt(e, trackCards(ents, e)), fitRequest(input.idea, input.stack));
    const cache: FitCache = { [hash]: { ranked: [{ track_id: "t2", fit: "possible", reason: "r2", quote: "[Beta] Best Design" }, { track_id: "t1", fit: "likely", reason: "r1", quote: "[Acme] Best Use" }], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 1 } };
    const r = await planTracks(null, input, ents, e, cache);
    if ("error" in r) throw new Error(r.error);
    expect([r.from, r.items.map((t) => [t.track_id, t.fit]), r.items[0]!.source_url]).toEqual(["cache", [["t1", "likely"], ["t2", "possible"]], "https://e.devpost.com/"]);
  });
  test("an unranked idea without an API key is an error, never an empty plan", async () => {
    expect(await planTracks(null, { idea: "new", stack: null }, ents, e, {})).toEqual({ error: "no API key, and this idea hasn't been ranked before" });
    expect(parseStack(" , ")).toBeNull();
  });
});
