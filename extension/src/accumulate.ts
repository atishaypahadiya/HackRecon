import type { StopReason, Ts } from "../../pipeline/schema.ts";

/** One rendered row of the message list, as read by parse.ts. DOM-free so it can be unit-tested. */
export type RawRow =
  | { kind: "message" | "system"; ts: Ts; sender: Sender | null; text: string; links: string[]; permalink: string }
  /** Day/unread dividers: Slack always renders an author header after one. */
  | { kind: "divider" }
  | { kind: "channel_start" };

export interface Sender {
  name: string;
  id?: string;
  title?: string;
  bot?: boolean;
  external?: boolean;
}

export interface Captured {
  ts: Ts;
  sender: Sender;
  text: string;
  links: string[];
  permalink: string;
}

interface Seen {
  kind: "message" | "system";
  header: Sender | null;
  text: string;
  links: string[];
  permalink: string;
}

/**
 * Accumulates rows across scroll batches, keyed by ts.
 * Grouped posts (no author header) take the author of the row rendered directly above them.
 * That predecessor link is recorded per ingest, so a grouped row first seen at the top edge of a
 * batch resolves once a later batch renders it together with the row above it.
 * System rows are tracked only as possible author headers and are never captured.
 */
export class Accumulator {
  private rows = new Map<Ts, Seen>();
  private prev = new Map<Ts, Ts>();
  sawChannelStart = false;

  get size(): number {
    let n = 0;
    for (const r of this.rows.values()) if (r.kind === "message") n++;
    return n;
  }

  ingest(batch: RawRow[]): void {
    let above: Ts | null = null;
    for (const row of batch) {
      if (row.kind === "channel_start") {
        this.sawChannelStart = true;
        above = null;
        continue;
      }
      if (row.kind === "divider") {
        above = null;
        continue;
      }
      const old = this.rows.get(row.ts);
      this.rows.set(row.ts, {
        kind: row.kind,
        header: row.sender ?? old?.header ?? null,
        // Re-renders can arrive before images/unfurls settle; keep the fullest text seen.
        text: old && old.text.length > row.text.length ? old.text : row.text,
        links: old && old.links.length > row.links.length ? old.links : row.links,
        permalink: row.permalink || old?.permalink || "",
      });
      if (above !== null && !row.sender) this.prev.set(row.ts, above);
      above = row.ts;
    }
  }

  private authorOf(ts: Ts): Sender | null {
    const visited = new Set<Ts>();
    for (let cur: Ts | undefined = ts; cur !== undefined && !visited.has(cur); cur = this.prev.get(cur)) {
      visited.add(cur);
      const header = this.rows.get(cur)?.header;
      if (header) return header;
    }
    return null;
  }

  finalize(): { messages: Captured[]; systemRowsSkipped: number; unresolvedAuthors: Ts[] } {
    const messages: Captured[] = [];
    const unresolvedAuthors: Ts[] = [];
    let systemRowsSkipped = 0;
    const keys = [...this.rows.keys()].sort();
    for (const ts of keys) {
      const r = this.rows.get(ts)!;
      if (r.kind === "system") {
        systemRowsSkipped++;
        continue;
      }
      const sender = this.authorOf(ts);
      if (!sender) unresolvedAuthors.push(ts);
      messages.push({ ts, sender: sender ?? { name: "" }, text: r.text, links: r.links, permalink: r.permalink });
    }
    return { messages, systemRowsSkipped, unresolvedAuthors };
  }
}

export const NO_NEW_KEYS_STEPS = 5;
export const STEP_WAIT_MS = 1500;

/**
 * D3: primary stop is the rendered channel-start header; fallback is
 * NO_NEW_KEYS_STEPS consecutive steps (each after a STEP_WAIT_MS wait) with no new keys.
 */
export class StopRule {
  private quiet = 0;
  private lastSize = 0;

  step(size: number, sawChannelStart: boolean): StopReason | null {
    if (sawChannelStart) return "channel_start";
    this.quiet = size > this.lastSize ? 0 : this.quiet + 1;
    this.lastSize = size;
    return this.quiet >= NO_NEW_KEYS_STEPS ? "no_new_keys" : null;
  }
}
