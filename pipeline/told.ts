// Chat writes (user 2026-11-08): what the hacker tells Donna, or sets on the board, about their own Plan and event
// state. One store in the event's data/ (gitignored), read by the board and by Donna alike. Every write carries
// provenance (told: source, time, the hacker's words). These are the hacker's own facts, the weakest tier: they never
// enter canon, and the Plan labels them "told to Donna". The model proposes a write; the functions here decide it.
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardOffer } from "./board.ts";
import { readJsonFile, writeJsonFile } from "./classify.ts";
import type { PlanFacts } from "./alerts.ts";
import { CLAIMS_PATH, ENTERED_PATH, PENDING_WRITE_PATH, PLAN_PATH, REP_NOTES_PATH, SHIP_TICKS_PATH, WRITES_LOG_PATH } from "./event.ts";
import type { ShipItem, ShipList } from "./shiplist.ts";
import type { PlanInput, StackItem, StackRerank } from "./plan.ts";
import type { Entity } from "./schema.ts";

export interface Told {
  source: "chat" | "board";
  at: string;
  /** The hacker's own words, verbatim (chat); null from the board. */
  quote: string | null;
}

/** A stack item, with where it came from when it was told rather than typed into the Plan form. */
export type ToldStackItem = StackItem & { told?: Told };

/** A credit the hacker can mark claimed: a board offer (by its id), or a per-hacker credit the event's page states. */
export interface ClaimableCredit {
  id: string;
  sponsor: string;
  value: string;
  /** Verbatim from its source. */
  quote: string;
  source_url: string;
  from: "page" | "offer";
}

/** "$250 in Modal credits": one per-hacker credit inside an "every entrant" prize's award text. */
const CREDIT = /\$[\d,]+\s+in\s+([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*)*)\s+credits/g;
const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");

/** The page's per-hacker credits: each "$N in X credits" in a prize every entrant gets, or the whole award when it
 *  speaks of credits without naming them. Other every-entrant awards (a raffle entry, swag) aren't credits to claim.
 *  Ids hang off the prize's canon id, so they hold across re-reads that keep it. */
export function pageCredits(entities: Entity[]): ClaimableCredit[] {
  return entities
    .filter((e) => e.kind === "prize" && /every entrant/i.test(String(e.fields.place?.value ?? "")))
    .flatMap((p) => {
      const award = String(p.fields.award_text?.value ?? p.name.value ?? "");
      const url = p.name.source.url;
      const parts = [...award.matchAll(CREDIT)];
      if (!parts.length) return /\bcredits?\b/i.test(award) ? [{ id: p.id, sponsor: p.sponsor, value: award, quote: award, source_url: url, from: "page" as const }] : [];
      return parts.map((m) => ({ id: `${p.id}/${slug(m[1]!)}`, sponsor: m[1]!, value: m[0], quote: m[0], source_url: url, from: "page" as const }));
    });
}

export function claimableCredits(entities: Entity[], offers: Pick<BoardOffer, "id" | "sponsor" | "title" | "value_short" | "excerpt">[]): ClaimableCredit[] {
  return [...pageCredits(entities), ...offers.map((o) => ({ id: o.id, sponsor: o.sponsor, value: o.value_short || o.title, quote: o.excerpt, source_url: "", from: "offer" as const }))];
}

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** A write rests on the hacker's own words: its quote must be in their message, verbatim (case and spacing aside),
 *  and at least three words. A post in the context can't supply one, because a post isn't the message. */
export function quoteInMessage(quote: unknown, message: string): quote is string {
  return typeof quote === "string" && norm(quote).split(" ").length >= 3 && norm(message).includes(norm(quote));
}

/** The message names what the write changes: each item added or removed, a clear in so many words, the credit's
 *  sponsor. A question that only mentions Modal can't add Modal unless it says to. */
export function messageNames(message: string, names: string[]): boolean {
  // Whole words, in order: "Exa" isn't named by "example", nor "R" by "run".
  const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const m = words(message);
  return names.every((n) => {
    const w = words(n);
    return w.length > 0 && m.some((_, i) => w.every((x, k) => m[i + k] === x));
  });
}
const CLEAR_WORDS = /\b(clear|empty|wipe|reset|remove (everything|all))\b/i;

export interface StackUpdate {
  add?: { name: string; used_for?: string | null }[];
  remove?: string[];
  clear?: boolean;
}

