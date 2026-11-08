// Chat writes (user 2026-11-08): what the hacker tells Donna, or sets on the board, about their own Plan and event
// state. One store in the event's data/ (gitignored), read by the board and by Donna alike. Every write carries
// provenance (told: source, time, the hacker's words). These are the hacker's own facts, the weakest tier: they never
// enter canon, and the Plan labels them "told to Donna". The model proposes a write; the functions here decide it.
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardOffer } from "./board.ts";
import { readJsonFile, writeJsonFile } from "./classify.ts";
import type { PlanFacts } from "./alerts.ts";
import { CLAIMS_PATH, PENDING_WRITE_PATH, PLAN_PATH, WRITES_LOG_PATH } from "./event.ts";
import type { PlanInput, StackItem } from "./plan.ts";
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

/** A write rests on the hacker's own words: its quote must be in their message, verbatim (case and spacing aside).
 *  A post in the context can't supply one, because a post isn't the message. */
export function quoteInMessage(quote: unknown, message: string): quote is string {
  return typeof quote === "string" && norm(quote).length >= 2 && norm(message).includes(norm(quote));
}

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
  const head = `Stack: ${what}.`;
  if (rerunError) return `${head} Re-ranking didn't run (${rerunError}); your Plan shows the old ranking until it does.`;
  if (!after) return head;
  const was = new Map((before?.tracks ?? []).map((t) => [t.track_id, t.fit]));
  const now = new Map(after.tracks.map((t) => [t.track_id, t]));
  const moved = [
    ...after.tracks.filter((t) => was.get(t.track_id) !== t.fit).map((t) => `${t.name} ${was.get(t.track_id) ?? "unranked"} → ${t.fit}`),
    ...(before?.tracks ?? []).filter((t) => !now.has(t.track_id)).map((t) => `${t.name} ${t.fit} → unranked`),
  ];
  const count = (label: string, a: number | null | undefined, b: number | null) => (b === null ? "" : a === b || a === undefined || a === null ? `${label} ${b}` : `${label} ${a} → ${b}`);
  const counts = [count("gaps", before?.gaps, after.gaps), count("booth questions", before?.booths, after.booths)].filter(Boolean).join(", ");
  return `${head} Tracks: ${moved.length ? moved.join("; ") : "no change"}${counts ? `; ${counts}` : ""}.`;
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
export interface PendingWrite {
  op: "update_stack";
  input: StackUpdate;
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
export const YES = /^\s*(yes|y|yep|yeah|confirm|confirmed|do it|go ahead)\b/i;
export const NO = /^\s*(no|n|nope|cancel|stop|don't|do not)\b/i;

/** Applies one proposed write: a one-line report, a question to confirm, or why not (agent.ts WriteExec). */
export type WriteResult = { line: string } | { confirm: string } | { error: string };

/** The chat write path for the current event (hr runs in its directory, so every path here is that event's data/).
 *  `rerun` re-runs the Plan on a new input (ranking, gaps, booths), saving it to plan.json; `credits` lists what can
 *  be claimed. A stack write saves the input first, so a failed re-run still keeps what the hacker said. */
export function makeWrites(deps: { rerun: (input: PlanInput) => Promise<{ error: string } | null>; credits: () => ClaimableCredit[] }) {
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
      const failed = await deps.rerun(input);
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
      const claimed = input.claimed !== false;
      setClaim(c.id, claimed, told);
      const line = claimLine(c, claimed, credits, readClaims());
      logWrite({ at: told.at, source: "chat", quote: told.quote, op: "mark_claimed", input: { credit_id: c.id, claimed }, result: line });
      return { line };
    }
    return { error: `${name} isn't a change I can make` };
  };

  /** A message that settles a pending write: "yes" applies it, "no" cancels it with a reply, anything else (or a reply
   *  after it expired) cancels it and is answered as usual (null). */
  const confirm = async (text: string, at: string): Promise<string | null> => {
    const p = readPending();
    if (!p) return null;
    clearPending();
    if (Date.parse(at) > Date.parse(p.expires_at)) return null;
    if (YES.test(text)) {
      const r = await applyStack(p.input, { ...p.told, at }, p.op);
      return "line" in r ? r.line : `I didn't change anything: ${"error" in r ? r.error : ""}.`;
    }
    logWrite({ at, source: "chat", quote: text, op: `${p.op} cancelled`, input: p.input, result: "cancelled" });
    return NO.test(text) ? "Cancelled: your stack is unchanged." : null;
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
