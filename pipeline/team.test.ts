// Slice 4: a teammate's leaving undoes what their joining raised. Real ranking merge (plan.ts) behind the chat write
// (told.ts); a fake ranker that keeps rating Beta "likely" once asked, as the live ranker kept Convex likely.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitHash, fitRequest, fitSystemPrompt, trackCards } from "./fit.ts";
import { planTracks, stackForRanker, type FitCache, type PlanInput, type StackRerank } from "./plan.ts";
import type { Entity } from "./schema.ts";
import { makeWrites, readTeam, teamLines } from "./told.ts";

const src = { kind: "page" as const, url: "https://e.devpost.com/", quote: "", captured_at: "" };
const track = (id: string, sponsor: string, name: string, q: string): Entity => ({ id, kind: "track", sponsor, name: { value: name, source: { ...src, quote: name } }, fields: { "requirements[0]": { value: q, source: { ...src, quote: q } } }, history: [], origin: "page" });
const ents = [track("t1", "Acme", "[Acme] Best Use", "must use Acme"), track("t2", "Beta", "[Beta] Best Backend", "one TypeScript backend")];
const e = { event: "Test Hacks", timezone: "UTC" } as never;
const input: PlanInput = { idea: "an app", stack: [{ name: "Acme", used_for: null }] };
const BEFORE = { track_id: "t2", fit: "possible" as const, reason: "your backend is Python; this track asks for one TypeScript backend", quote: "one TypeScript backend" };
const at = (m: number) => `2026-11-14T19:0${m}:00.000Z`;

// Re-judges whatever it's asked to: t1 and t2 both "likely", every time.
const ranker = {
  messages: {
    stream: (p: { messages: { content: string }[] }) => ({
      finalMessage: async () => {
        const ids = /<rerank>.*: ([^<:]*)<\/rerank>/s.exec(p.messages[0]!.content)?.[1]?.split(", ") ?? ["t1", "t2"];
        const q = { t1: "must use Acme", t2: "one TypeScript backend" } as Record<string, string>;
        return { stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({ ranked: ids.map((id) => ({ track_id: id, fit: "likely", reason: `judged again: ${id}`, quote: q[id] })) }) }] };
      },
    }),
  },
} as never;

async function inEvent(f: (say: (text: string, tool: Record<string, unknown>, m: number) => Promise<string>, fit: () => Record<string, string>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "hr-team-"));
  mkdirSync(join(root, "data"), { recursive: true });
  const was = process.cwd();
  process.chdir(root);
  try {
    const cache: FitCache = { [fitHash(fitSystemPrompt(e, trackCards(ents, e)), fitRequest(input.idea, stackForRanker(input.stack)))]: { ranked: [{ track_id: "t1", fit: "likely", reason: "your stack lists Acme", quote: "must use Acme" }, BEFORE], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, calls: 1 } };
    // The chat write's re-run, as hr.ts runs it: rank with the team's skills, save the Plan.
    const rerun = async (i: PlanInput, rerank?: StackRerank) => {
      const r = await planTracks(ranker, i, ents, e, cache, {}, undefined, rerank, [], teamLines(readTeam()));
      if ("error" in r) return { error: r.error };
      writeFileSync("data/plan.json", JSON.stringify({ input: i, counts: { gaps: null, booths: null }, tracks: r.items.map((t) => ({ track_id: t.track_id, name: t.name, sponsor: t.sponsor, fit: t.fit, product_names: t.product_names, reason: t.reason, quote: t.quote })) }));
      return null;
    };
    await rerun(input);
    const w = makeWrites({ rerun, credits: () => [], tracks: () => [], ship: () => ({ deadline: null, required: [], tracks: [], choices: [], judging: [] }), pageLines: () => [] });
    const say = async (text: string, tool: Record<string, unknown>, m: number) => {
      const r = await w.exec("set_teammate", { quote: text, ...tool }, { text, at: at(m) });
      if ("confirm" in r) return (await w.confirm("yes", at(m))) ?? "";
      return "line" in r ? r.line : r.error;
    };
    const fit = () => Object.fromEntries((JSON.parse(readFileSync("data/plan.json", "utf8")).tracks as { track_id: string; fit: string; reason: string }[]).map((t) => [t.track_id, `${t.fit}: ${t.reason}`]));
    await f(say, fit);
  } finally {
    process.chdir(was);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("a teammate leaving returns what their joining raised", () => {
  test("join raises a track, leave returns it", async () => {
    await inEvent(async (say, fit) => {
      expect(fit().t2).toBe(`possible: ${BEFORE.reason}`);
      expect(await say("Priya joined the team, she does TypeScript", { name: "Priya", skills: ["TypeScript"] }, 1)).toContain("[Beta] Best Backend possible → likely");
      expect(readTeam()[0]!.raised).toEqual({ t2: { fit: "possible", reason: BEFORE.reason, quote: BEFORE.quote } });
      expect(await say("Priya left the team", { name: "Priya", left: true }, 2)).toContain("[Beta] Best Backend likely → possible");
      expect(fit().t2).toBe(`possible: ${BEFORE.reason}`);
    });
  });
  test("with someone else still on the team, the ranker rates it likely again; the cap still returns it, judgment and all", async () => {
    await inEvent(async (say, fit) => {
      await say("Priya joined the team, she does TypeScript", { name: "Priya", skills: ["TypeScript"] }, 1);
      await say("Lee joined the team and does Figma", { name: "Lee", skills: ["Figma"] }, 2);
      expect(fit().t2).toBe("likely: judged again: t2");
      expect(await say("Priya left the team", { name: "Priya", left: true }, 3)).toContain("[Beta] Best Backend likely → possible");
      // The ranker said "likely" again; the track is back to its judgment from before Priya joined.
      expect(fit()).toEqual({ t1: "likely: judged again: t1", t2: `possible: ${BEFORE.reason}` });
      expect(readTeam().map((t) => t.name)).toEqual(["Lee"]);
    });
  });
});