export type StackChange = { op: "add"; item: StackItem } | { op: "use"; name: string; from: string | null; to: string | null } | { op: "remove"; name: string };

/** The stack after an update, and what changed. An item already there (same name, any case) gets the new use
 *  instead of a duplicate; a removal must name an item that's there. `empties` is true when the update leaves an
 *  empty stack from a non-empty one: the caller confirms that first. */
export function applyStackUpdate(stack: ToldStackItem[], u: StackUpdate, told: Told): { stack: ToldStackItem[]; changes: StackChange[]; empties: boolean } | { error: string } {
  const key = (s: string) => s.trim().toLowerCase();
  let out = u.clear ? [] : [...stack];
  const changes: StackChange[] = u.clear ? stack.map((s) => ({ op: "remove" as const, name: s.name })) : [];
  for (const name of u.remove ?? []) {
    if (u.clear) break;
    const i = out.findIndex((s) => key(s.name) === key(name));
    if (i < 0) return { error: `${name} isn't in your stack` };
    changes.push({ op: "remove", name: out[i]!.name });
    out.splice(i, 1);
  }
  for (const a of u.add ?? []) {
    const name = a.name?.trim();
    if (!name) continue;
    const used = a.used_for?.trim() || null;
    const i = out.findIndex((s) => key(s.name) === key(name));
    if (i >= 0) {
      if ((out[i]!.used_for ?? null) === used || used === null) continue;
      changes.push({ op: "use", name: out[i]!.name, from: out[i]!.used_for, to: used });
      out[i] = { ...out[i]!, used_for: used, told };
    } else {
      changes.push({ op: "add", item: { name, used_for: used } });
      out = [...out, { name, used_for: used, told }];
    }
  }
  if (!changes.length) return { error: "that doesn't change your stack" };
  return { stack: out, changes, empties: stack.length > 0 && out.length === 0 };
}

/** The Plan's state a stack line reports against: each track's fit, and how many gaps and booth questions. */
export interface PlanSnapshot {
  tracks: { track_id: string; name: string; fit: string }[];
  gaps: number | null;
  booths: number | null;
}

/** One line: what the stack write changed, then what the re-run changed. */
export function stackWriteLine(changes: StackChange[], before: PlanSnapshot | null, after: PlanSnapshot | null, rerunError: string | null = null): string {
  const what = changes.map((c) => (c.op === "add" ? `added ${c.item.name}${c.item.used_for ? ` (${c.item.used_for})` : ""}` : c.op === "remove" ? `removed ${c.name}` : `${c.name} now for ${c.to}`)).join(", ");
  return `Stack: ${what}.${planChangeLine(before, after, rerunError)}`;
}

/** What a re-run changed, after a write: each fit that moved, then the gap and booth counts (" Tracks: …; gaps …."). */
export function planChangeLine(before: PlanSnapshot | null, after: PlanSnapshot | null, rerunError: string | null = null): string {
  if (rerunError) return ` Re-ranking didn't run (${rerunError}); your Plan shows the old ranking until it does.`;
  if (!after) return "";
  const was = new Map((before?.tracks ?? []).map((t) => [t.track_id, t.fit]));
  const now = new Map(after.tracks.map((t) => [t.track_id, t]));
  const moved = [
    ...after.tracks.filter((t) => was.get(t.track_id) !== t.fit).map((t) => `${t.name} ${was.get(t.track_id) ?? "unranked"} → ${t.fit}`),
    ...(before?.tracks ?? []).filter((t) => !now.has(t.track_id)).map((t) => `${t.name} ${t.fit} → unranked`),
  ];
  const count = (label: string, a: number | null | undefined, b: number | null) => (b === null ? "" : a === b || a === undefined || a === null ? `${label} ${b}` : `${label} ${a} → ${b}`);
  const counts = [count("gaps", before?.gaps, after.gaps), count("booth questions", before?.booths, after.booths)].filter(Boolean).join(", ");
  return ` Tracks: ${moved.length ? moved.join("; ") : "no change"}${counts ? `; ${counts}` : ""}.`;
}

// The store.
export type Claims = Record<string, Told>;
export const readClaims = (): Claims => readJsonFile<Claims>(CLAIMS_PATH, {});

export function setClaim(id: string, claimed: boolean, told: Told): void {
  const all = readClaims();
  if (claimed) all[id] = told;
  else delete all[id];
  writeJsonFile(CLAIMS_PATH, all);
}

