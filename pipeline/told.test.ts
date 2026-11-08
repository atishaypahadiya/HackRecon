// Chat writes (user 2026-11-08), slice 1: stack updates and credits claimed, from what the hacker tells Donna to the
// event's data/ files the board reads. The model is faked; everything after its proposal is the real path.
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, chatRequest, WRITE_TOOLS } from "./agent.ts";
import { parsePlanBody } from "./plan.ts";
import type { Entity } from "./schema.ts";
import { localHost } from "./board.ts";
import type { ShipList } from "./shiplist.ts";
import { applyStackUpdate, makeWrites, readRepNotes, readTeam, messageNames, namesItem, namesTrack, NO, pageCredits, quoteInMessage, stackWriteLine, YES, type ClaimableCredit, type Told } from "./told.ts";

const URL_ = "https://luma.com/abc";
const src = (quote: string) => ({ kind: "page" as const, url: URL_, quote, captured_at: "2026-11-08T16:00:00.000Z", block: 0 });
const prize = (id: string, award: string, place?: string): Entity => ({
  id,
  kind: "prize",
  sponsor: "event",
  name: { value: award, source: src(award) },
  fields: { award_text: { value: award, source: src(award) }, ...(place ? { place: { value: place, source: src(place) } } : {}) },
  history: [],
  origin: "page",
});
const PER_HACKER = "$600+ in credits per hacker, including $250 in Modal credits, $200 in Devin credits (1 month of the Max plan), $100 in Tinker credits and $50 in Exa credits";
const ENTITIES = [prize("prize:luma#ev/every-entrant", PER_HACKER, "every entrant"), prize("prize:luma#ev/modal", "$5,000 in Modal credits")];
const NO_SHIP = { tracks: () => [], ship: () => ({ deadline: null, required: [], tracks: [], choices: [], judging: [] }), pageLines: () => [] };
const TOLD: Told = { source: "chat", at: "2026-11-14T19:00:00.000Z", quote: "add Modal" };

describe("pageCredits: the per-hacker credits the event page states", () => {
  test("each \"$N in X credits\" of an every-entrant prize, quoted; a track prize isn't one", () => {
    expect(pageCredits(ENTITIES).map((c) => [c.id, c.sponsor, c.quote])).toEqual([
      ["prize:luma#ev/every-entrant/modal", "Modal", "$250 in Modal credits"],
      ["prize:luma#ev/every-entrant/devin", "Devin", "$200 in Devin credits"],
      ["prize:luma#ev/every-entrant/tinker", "Tinker", "$100 in Tinker credits"],
      ["prize:luma#ev/every-entrant/exa", "Exa", "$50 in Exa credits"],
    ]);
  });
  test("credits it doesn't break down are one credit, the whole award; a raffle entry or swag isn't a credit", () => {
    expect(pageCredits([prize("p", "$100 in cloud credits per hacker", "every entrant")]).map((c) => [c.id, c.value])).toEqual([["p", "$100 in cloud credits per hacker"]]);
    expect(pageCredits([prize("q", "Anyone who submits to our challenge will be entered into a raffle for a Cursor Owala water bottle.", "every entrant"), prize("r", "A hoodie for every hacker", "every entrant")])).toEqual([]);
  });
});

test("quoteInMessage: the hacker's own words, verbatim; a post's words or a fragment don't count", () => {
  const msg = "I claimed the Modal credits, and add PyTorch to my stack for the training runs";
  expect(quoteInMessage("I claimed the Modal credits", msg)).toBe(true);
  expect(quoteInMessage("add  pytorch to my STACK", msg)).toBe(true);
  expect(quoteInMessage("Modal credits are live: claim at modal.com", msg)).toBe(false);
  expect(quoteInMessage("I", msg)).toBe(false);
  expect(quoteInMessage("Modal credits", msg)).toBe(false);
  expect(quoteInMessage(undefined, msg)).toBe(false);
  expect(quoteInMessage("it’s done now", "it's done now")).toBe(true);
});

