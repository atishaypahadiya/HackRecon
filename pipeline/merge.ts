// Merge (design doc §3, D13): page canon plus later changes, as one timeline. Pure code, no model.
//   1. A page's first snapshot is the baseline.
//   2. A later snapshot that changes a field is a page change, placed in its window (previous capture, this
//      capture], because the edit time is unknown.
//   3. Authorized Slack changes (D8) are placed at their post's time; an unauthorized one is kept in history with
//      status "unauthorized", never as the value. A question never sets a value.
//   4. The latest change wins. A Slack change inside a page change's window on the same field is ambiguous: both are
//      kept as "ambiguous" and neither wins, so the value stays what it was before them.
//   5. The baseline is kept (the first history entry's `from`). A Slack change that a later snapshot repeats
//      exactly collapses into the page: one entry, from the page.
import type { AppliedChange, Change, Entity, FieldValue } from "./schema.ts";

/** A canon page record (hr.ts CanonPage): only its entities matter here. */
type Snapshot = { entities: Entity[] };

/** A field a later snapshot changed, with its window: after the previous capture, by this one (ISO). */
export interface PageChange extends Change {
  window: { after: string; until: string };
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const NONE: FieldValue<unknown> = { value: null, source: { kind: "page", url: "", quote: "", captured_at: "" } };

/** When a page record was captured: the latest capture time among its entities' sources. */
export function capturedAt(p: Snapshot): string {
  return p.entities.flatMap((e) => [e.name.source.captured_at, ...Object.values(e.fields).map((f) => f.source.captured_at)]).filter(Boolean).sort().at(-1) ?? "";
}

/** Rule 2: every field of a kept entity (ids carried by canon's rematch) whose value differs between two
 *  snapshots of one page. A field that appears is a change from null; one that disappears, a change to null. */
export function pageChanges(prev: Snapshot, next: Snapshot): PageChange[] {
  const window = { after: capturedAt(prev), until: capturedAt(next) };
  const before = new Map(prev.entities.map((e) => [e.id, e]));
  const out: PageChange[] = [];
  for (const e of next.entities) {
    const old = before.get(e.id);
    if (!old) continue; // a new entity is new, not a change
    const fields = (x: Entity): Record<string, FieldValue<unknown>> => ({ name: x.name, ...x.fields });
    const a = fields(old), b = fields(e);
    for (const f of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (same(a[f]?.value ?? null, b[f]?.value ?? null)) continue;
      out.push({ entity_id: e.id, field: f, to: b[f] ?? { ...NONE, source: { ...NONE.source, kind: "page", url: a[f]!.source.url, captured_at: window.until } }, kind: "set", window });
    }
  }
  return out;
}

type Timed = { c: Change; at: number; page?: { after: number; until: number } };

/** One entity's fields after its changes, with every change in `history` (oldest first) and its status. */
export function merge(canon: Entity[], o: { page?: PageChange[]; slack?: Change[]; authorized: (c: Change, e: Entity) => boolean }): Entity[] {
  const byEntity = new Map<string, Timed[]>();
  const add = (t: Timed) => byEntity.set(t.c.entity_id, [...(byEntity.get(t.c.entity_id) ?? []), t]);
  for (const c of o.page ?? []) add({ c, at: ms(c.window.until), page: { after: ms(c.window.after), until: ms(c.window.until) } });
  for (const c of o.slack ?? []) add({ c, at: ms(c.to.source.posted_at ?? c.to.source.captured_at) });
  return canon.map((e) => {
    const changes = (byEntity.get(e.id) ?? []).sort((a, b) => a.at - b.at);
    if (!changes.length) return e;
    const fields: Record<string, FieldValue<unknown>> = { name: e.name, ...e.fields };
    const history: AppliedChange[] = [...e.history];
    const pages = changes.filter((t) => t.page);
    for (const t of changes) {
      const from = fields[t.c.field] ?? NONE;
      if (t.c.kind === "question") {
        history.push({ ...t.c, from, status: "question" });
        continue;
      }
      if (!t.page && !o.authorized(t.c, e)) {
        history.push({ ...t.c, from, status: "unauthorized" });
        continue;
      }
      // Rule 4: a Slack change inside a page change's window on the same field, and that page change, are ambiguous.
      const clash = t.page
        ? changes.some((s) => !s.page && s.c.field === t.c.field && s.c.kind === "set" && o.authorized(s.c, e) && s.at > t.page!.after && s.at <= t.page!.until)
        : pages.some((p) => p.c.field === t.c.field && t.at > p.page!.after && t.at <= p.page!.until);
      if (clash) {
        history.push({ ...t.c, from, status: "ambiguous" });
        continue;
      }
      // Rule 5: a page change repeating the applied Slack value collapses into it: one entry, from the page.
      let prior = -1;
      history.forEach((h, k) => h.field === t.c.field && h.status === "applied" && (prior = k));
      if (t.page && prior >= 0 && history[prior]!.to.source.kind === "slack" && same(history[prior]!.to.value, t.c.to.value)) {
        history[prior] = { ...t.c, from: history[prior]!.from, status: "applied" };
        fields[t.c.field] = t.c.to;
        continue;
      }
      history.push({ ...t.c, from, status: "applied" });
      fields[t.c.field] = t.c.to;
    }
    const { name, ...rest } = fields;
    return { ...e, name: name as FieldValue<string>, fields: rest, history };
  });
}

/** The value a field started with (rule 5: always shown beside the current one), or null when it never changed. */
export function baseline(e: Entity, field: string): FieldValue<unknown> | null {
  return e.history.find((h) => h.field === field && h.status === "applied")?.from ?? null;
}

/** Rule 4's line for a field left ambiguous, or null. */
export function disagreement(e: Entity, field: string): string | null {
  const page = e.history.find((h) => h.field === field && h.status === "ambiguous" && "window" in h) as (AppliedChange & { window: PageChange["window"] }) | undefined;
  return page ? `Page and Slack disagree; page changed between ${page.window.after} and ${page.window.until}` : null;
}