export function claimLine(c: ClaimableCredit, claimed: boolean, credits: ClaimableCredit[], claims: Claims): string {
  const page = credits.filter((x) => x.from === "page");
  const of = page.length ? ` ${page.filter((x) => claims[x.id]).length} of ${page.length} per-hacker credits claimed.` : "";
  return `${claimed ? "Marked claimed" : "Marked not claimed"}: ${c.value} (${c.sponsor}).${of}`;
}

// Slice 2: the tracks the hacker is entering and their Ship ticks, by track id and checklist item id.
export type Entered = Record<string, Told>;
export type Ticks = Record<string, Told>;
export const readEntered = (): Entered => readJsonFile<Entered>(ENTERED_PATH, {});
export const readTicks = (): Ticks => readJsonFile<Ticks>(SHIP_TICKS_PATH, {});
function setIn(path: string, id: string, on: boolean, told: Told): void {
  const all = readJsonFile<Record<string, Told>>(path, {});
  if (on) all[id] = told;
  else delete all[id];
  writeJsonFile(path, all);
}
export const setEntered = (id: string, on: boolean, told: Told) => setIn(ENTERED_PATH, id, on, told);
export const setTick = (id: string, on: boolean, told: Told) => setIn(SHIP_TICKS_PATH, id, on, told);

export interface EnteredUpdate {
  enter: string[];
  leave: string[];
}
export interface TrackRef {
  track_id: string;
  name: string;
  sponsor: string;
}

/** A track is named by its sponsor (an event-level track has none to name) or its full name, as whole words. */
export function namesTrack(message: string, t: TrackRef): boolean {
  return (t.sponsor !== "event" && messageNames(message, [t.sponsor])) || messageNames(message, [t.name]);
}

const STOP = new Set(["your", "with", "that", "this", "from", "into", "just", "about", "must", "have", "will", "each", "their", "they", "them", "what", "when", "where", "before", "after", "only", "also", "more", "than", "then", "team", "teams", "make", "sure"]);
/** A Ship item is named when the message shares one of its content words, by its first five letters ("submitted"
 *  names "Submit on Devpost", "video" names "a 2-minute demo video"). Ticks are easy to undo, so this is looser than
 *  a stack item's whole name. */
export function namesItem(message: string, label: string): boolean {
  const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !STOP.has(w));
  const key = (w: string) => w.slice(0, 5);
  const m = new Set(words(message).map(key));
  return words(label).some((w) => m.has(key(w)));
}

/** Every item the checklist can hold: required, each entered track's, judging. */
export const shipItems = (l: ShipList): (ShipItem & { section: string })[] => [
  ...l.required.map((x) => ({ ...x, section: "Required to submit" })),
  ...l.tracks.flatMap((t) => t.items.map((x) => ({ ...x, section: t.name }))),
  ...l.judging.map((x) => ({ ...x, section: "Judging" })),
];

// Slice 3: what a rep said at a booth. The weakest tier: it never replaces the page's lines, which are shown beside it.
export interface RepNote {
  id: string;
  track_id: string;
  kind: "requirement" | "criterion";
  /** The hacker's words, verbatim from their message. */
  text: string;
  /** The rep, when the hacker named one ("Sam at the Modal booth"). */
  rep: string | null;
  told: Told;
}
export const readRepNotes = (): RepNote[] => readJsonFile<RepNote[]>(REP_NOTES_PATH, []);
export function addRepNote(n: Omit<RepNote, "id">): RepNote {
  const all = readRepNotes();
  const note = { id: `rep:${n.track_id}#${all.length + 1}`, ...n };
  writeJsonFile(REP_NOTES_PATH, [...all, note]);
  return note;
}
/** How a note reads wherever it's shown: "told to Donna by Sam at the Modal booth" / "told to Donna by a rep". */
export const repSource = (n: Pick<RepNote, "rep">) => `told to Donna by ${n.rep ?? "a rep"}`;

export interface WriteRecord {
  at: string;
  source: Told["source"];
  quote: string | null;
  op: string;
  input: unknown;
  result: string;
}
export function logWrite(r: WriteRecord): void {
  mkdirSync(dirname(WRITES_LOG_PATH), { recursive: true });
  appendFileSync(WRITES_LOG_PATH, JSON.stringify(r) + "\n");
}