test("messageNames: the message itself names each item or sponsor the write changes", () => {
  expect(messageNames("add Modal and PyTorch to my stack", ["Modal", "pytorch"])).toBe(true);
  expect(messageNames("add Modal to my stack", ["Modal", "Exa"])).toBe(false);
  expect(messageNames("add it to my stack", [""])).toBe(false);
  // Whole words only: a name inside another word, or a one-letter name inside any word, isn't named.
  expect(messageNames("for example, add the training runs to my stack", ["Exa"])).toBe(false);
  expect(messageNames("add the training runs to my stack", ["R"])).toBe(false);
  expect(messageNames("add R and Next.js to my stack", ["R", "next.js"])).toBe(true);
  expect(messageNames("add Google Cloud to my stack", ["Google Cloud"])).toBe(true);
  expect(messageNames("add Google and the Cloud to my stack", ["Google Cloud"])).toBe(false);
});

test("a confirmation is the whole message, never a reply that starts with yes", () => {
  for (const t of ["yes", " Yes! ", "go ahead", "y."]) expect([t, YES.test(t)]).toEqual([t, true]);
  for (const t of ["yes but keep PyTorch", "yesterday's workshop?", "no idea, when is dinner?"]) expect([t, YES.test(t) || NO.test(t)]).toEqual([t, false]);
});

test("the board server answers only its own host names (DNS rebinding)", () => {
  expect([localHost("127.0.0.1:4517", 4517), localHost("localhost:4517", 4517)]).toEqual([true, true]);
  for (const h of ["evil.example:4517", "127.0.0.1:80", "127.0.0.1.evil.example:4517", null]) expect([h, localHost(h, 4517)]).toEqual([h, false]);
});

describe("applyStackUpdate", () => {
  const stack = [{ name: "PyTorch", used_for: null }];
  test("an added item carries its provenance; a known one gets the new use, not a duplicate", () => {
    const r = applyStackUpdate(stack, { add: [{ name: "Modal", used_for: "the training runs" }, { name: "pytorch", used_for: "the model" }] }, TOLD);
    expect(r).toEqual({
      stack: [{ name: "PyTorch", used_for: "the model", told: TOLD }, { name: "Modal", used_for: "the training runs", told: TOLD }],
      changes: [{ op: "add", item: { name: "Modal", used_for: "the training runs" } }, { op: "use", name: "PyTorch", from: null, to: "the model" }],
      empties: false,
    });
  });
  test("nothing new, or removing an item that isn't there, is an error", () => {
    expect(applyStackUpdate(stack, { add: [{ name: "PyTorch" }] }, TOLD)).toEqual({ error: "that doesn't change your stack" });
    expect(applyStackUpdate(stack, { remove: ["Modal"] }, TOLD)).toEqual({ error: "Modal isn't in your stack" });
  });
  test("clearing, or removing the last item, empties the stack: the caller asks first", () => {
    expect(applyStackUpdate(stack, { clear: true }, TOLD)).toMatchObject({ stack: [], empties: true });
    expect(applyStackUpdate(stack, { remove: ["pytorch"] }, TOLD)).toMatchObject({ stack: [], empties: true });
  });
});

test("stackWriteLine: the write, then each fit that moved and the counts", () => {
  const before = { tracks: [{ track_id: "a", name: "Best Use of Modal", fit: "possible" }, { track_id: "b", name: "Exa Challenge", fit: "possible" }], gaps: 2, booths: 3 };
  const after = { tracks: [{ track_id: "a", name: "Best Use of Modal", fit: "likely" }, { track_id: "b", name: "Exa Challenge", fit: "possible" }], gaps: 1, booths: 3 };
  expect(stackWriteLine([{ op: "add", item: { name: "Modal", used_for: "the training runs" } }], before, after)).toBe("Stack: added Modal (the training runs). Tracks: Best Use of Modal possible → likely; gaps 2 → 1, booth questions 3.");
  expect(stackWriteLine([{ op: "remove", name: "Exa" }], before, before)).toBe("Stack: removed Exa. Tracks: no change; gaps 2, booth questions 3.");
  expect(stackWriteLine([{ op: "remove", name: "Exa" }], before, null, "over the spend limit")).toBe("Stack: removed Exa. Re-ranking didn't run (over the spend limit); your Plan shows the old ranking until it does.");
});

