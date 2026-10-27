// `hr preview`: the receipt's numbers from the current data, to choose the board headline before
// day 3. It is not the receipt: offers.ts (offer_key, cross-message merges, deadline linking) and
// the day-4 Opus credit pass aren't built, and reps aren't confirmed. It stands in for them:
//   - credits: the classifier's credit items, overlaid with the day-2 Opus label where a row has one
//     (what `hr sheet` pre-fills, D13): a label of "not a credit" drops the items, a single-credit
//     label supplies the amount and limit, a credit the classifier missed is added (D14);
//   - grouping: URL merge within a sponsor only (design doc, offer grouping step 1);
//   - reps: candidates by the A5 signals, before the day-3 confirmation.
import { labelProblems, type LabelRow } from "./labels.ts";
import type { Sponsors } from "./pool.ts";
import type { PosterRole } from "./roles.ts";
import type { Item, Message } from "./schema.ts";

export interface CreditOffer {
  message_id: string;
  ts: string;
  sponsor: string;
  permalink: string;
  amount_text: string;
  /** Stated USD per person, never estimated. */
  usd_per_person?: number;
  /** A resolved deadline or claim-window end. */
  limit_iso?: string;
  limit_unresolved: boolean;
  urls: string[];
  source: "classifier" | "opus label";
}

export interface OfferGroup {
  sponsor: string;
  offers: CreditOffer[];
  /** The first priced offer's amount, by post time. */
  usd_per_person?: number;
  /** Members state more than one per-person amount (flagged for the credit pass). */
  amount_conflict: boolean;
  has_limit: boolean;
  limit_unresolved_only: boolean;
}

const labeled = (r: LabelRow) => /^[yn]$/.test(r.is_credit) && /^[yn]$/.test(r.is_dated) && labelProblems(r).length === 0;

/** Credit offers per message: classifier items, with the Opus label overlaid where there is one. */
export function creditOffers(items: Item[], labels: LabelRow[], messages: Map<string, Message>): { offers: CreditOffer[]; dropped_by_label: number; added_by_label: number } {
  const byMsg = new Map<string, Item[]>();
  for (const it of items) if (it.kind === "credit") byMsg.set(it.message_id, [...(byMsg.get(it.message_id) ?? []), it]);
  const labelBy = new Map(labels.filter(labeled).map((r) => [r.message_id, r]));
  const offers: CreditOffer[] = [];
  let dropped = 0;
  let added = 0;
  const ids = new Set([...byMsg.keys(), ...[...labelBy.values()].filter((r) => r.is_credit === "y").map((r) => r.message_id)]);
  for (const id of ids) {
    const its = byMsg.get(id) ?? [];
    const r = labelBy.get(id);
    const m = messages.get(id);
    const base = { message_id: id, ts: m?.ts ?? id.split(":")[1]!, permalink: m?.permalink ?? r?.permalink ?? "" };
    if (r?.is_credit === "n") {
      dropped += its.length;
      continue;
    }
    if (r?.is_credit === "y" && (Number(r.credits_in_post) === 1 || !its.length)) {
      if (!its.length) added++;
      const n = Number(r.credits_in_post) === 1 ? 1 : Math.max(1, Number(r.credits_in_post));
      for (let k = 0; k < n; k++) {
        offers.push({
          ...base,
          sponsor: its[0]?.sponsor ?? r.sponsor,
          amount_text: n === 1 ? r.amount_text : "",
          ...(n === 1 && r.amount_usd_per_person ? { usd_per_person: Number(r.amount_usd_per_person) } : {}),
          ...(r.deadline_iso || r.window_end ? { limit_iso: r.deadline_iso || r.window_end } : {}),
          limit_unresolved: r.deadline_status === "unresolved",
          urls: [...new Set(its.flatMap((i) => i.urls))],
          source: "opus label",
        });
      }
      continue;
    }
    for (const it of its) {
      offers.push({
        ...base,
        sponsor: it.sponsor,
        amount_text: it.amount_text,
        ...(it.amount_usd_per_person !== undefined ? { usd_per_person: it.amount_usd_per_person } : {}),
        ...(it.deadline_iso ? { limit_iso: it.deadline_iso } : {}),
        limit_unresolved: it.deadline_status === "unresolved",
        urls: it.urls,
        source: "classifier",
      });
    }
  }
  return { offers, dropped_by_label: dropped, added_by_label: added };
}