/** A destructive write waiting for "yes" (10 minutes). */
export const CONFIRM_MS = 10 * 60_000;
export type PendingWrite = PendingBase & ({ op: "update_stack"; input: StackUpdate } | { op: "set_entered"; input: EnteredUpdate });
interface PendingBase {
  told: Told;
  /** What Donna asked, for the log. */
  asked: string;
  expires_at: string;
}
export const readPending = (): PendingWrite | null => readJsonFile<PendingWrite | null>(PENDING_WRITE_PATH, null);
export const savePending = (p: PendingWrite) => writeJsonFile(PENDING_WRITE_PATH, p);
export function clearPending(): void {
  if (existsSync(PENDING_WRITE_PATH)) unlinkSync(PENDING_WRITE_PATH);
}
/** A confirmation is the whole message ("yes", "yes!"), never a reply that merely starts with it. */
export const YES = /^\s*(yes|y|yep|yeah|confirm|confirmed|do it|go ahead)[\s.!]*$/i;
export const NO = /^\s*(no|n|nope|cancel|stop|don't|do not)[\s.!]*$/i;

/** Applies one proposed write: a one-line report, a question to confirm, or why not (agent.ts WriteExec). */
export type WriteResult = { line: string } | { confirm: string } | { error: string };

/** The chat write path for the current event (hr runs in its directory, so every path here is that event's data/).
 *  `rerun` re-runs the Plan on a new input (ranking, gaps, booths), saving it to plan.json; `credits` lists what can
 *  be claimed. A stack write saves the input first, so a failed re-run still keeps what the hacker said. */
export function makeWrites(deps: {
  rerun: (input: PlanInput, rerank: StackRerank) => Promise<{ error: string } | null>;
  credits: () => ClaimableCredit[];
  /** The event's tracks (canon), and its Ship checklist for a set of entered track ids. */
  tracks: () => TrackRef[];
  ship: (entered: string[]) => ShipList;
  /** The page's own requirement and criterion lines for a track, shown beside a rep's note (never replaced by it). */
  pageLines: (track_id: string) => string[];
}) {
  const snapshot = (p: PlanFacts | null): PlanSnapshot | null => (p ? { tracks: (p.tracks ?? []).map((t) => ({ track_id: t.track_id ?? t.name, name: t.name, fit: t.fit })), gaps: p.counts?.gaps ?? null, booths: p.counts?.booths ?? null } : null);
  const applyStack = async (u: StackUpdate, told: Told, op: string): Promise<WriteResult> => {
    const plan = readJsonFile<PlanFacts | null>(PLAN_PATH, null);
    if (!plan) return { error: "there's no Plan yet to change (make one on the board or with hr plan)" };
    const r = applyStackUpdate(plan.input.stack ?? [], u, told);
    if ("error" in r) return r;
    const input: PlanInput = { idea: plan.input.idea, stack: r.stack.length ? r.stack : null, ...(plan.input.repo ? { repo: plan.input.repo } : {}) };
    writeJsonFile(PLAN_PATH, { ...plan, saved_at: new Date().toISOString(), input });
    let line: string;
    try {
      // Only the tracks the change names are re-ranked (plan.ts affectedTracks); the rest keep their last ranking.
      const changed = r.changes.map((c) => (c.op === "add" ? c.item.name : c.name));
      const failed = await deps.rerun(input, { before: { idea: plan.input.idea, stack: plan.input.stack, ...(plan.input.repo ? { repo: plan.input.repo } : {}) }, changed });
      line = stackWriteLine(r.changes, snapshot(plan), failed ? null : snapshot(readJsonFile<PlanFacts | null>(PLAN_PATH, null)), failed?.error ?? null);
    } catch (e) {
      line = stackWriteLine(r.changes, null, null, (e as Error).message);
    }
    logWrite({ at: told.at, source: told.source, quote: told.quote, op, input: u, result: line });
    return { line };
  };

  const exec = async (name: string, input: Record<string, unknown>, msg: { text: string; at: string }): Promise<WriteResult> => {
    if (!quoteInMessage(input.quote, msg.text)) return { error: "I couldn't tie that change to your message's own words" };
    const told: Told = { source: "chat", at: msg.at, quote: input.quote };
    if (name === "update_stack") {
      const u = stackUpdateOf(input);
      if (!messageNames(msg.text, [...(u.add ?? []).map((a) => a.name), ...(u.remove ?? [])]) || (u.clear && !CLEAR_WORDS.test(msg.text))) return { error: "your message doesn't name that change" };
      const plan = readJsonFile<PlanFacts | null>(PLAN_PATH, null);
      const dry = plan ? applyStackUpdate(plan.input.stack ?? [], u, told) : null;
      if (dry && !("error" in dry) && dry.empties) {
        const asked = `That leaves your stack empty (removing ${(plan!.input.stack ?? []).map((s) => s.name).join(", ")}). Reply yes within 10 minutes to do it; anything else cancels.`;
        savePending({ op: "update_stack", input: u, told, asked, expires_at: new Date(Date.parse(msg.at) + CONFIRM_MS).toISOString() });
        logWrite({ at: told.at, source: "chat", quote: told.quote, op: "update_stack asked", input: u, result: asked });
        return { confirm: asked };
      }
      return applyStack(u, told, "update_stack");
    }
    if (name === "mark_claimed") {
      const credits = deps.credits();
      const c = credits.find((x) => x.id === input.credit_id);
      if (!c) return { error: "that isn't one of the credits I know of" };
      if (!messageNames(msg.text, [c.sponsor])) return { error: "your message doesn't name that credit" };
      const claimed = input.claimed !== false;
      setClaim(c.id, claimed, told);
      const line = claimLine(c, claimed, credits, readClaims());
      logWrite({ at: told.at, source: "chat", quote: told.quote, op: "mark_claimed", input: { credit_id: c.id, claimed }, result: line });
      return { line };
    }
    if (name === "set_entered") {
      const tracks = deps.tracks();
      const byId = new Map(tracks.map((t) => [t.track_id, t]));
      const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const u: EnteredUpdate = { enter: ids(input.enter), leave: ids(input.leave) };
      const all = [...u.enter, ...u.leave];
      if (!all.length) return { error: "that doesn't name a track" };
      const unknown = all.filter((id) => !byId.has(id));
      if (unknown.length) return { error: "that isn't a track on this event's pages" };
      if (!all.every((id) => namesTrack(msg.text, byId.get(id)!))) return { error: "your message doesn't name that track" };
      const now = readEntered();
      u.enter = u.enter.filter((id) => !now[id]);
      u.leave = u.leave.filter((id) => now[id]);
      if (!u.enter.length && !u.leave.length) return { error: "that doesn't change the tracks you're entering" };
      if (u.leave.length) {
        const asked = `That takes ${u.leave.map((id) => byId.get(id)!.name).join(", ")} off the tracks you're entering. Reply yes within 10 minutes to do it; anything else cancels.`;
        savePending({ op: "set_entered", input: u, told, asked, expires_at: new Date(Date.parse(msg.at) + CONFIRM_MS).toISOString() });
        logWrite({ at: told.at, source: "chat", quote: told.quote, op: "set_entered asked", input: u, result: asked });
        return { confirm: asked };
      }
      return applyEntered(u, told);
    }
    if (name === "record_rep_note") {
      const t = deps.tracks().find((x) => x.track_id === input.track_id);
      if (!t) return { error: "that isn't a track on this event's pages" };
      if (!namesTrack(msg.text, t)) return { error: "your message doesn't name that track" };
      // The note is the hacker's words, verbatim; a rep's name only when they gave one.
      if (!quoteInMessage(input.text, msg.text)) return { error: "I couldn't find what the rep said in your message's own words" };
      const rep = typeof input.rep === "string" && input.rep.trim() ? input.rep.trim() : null;
      if (rep && !messageNames(msg.text, [rep])) return { error: "your message doesn't name that rep" };
      const kind = input.kind === "criterion" ? "criterion" : "requirement";
      const beforeNotes = readRepNotes();
      const note = addRepNote({ track_id: t.track_id, kind, text: input.text, rep, told });
      const plan = readJsonFile<PlanFacts | null>(PLAN_PATH, null);
      let change = "";
      if (plan) {
        const input0: PlanInput = { idea: plan.input.idea, stack: plan.input.stack, ...(plan.input.repo ? { repo: plan.input.repo } : {}) };
        try {
          const failed = await deps.rerun(input0, { before: input0, changed: [], beforeNotes, tracks: [t.track_id] });
          change = planChangeLine(snapshot(plan), failed ? null : snapshot(readJsonFile<PlanFacts | null>(PLAN_PATH, null)), failed?.error ?? null);
        } catch (e) {
          change = planChangeLine(null, null, (e as Error).message);
        }
      }
      const page = deps.pageLines(t.track_id);
      const both = page.length ? ` The page states for it: ${page.map((l) => `"${l}"`).join("; ")}. Both are kept; the page wins where they differ.` : " The page states no requirements for it.";
      const line = `Noted for ${t.name}, ${repSource(note)}: "${note.text}" (${kind}).${change}${both}`;
      logWrite({ at: told.at, source: "chat", quote: told.quote, op: "record_rep_note", input: { track_id: t.track_id, kind, text: note.text, rep }, result: line });
      return { line };
    }
    if (name === "tick_ship_item") {
      const items = shipItems(deps.ship(deps.tracks().map((t) => t.track_id)));
      const it = items.find((x) => x.id === input.item_id);
      if (!it) return { error: "that isn't an item on your Ship checklist" };
      if (!namesItem(msg.text, it.label)) return { error: "your message doesn't name that item" };
      const done = input.done !== false;
      setTick(it.id, done, told);
      const line = tickLine(it, done);
      logWrite({ at: told.at, source: "chat", quote: told.quote, op: "tick_ship_item", input: { item_id: it.id, done }, result: line });
      return { line };
    }
    return { error: `${name} isn't a change I can make` };
  };

  const applyEntered = (u: EnteredUpdate, told: Told): WriteResult => {
    const byId = new Map(deps.tracks().map((t) => [t.track_id, t]));
    for (const id of u.enter) setEntered(id, true, told);
    for (const id of u.leave) setEntered(id, false, told);
    const entered = Object.keys(readEntered());
    const list = deps.ship(entered);
    const ticks = readTicks();
    const parts = [
      ...u.enter.map((id) => {
        const items = list.tracks.find((t) => t.track_id === id)?.items ?? [];
        return `Entered ${byId.get(id)!.name}: ${items.length ? `Ship lists ${items.length} item${items.length === 1 ? "" : "s"} for it, ${items.filter((x) => ticks[x.id]).length} done` : "it states no entry steps or requirements"}.`;
      }),
      ...(u.leave.length ? [`Left ${u.leave.map((id) => byId.get(id)!.name).join(", ")}.`] : []),
    ];
    const line = `${parts.join(" ")} You're entering ${entered.length} track${entered.length === 1 ? "" : "s"}.`;
    logWrite({ at: told.at, source: told.source, quote: told.quote, op: "set_entered", input: u, result: line });
    return { line };
  };
  const tickLine = (it: ShipItem & { section: string }, done: boolean): string => {
    const ticks = readTicks();
    const list = deps.ship(Object.keys(readEntered()));
    const same = shipItems(list).filter((x) => x.section === it.section);
    const of = same.length ? ` ${it.section}: ${same.filter((x) => ticks[x.id]).length} of ${same.length} done.` : "";
    return `${done ? "Ticked" : "Unticked"}: "${it.label}".${of}`;
  };

  /** A message that settles a pending write: "yes" applies it, "no" cancels it with a reply, anything else (or a reply
   *  after it expired) cancels it and is answered as usual (null). */
  const confirm = async (text: string, at: string): Promise<string | null> => {
    const p = readPending();
    if (!p) return null;
    clearPending();
    if (Date.parse(at) > Date.parse(p.expires_at)) return null;
    if (YES.test(text)) {
      const r = p.op === "set_entered" ? applyEntered(p.input, { ...p.told, at }) : await applyStack(p.input, { ...p.told, at }, p.op);
      return "line" in r ? r.line : `I didn't change anything: ${"error" in r ? r.error : ""}.`;
    }
    logWrite({ at, source: "chat", quote: text, op: `${p.op} cancelled`, input: p.input, result: "cancelled" });
    return NO.test(text) ? (p.op === "set_entered" ? "Cancelled: you're still entering the same tracks." : "Cancelled: your stack is unchanged.") : null;
  };
  return { exec, confirm };
}

function stackUpdateOf(input: Record<string, unknown>): StackUpdate {
  const add = (Array.isArray(input.add) ? input.add : []).flatMap((a) => {
    const x = a as { name?: unknown; used_for?: unknown } | null;
    return x && typeof x.name === "string" ? [{ name: x.name, used_for: typeof x.used_for === "string" ? x.used_for : null }] : [];
  });
  const remove = (Array.isArray(input.remove) ? input.remove : []).filter((x): x is string => typeof x === "string");
  return { add, remove, clear: input.clear === true };
}