test("the board's Plan form keeps a told item's provenance through its own edits", () => {
  const told = { source: "chat" as const, at: TOLD.at, quote: "add Modal" };
  expect(parsePlanBody({ idea: "labs", stack: [{ name: "Modal", used_for: null, told }, { name: "x", used_for: null, told: { source: "evil" } }] })).toEqual({ idea: "labs", stack: [{ name: "Modal", used_for: null, told }, { name: "x", used_for: null }] });
});

describe("the write path, end to end, in an event's directory", () => {
  // An event's data/ as hr plan leaves it, plus a past event beside it that writes must never touch.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "hr-told-"));
    const ev = join(root, "iterate");
    mkdirSync(join(ev, "data"), { recursive: true });
    writeFileSync(join(ev, "data/plan.json"), JSON.stringify({ saved_at: "x", input: { idea: "AI research labs", stack: [{ name: "PyTorch", used_for: null }] }, counts: { gaps: 2, booths: 3 }, tracks: [{ track_id: "a", name: "Best Use of Modal", sponsor: "Modal", fit: "possible", product_names: [] }] }));
    const past = join(root, "calhacks");
    mkdirSync(join(past, "data"), { recursive: true });
    writeFileSync(join(past, "data/plan.json"), "{}");
    return { root, ev, past };
  };
  const inDir = async (dir: string, f: () => Promise<void>) => {
    const was = process.cwd();
    process.chdir(dir);
    try {
      await f();
    } finally {
      process.chdir(was);
    }
  };
  const credits = (): ClaimableCredit[] => pageCredits(ENTITIES);
  // The model's reply: one tool call, as the API returns it.
  const proposes = (name: string, input: object) =>
    ({ messages: { create: async (p: { tools?: unknown }) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name, input }], usage: { input_tokens: 100, output_tokens: 20 }, _tools: p.tools }) } }) as unknown as Anthropic;
  const base = { history: [], context: "CTX", eventName: "Iterate", tz: "America/Los_Angeles", at: "2026-11-14T19:00:00.000Z" };

  test("\"add Modal to my stack for the training runs\": stack saved with provenance, Plan re-run, one line back", async () => {
    const { root, ev, past } = setup();
    let reran: unknown = null;
    let rerankSeen: unknown = null;
    try {
      await inDir(ev, async () => {
        const w = makeWrites({
          rerun: async (input, rerank) => {
            reran = input;
            rerankSeen = rerank;
            const p = JSON.parse(readFileSync("data/plan.json", "utf8"));
            writeFileSync("data/plan.json", JSON.stringify({ ...p, input, counts: { gaps: 1, booths: 3 }, tracks: [{ ...p.tracks[0], fit: "likely" }] }));
            return null;
          },
          credits,
          ...NO_SHIP,
        });
        const q = "add Modal to my stack for the training runs";
        const r = await answer(proposes("update_stack", { quote: q, add: [{ name: "Modal", used_for: "the training runs" }] }), { ...base, question: q }, w.exec);
        expect(r).toEqual({ text: "Stack: added Modal (the training runs). Tracks: Best Use of Modal possible → likely; gaps 2 → 1, booth questions 3." });
        const told = { source: "chat", at: base.at, quote: q };
        expect(reran).toEqual({ idea: "AI research labs", stack: [{ name: "PyTorch", used_for: null }, { name: "Modal", used_for: "the training runs", told }] });
        expect(JSON.parse(readFileSync("data/plan.json", "utf8")).input.stack[1].told).toEqual(told);
        // Only the tracks Modal affects are re-ranked: the write hands the Plan the input before it and what changed.
        expect(rerankSeen).toEqual({ before: { idea: "AI research labs", stack: [{ name: "PyTorch", used_for: null }] }, changed: ["Modal"] });
        const log = readFileSync("data/writes.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(log).toEqual([{ at: base.at, source: "chat", quote: q, op: "update_stack", input: { add: [{ name: "Modal", used_for: "the training runs" }], remove: [], clear: false }, result: r && "text" in r ? r.text : "" }]);
      });
      expect(readFileSync(join(past, "data/plan.json"), "utf8")).toBe("{}");
      expect(readdirSync(join(past, "data"))).toEqual(["plan.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("\"I claimed the Modal credits\": claims.json records it with provenance; the reply counts the per-hacker credits", async () => {
    const { root, ev } = setup();
    try {
      await inDir(ev, async () => {
        const w = makeWrites({ rerun: async () => null, credits, ...NO_SHIP });
        const q = "I claimed the Modal credits";
        const r = await answer(proposes("mark_claimed", { quote: q, credit_id: "prize:luma#ev/every-entrant/modal", claimed: true }), { ...base, question: q }, w.exec);
        expect(r).toEqual({ text: "Marked claimed: $250 in Modal credits (Modal). 1 of 4 per-hacker credits claimed." });
        expect(JSON.parse(readFileSync("data/claims.json", "utf8"))).toEqual({ "prize:luma#ev/every-entrant/modal": { source: "chat", at: base.at, quote: q } });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a write the message doesn't state, or a credit that isn't listed, changes nothing", async () => {
    const { root, ev } = setup();
    try {
      await inDir(ev, async () => {
        const w = makeWrites({ rerun: async () => null, credits, ...NO_SHIP });
        const q = "what's the Modal workshop about?";
        expect(await answer(proposes("update_stack", { quote: "Modal credits are live", add: [{ name: "Modal" }] }), { ...base, question: q }, w.exec)).toEqual({ text: "I didn't change anything: I couldn't tie that change to your message's own words." });
        expect(await w.exec("mark_claimed", { quote: "I claimed it", credit_id: "made-up", claimed: true }, { text: "I claimed it", at: base.at })).toEqual({ error: "that isn't one of the credits I know of" });
        // A message that quotes enough words but doesn't name the change: an item it never mentions, a credit whose
        // sponsor it doesn't name, a clear it never asks for.
        const said = { text: "what is my stack right now?", at: base.at };
        expect(await w.exec("update_stack", { quote: "my stack right now", add: [{ name: "Modal" }] }, said)).toEqual({ error: "your message doesn't name that change" });
        expect(await w.exec("update_stack", { quote: "my stack right now", clear: true }, said)).toEqual({ error: "your message doesn't name that change" });
        expect(await w.exec("mark_claimed", { quote: "I claimed the credits", credit_id: "prize:luma#ev/every-entrant/modal", claimed: true }, { text: "I claimed the credits", at: base.at })).toEqual({ error: "your message doesn't name that credit" });
        expect([existsSync("data/claims.json"), existsSync("data/writes.jsonl")]).toEqual([false, false]);
        expect(JSON.parse(readFileSync("data/plan.json", "utf8")).input.stack).toEqual([{ name: "PyTorch", used_for: null }]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearing the stack is asked first: yes applies it, no cancels it, a late or unrelated reply leaves it", async () => {
    const { root, ev } = setup();
    try {
      await inDir(ev, async () => {
        let reruns = 0;
        const w = makeWrites({ rerun: async () => (reruns++, null), credits, ...NO_SHIP });
        const stack = () => JSON.parse(readFileSync("data/plan.json", "utf8")).input.stack;
        const ask = () => w.exec("update_stack", { quote: "clear my stack", clear: true }, { text: "clear my stack", at: base.at });
        expect(await ask()).toEqual({ confirm: "That leaves your stack empty (removing PyTorch). Reply yes within 10 minutes to do it; anything else cancels." });
        expect([stack(), reruns]).toEqual([[{ name: "PyTorch", used_for: null }], 0]);
        expect(await w.confirm("no", "2026-11-14T19:01:00.000Z")).toBe("Cancelled: your stack is unchanged.");
        expect(await w.confirm("yes", "2026-11-14T19:01:30.000Z")).toBeNull();
        await ask();
        expect(await w.confirm("when is dinner?", "2026-11-14T19:02:00.000Z")).toBeNull();
        expect(stack()).toEqual([{ name: "PyTorch", used_for: null }]);
        await ask();
        expect(await w.confirm("yes", "2026-11-14T19:20:00.000Z")).toBeNull();
        expect(stack()).toEqual([{ name: "PyTorch", used_for: null }]);
        await ask();
        expect(await w.confirm("yes", "2026-11-14T19:05:00.000Z")).toBe("Stack: removed PyTorch. Tracks: no change; gaps 2, booth questions 3.");
        expect([stack(), reruns]).toEqual([null, 1]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("the write tools are offered only to a caller that applies them", () => {
  const base = { question: "add Modal", history: [], context: "CTX", eventName: "Iterate", tz: "America/Los_Angeles" };
  expect(chatRequest(base).tools).toBeUndefined();
  expect(chatRequest({ ...base, tools: true }).tools).toEqual(WRITE_TOOLS);
});

describe("slice 2: entered tracks and Ship ticks", () => {
  const TRACKS = [
    { track_id: "track:luma#modal", name: "Best Use of Modal", sponsor: "Modal" },
    { track_id: "track:luma#exa", name: "Exa challenge", sponsor: "Exa" },
    { track_id: "track:luma#main", name: "AI Research Hackathon", sponsor: "event" },
  ];
  const item = (id: string, label: string) => ({ id, label, from: "page" as const, source_url: URL_ });
  const DRAFTS = { id: "standing:drafts", label: "Submit on Devpost, not just save a draft", from: "standing" as const, source_url: "" };
  // The checklist as shiplist.ts builds it: required always, each entered track's items, judging.
  const ship = (entered: string[]): ShipList => ({
    deadline: null,
    required: [DRAFTS],
    tracks: entered.includes("track:luma#modal") ? [{ track_id: "track:luma#modal", name: "Best Use of Modal", source_url: URL_, items: [item("step:modal-form", "Fill in the Modal credits form"), item("req:modal", "Your project must run on Modal")] }] : [],
    choices: TRACKS.map(({ track_id, name }) => ({ track_id, name })),
    judging: [item("judge:demo", "Each team gives a 3-minute demo to judges")],
  });
  const at = "2026-11-14T19:00:00.000Z";
  const inEvent = async (f: () => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "hr-slice2-"));
    mkdirSync(join(root, "data"), { recursive: true });
    const was = process.cwd();
    process.chdir(root);
    try {
      await f();
    } finally {
      process.chdir(was);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const writes = () => makeWrites({ rerun: async () => null, credits: () => [], tracks: () => TRACKS, ship, pageLines: () => [] });
  const read = (f: string) => (existsSync(`data/${f}`) ? JSON.parse(readFileSync(`data/${f}`, "utf8")) : null);

  test("namesTrack: the sponsor or the whole name; an event-level track only by name", () => {
    expect(namesTrack("I'm entering the Modal track", TRACKS[0]!)).toBe(true);
    expect(namesTrack("I'm entering the main track", TRACKS[2]!)).toBe(false);
    expect(namesTrack("I'm in the AI Research Hackathon track", TRACKS[2]!)).toBe(true);
    expect(namesTrack("for example, I'm entering", TRACKS[1]!)).toBe(false);
  });
  test("namesItem: a content word of the item, by its first five letters", () => {
    expect(namesItem("I submitted on Devpost", DRAFTS.label)).toBe(true);
    expect(namesItem("the Modal credits form is done", "Fill in the Modal credits form")).toBe(true);
    expect(namesItem("done with that one", DRAFTS.label)).toBe(false);
  });

  test("\"I'm entering the Modal track\": entered with provenance; the reply counts its Ship items", async () => {
    await inEvent(async () => {
      const q = "I'm entering the Modal track";
      expect(await writes().exec("set_entered", { quote: q, enter: ["track:luma#modal"] }, { text: q, at })).toEqual({ line: "Entered Best Use of Modal: Ship lists 2 items for it, 0 done. You're entering 1 track." });
      expect(read("entered.json")).toEqual({ "track:luma#modal": { source: "chat", at, quote: q } });
    });
  });

  test("leaving a track is asked first; yes applies it", async () => {
    await inEvent(async () => {
      const w = writes();
      await w.exec("set_entered", { quote: "I'm entering the Modal track", enter: ["track:luma#modal"] }, { text: "I'm entering the Modal track", at });
      const q = "drop the Modal track for me";
      expect(await w.exec("set_entered", { quote: q, leave: ["track:luma#modal"] }, { text: q, at })).toEqual({ confirm: "That takes Best Use of Modal off the tracks you're entering. Reply yes within 10 minutes to do it; anything else cancels." });
      expect(Object.keys(read("entered.json"))).toEqual(["track:luma#modal"]);
      expect(await w.confirm("yes", "2026-11-14T19:01:00.000Z")).toBe("Left Best Use of Modal. You're entering 0 tracks.");
      expect(read("entered.json")).toEqual({});
    });
  });

  test("\"I submitted on Devpost\": the item ticked with provenance; the reply counts its section", async () => {
    await inEvent(async () => {
      const q = "I submitted on Devpost just now";
      expect(await writes().exec("tick_ship_item", { quote: q, item_id: "standing:drafts", done: true }, { text: q, at })).toEqual({ line: 'Ticked: "Submit on Devpost, not just save a draft". Required to submit: 1 of 1 done.' });
      expect(read("ship_ticks.json")).toEqual({ "standing:drafts": { source: "chat", at, quote: q } });
    });
  });

  test("a track or item the message doesn't name, or one not on this event, changes nothing", async () => {
    await inEvent(async () => {
      const w = writes();
      const said = { text: "what are the judging rules here?", at };
      expect(await w.exec("set_entered", { quote: "the judging rules here", enter: ["track:luma#exa"] }, said)).toEqual({ error: "your message doesn't name that track" });
      expect(await w.exec("set_entered", { quote: "the judging rules here", enter: ["track:other"] }, said)).toEqual({ error: "that isn't a track on this event's pages" });
      expect(await w.exec("tick_ship_item", { quote: "the judging rules here", item_id: "standing:drafts", done: true }, said)).toEqual({ error: "your message doesn't name that item" });
      expect(await w.exec("tick_ship_item", { quote: "the judging rules here", item_id: "made-up", done: true }, said)).toEqual({ error: "that isn't an item on your Ship checklist" });
      expect([read("entered.json"), read("ship_ticks.json"), existsSync("data/writes.jsonl")]).toEqual([null, null, false]);
    });
  });
});

describe("slice 3: what a rep told you", () => {
  const TRACKS = [{ track_id: "track:luma#modal", name: "Best Use of Modal", sponsor: "Modal" }];
  const at = "2026-11-14T19:00:00.000Z";
  const inEvent = async (f: () => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "hr-slice3-"));
    mkdirSync(join(root, "data"), { recursive: true });
    const was = process.cwd();
    process.chdir(root);
    try {
      writeFileSync("data/plan.json", JSON.stringify({ input: { idea: "AI research labs", stack: [{ name: "Modal", used_for: "training runs" }] }, counts: { gaps: 0, booths: 2 }, tracks: [{ track_id: "track:luma#modal", name: "Best Use of Modal", fit: "possible" }] }));
      await f();
    } finally {
      process.chdir(was);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const writes = (page: string[], seen: unknown[] = []) =>
    makeWrites({
      rerun: async (input, rerank) => {
        seen.push(rerank);
        const p = JSON.parse(readFileSync("data/plan.json", "utf8"));
        writeFileSync("data/plan.json", JSON.stringify({ ...p, input, counts: { gaps: 1, booths: 3 }, tracks: [{ ...p.tracks[0], fit: "likely" }] }));
        return null;
      },
      credits: () => [],
      tracks: () => TRACKS,
      ship: () => ({ deadline: null, required: [], tracks: [], choices: [], judging: [] }),
      pageLines: () => page,
    });

  test("recorded with the hacker's words and the rep; its track re-ranked and gap-checked; the page's lines shown beside it", async () => {
    await inEvent(async () => {
      const q = "Sam at the Modal booth said the project has to use Modal Sandboxes";
      const seen: unknown[] = [];
      const r = await writes(["Projects must deploy on Modal."], seen).exec("record_rep_note", { quote: q, track_id: "track:luma#modal", kind: "requirement", text: "the project has to use Modal Sandboxes", rep: "Sam at the Modal booth" }, { text: q, at });
      expect(r).toEqual({ line: 'Noted for Best Use of Modal, told to Donna by Sam at the Modal booth: "the project has to use Modal Sandboxes" (requirement). Tracks: Best Use of Modal possible → likely; gaps 0 → 1, booth questions 2 → 3. The page states for it: "Projects must deploy on Modal.". Both are kept; the page wins where they differ.' });
      expect(readRepNotes()).toEqual([{ id: "rep:track:luma#modal#1", track_id: "track:luma#modal", kind: "requirement", text: "the project has to use Modal Sandboxes", rep: "Sam at the Modal booth", told: { source: "chat", at, quote: q } }]);
      expect(seen).toEqual([{ before: { idea: "AI research labs", stack: [{ name: "Modal", used_for: "training runs" }] }, changed: [], beforeNotes: [], tracks: ["track:luma#modal"] }]);
      expect(JSON.parse(readFileSync("data/writes.jsonl", "utf8").trim()).op).toBe("record_rep_note");
    });
  });
  test("no rep named: \"a rep\"; a page with no lines says so", async () => {
    await inEvent(async () => {
      const q = "the Modal people said judges care most about cold start times";
      const r = await writes([]).exec("record_rep_note", { quote: q, track_id: "track:luma#modal", kind: "criterion", text: "judges care most about cold start times" }, { text: q, at });
      expect("line" in r && r.line.startsWith('Noted for Best Use of Modal, told to Donna by a rep: "judges care most about cold start times" (criterion).')).toBe(true);
      expect("line" in r && r.line.endsWith("The page states no requirements for it.")).toBe(true);
    });
  });
  test("the track, the rep's words and the rep's name must all be in the message; otherwise nothing is written", async () => {
    await inEvent(async () => {
      const w = writes([]);
      const q = "Sam at the Modal booth said the project has to use Modal Sandboxes";
      const said = { text: q, at };
      const base = { quote: q, track_id: "track:luma#modal", kind: "requirement" };
      expect(await w.exec("record_rep_note", { ...base, text: "the project must win first place" }, said)).toEqual({ error: "I couldn't find what the rep said in your message's own words" });
      expect(await w.exec("record_rep_note", { ...base, text: "the project has to use Modal Sandboxes", rep: "Priya" }, said)).toEqual({ error: "your message doesn't name that rep" });
      expect(await w.exec("record_rep_note", { ...base, track_id: "track:other", text: "the project has to use Modal Sandboxes" }, said)).toEqual({ error: "that isn't a track on this event's pages" });
      const other = "the judging rules say the project has to use Sandboxes";
      expect(await w.exec("record_rep_note", { ...base, quote: other, text: "the project has to use Sandboxes" }, { text: other, at })).toEqual({ error: "your message doesn't name that track" });
      expect([readRepNotes(), existsSync("data/writes.jsonl")]).toEqual([[], false]);
    });
  });
});

describe("slice 4: teammates and their skills", () => {
  const at = "2026-11-14T19:00:00.000Z";
  const inEvent = async (f: () => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "hr-slice4-"));
    mkdirSync(join(root, "data"), { recursive: true });
    const was = process.cwd();
    process.chdir(root);
    try {
      writeFileSync("data/plan.json", JSON.stringify({ input: { idea: "AI research labs", stack: null }, counts: { gaps: 0, booths: 2 }, tracks: [{ track_id: "t", name: "Best Use of Modal", fit: "possible" }] }));
      await f();
    } finally {
      process.chdir(was);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const writes = (seen: unknown[] = []) =>
    makeWrites({
      rerun: async (input, rerank) => {
        seen.push([input, rerank]);
        const p = JSON.parse(readFileSync("data/plan.json", "utf8"));
        writeFileSync("data/plan.json", JSON.stringify({ ...p, counts: { gaps: 2, booths: 3, gaps_nobody: 1 }, tracks: [{ ...p.tracks[0], fit: "likely" }] }));
        return null;
      },
      credits: () => [],
      tracks: () => [],
      ship: () => ({ deadline: null, required: [], tracks: [], choices: [], judging: [] }),
      pageLines: () => [],
    });

  test("someone joined: recorded with each skill's provenance; every track re-ranked and gaps re-checked; the line splits the gaps", async () => {
    await inEvent(async () => {
      const seen: unknown[] = [];
      const q = "Priya joined the team, she does React and Figma";
      expect(await writes(seen).exec("set_teammate", { quote: q, name: "Priya", skills: ["React", "Figma"] }, { text: q, at })).toEqual({
        line: "Priya joined the team: React, Figma. Team skills: Priya: React, Figma. Tracks: Best Use of Modal possible → likely; gaps 0 → 2 (1 nobody on the team lists a skill for), booth questions 2 → 3.",
      });
      const told = { source: "chat" as const, at, quote: q };
      // The raise is recorded under Priya, with the judgment before it, so her leaving can put it back.
      expect(readTeam()).toEqual([{ id: "priya", name: "Priya", skills: [{ name: "React", told }, { name: "Figma", told }], told, raised: { t: { fit: "possible", reason: "", quote: "" } } }]);
      // Every track on the Plan is judged again with the team's skills, plus any a new skill names.
      const input = { idea: "AI research labs", stack: null };
      expect(seen).toEqual([[input, { before: input, changed: ["React", "Figma"], tracks: ["t"], beforeTeam: [], monotone: "up" }]]);
    });
  });
  test("my own skills, then a skill added to a teammate", async () => {
    await inEvent(async () => {
      const w = writes();
      const q = "I know Rust and CUDA";
      const r = await w.exec("set_teammate", { quote: q, name: "me", skills: ["Rust", "CUDA"] }, { text: q, at });
      expect("line" in r && r.line.startsWith("Your skills: Rust, CUDA. Team skills: you: Rust, CUDA.")).toBe(true);
      await w.exec("set_teammate", { quote: "Priya joined the team, she does React", name: "Priya", skills: ["React"] }, { text: "Priya joined the team, she does React", at });
      const q2 = "Priya also knows Postgres";
      const r2 = await w.exec("set_teammate", { quote: q2, name: "Priya", skills: ["Postgres"] }, { text: q2, at });
      expect("line" in r2 && r2.line.startsWith("Priya's skills: Postgres. Team skills: you: Rust, CUDA; Priya: React, Postgres.")).toBe(true);
    });
  });
  test("someone leaving is asked first; yes takes them and their skills off", async () => {
    await inEvent(async () => {
      const w = writes();
      await w.exec("set_teammate", { quote: "Priya joined the team, she does React", name: "Priya", skills: ["React"] }, { text: "Priya joined the team, she does React", at });
      const q = "Priya left the team to go home";
      expect(await w.exec("set_teammate", { quote: q, name: "Priya", left: true }, { text: q, at })).toEqual({ confirm: "That takes Priya off your team, with their skills (React), and re-ranks your Plan without them. Reply yes within 10 minutes to do it; anything else cancels." });
      expect(readTeam().length).toBe(1);
      expect((await w.confirm("yes", "2026-11-14T19:01:00.000Z"))?.startsWith("Priya left the team. Team skills: none listed.")).toBe(true);
      expect(readTeam()).toEqual([]);
    });
  });
  test("the teammate and each skill must be in the message; otherwise nothing is written", async () => {
    await inEvent(async () => {
      const w = writes();
      const q = "someone new joined who does React";
      expect(await w.exec("set_teammate", { quote: q, name: "Priya", skills: ["React"] }, { text: q, at })).toEqual({ error: "your message doesn't name that teammate" });
      const q2 = "Priya joined the team today";
      expect(await w.exec("set_teammate", { quote: q2, name: "Priya", skills: ["React"] }, { text: q2, at })).toEqual({ error: "your message doesn't name each of those skills" });
      const q3 = "the team wants to know about React";
      expect(await w.exec("set_teammate", { quote: q3, name: "me", skills: ["React"] }, { text: q3, at })).toEqual({ error: "your message doesn't name that teammate" });
      expect([readTeam(), existsSync("data/writes.jsonl")]).toEqual([[], false]);
    });
  });
});