/** URL merge: within a sponsor, offers that share any URL are one offer (transitively). */
export function urlMerge(offers: CreditOffer[]): OfferGroup[] {
  const parent = offers.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const seen = new Map<string, number>();
  offers.forEach((o, i) => {
    for (const u of o.urls) {
      const key = `${o.sponsor}\u0000${u}`;
      const j = seen.get(key);
      if (j === undefined) seen.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, CreditOffer[]>();
  offers.forEach((o, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), o]));
  return [...groups.values()].map((os) => {
    os.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const priced = os.filter((o) => o.usd_per_person !== undefined);
    return {
      sponsor: os[0]!.sponsor,
      offers: os,
      ...(priced.length ? { usd_per_person: priced[0]!.usd_per_person } : {}),
      amount_conflict: new Set(priced.map((o) => o.usd_per_person)).size > 1,
      has_limit: os.some((o) => o.limit_iso),
      limit_unresolved_only: !os.some((o) => o.limit_iso) && os.some((o) => o.limit_unresolved),
    };
  });
}

/** K: distinct (sponsor, deadline rounded to the nearest 30 minutes) over every dated item. */
export function deadlineKeys(items: Item[]): number {
  const half = 30 * 60 * 1000;
  return new Set(items.filter((i) => i.deadline_iso).map((i) => `${i.sponsor}|${Math.round(Date.parse(i.deadline_iso!) / half)}`)).size;
}

export interface RepCandidates {
  candidates: number;
  sponsors: number;
}

/** Sponsor-side posters in sponsor and cohost channels (A5 signals; organizers excluded by the role). */
export function repCandidates(messages: Message[], sponsors: Sponsors, role: (m: Message) => PosterRole): RepCandidates {
  const keys = new Set<string>();
  for (const m of messages) {
    const s = sponsors[m.channel_name];
    if (!s || s.sponsor === "event" || role(m) !== "sponsor-side") continue;
    keys.add(`${s.sponsor}|${m.author_name}`);
  }
  return { candidates: keys.size, sponsors: new Set([...keys].map((k) => k.split("|")[0])).size };
}

export interface Preview {
  channels: number;
  sponsors_in_capture: number;
  offers: number;
  priced: number;
  unpriced: number;
  usd_total: number;
  amount_conflicts: number;
  with_limit: number;
  limit_unresolved: number;
  no_limit: number;
  sponsors_with_credit: number;
  deadline_keys: number;
  reps: RepCandidates;
  dropped_by_label: number;
  added_by_label: number;
  priced_groups: OfferGroup[];
}

export function preview(o: { items: Item[]; labels: LabelRow[]; messages: Message[]; sponsors: Sponsors; channels: string[]; role: (m: Message) => PosterRole }): Preview {
  const msgs = new Map(o.messages.map((m) => [m.id, m]));
  const c = creditOffers(o.items, o.labels, msgs);
  const groups = urlMerge(c.offers);
  const priced = groups.filter((g) => g.usd_per_person !== undefined);
  const sponsorNames = new Set(o.channels.map((ch) => o.sponsors[ch]?.sponsor).filter((s): s is string => !!s && s !== "event"));
  return {
    channels: o.channels.length,
    sponsors_in_capture: sponsorNames.size,
    offers: groups.length,
    priced: priced.length,
    unpriced: groups.length - priced.length,
    usd_total: priced.reduce((n, g) => n + g.usd_per_person!, 0),
    amount_conflicts: groups.filter((g) => g.amount_conflict).length,
    with_limit: groups.filter((g) => g.has_limit).length,
    limit_unresolved: groups.filter((g) => g.limit_unresolved_only).length,
    no_limit: groups.filter((g) => !g.has_limit && !g.limit_unresolved_only).length,
    sponsors_with_credit: new Set(groups.map((g) => g.sponsor).filter((s) => s !== "event")).size,
    deadline_keys: deadlineKeys(o.items),
    reps: repCandidates(o.messages, o.sponsors, o.role),
    dropped_by_label: c.dropped_by_label,
    added_by_label: c.added_by_label,
    priced_groups: priced,
  };
}

export function formatPreview(p: Preview, basis: string): string {
  const L: string[] = [];
  L.push(`RECEIPT PREVIEW (not the receipt) — ${basis}`);
  L.push("");
  L.push(`Found in ${p.channels} captured channels (${p.sponsors_in_capture} sponsors):`);
  L.push(`  credit offers (distinct after URL merge)   ${p.offers}`);
  L.push(`    priced per person                        ${p.priced}`);
  L.push(`    unpriced                                 ${p.unpriced}`);
  L.push(`  $ total of priced per-person offers        $${p.usd_total}${p.amount_conflicts ? ` (${p.amount_conflicts} offers state two amounts; first one used)` : ""}`);
  L.push(`  with a deadline or claim window            ${p.with_limit}  (+ ${p.limit_unresolved} with an unclear deadline, ${p.no_limit} with no stated limit)`);
  L.push(`  sponsors with at least one credit offer    ${p.sponsors_with_credit} of ${p.sponsors_in_capture}`);
  L.push(`  reps found                                 ${p.reps.candidates} candidates at ${p.reps.sponsors} sponsors (unconfirmed; day 3 confirms)`);
  L.push(`  K dated deadlines (any kind)               ${p.deadline_keys}  (classifier items; dated precision failed the gate, so likely high)`);
  L.push("");
  L.push("Priced offers:");
  for (const g of p.priced_groups) {
    const shown = g.offers.find((o) => o.usd_per_person !== undefined)!;
    L.push(`  $${g.usd_per_person}  ${g.sponsor}  "${shown.amount_text}"  ${shown.permalink}${g.offers.length > 1 ? `  (+${g.offers.length - 1} merged)` : ""}`);
  }
  L.push("");
  L.push("Basis and gaps:");
  L.push(`  - credits = classifier credit items, overlaid with the day-2 Opus label where a row has one (${p.dropped_by_label} item${p.dropped_by_label === 1 ? "" : "s"} dropped as not a credit, ${p.added_by_label} credit${p.added_by_label === 1 ? "" : "s"} the classifier missed added)`);
  L.push("  - grouping is URL merge only: no offer_key pass yet, so reminders and cross-posts without a shared link still count twice");
  L.push("  - no day-4 Opus credit pass yet: unresolved deadlines and amount conflicts are as the classifier or label left them");
  L.push("  - reps: sponsor-side posters by the A5 signals, before the day-3 confirmation");
  L.push("  - top-level posts only (thread replies not captured, D4)");
  return L.join("\n");
}
