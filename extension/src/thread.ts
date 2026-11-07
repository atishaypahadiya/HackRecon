// Thread pane reading for "Sync this event" (user 2026-11-06). The pane's markup had no DOM sample when this was
// written, so the pane is found two ways: SEL.threadPane's guesses, then without them, as the subtree outside the
// message pane that renders the parent's message container (data-msg-ts, verified in the channel samples).
// Rows are kept as scrubbed HTML in scroll-step batches (ThreadRaw), and the ThreadRun is built from those batches,
// so the same code runs in the browser and offline (`hr rebuild-threads`) once the selectors are corrected.
import { messageId, type Message, type ThreadRun, type ThreadStopReason, type Ts } from "../../pipeline/schema.ts";
import { scrubTokens } from "../../pipeline/domscrub.ts";
import { Accumulator, type RawRow } from "./accumulate.ts";
import { parseRow } from "./parse.ts";
import { tsFromAttr } from "./permalink.ts";
import { SEL, TEXT } from "./selectors.ts";

export interface PaneFound {
  root: Element;
  /** Which rule found it, recorded in the sync log so the selectors can be corrected from real runs. */
  how: "selector" | "outside_message_pane" | "reply_links";
}

/** The open thread pane for `parent`, or null while it isn't rendered. A long thread's pane can open at its end,
 *  with the parent unrendered by the virtual list, so reply permalinks (`?thread_ts=<parent>`) count too. */
export function findThreadPane(doc: ParentNode, parent: Ts): PaneFound | null {
  const parentSel = `${SEL.messageContainer}[${SEL.messageTsAttr}="${parent}"]`;
  const replySel = `a[href*="thread_ts=${parent}"]`;
  const holds = (el: Element) => !!el.querySelector(parentSel) || !!el.querySelector(replySel);
  for (const el of doc.querySelectorAll(SEL.threadPane)) if (holds(el) && !el.querySelector(SEL.messagePane)) return { root: el, how: "selector" };
  for (const [sel, how] of [[parentSel, "outside_message_pane"], [replySel, "reply_links"]] as const) {
    for (const c of doc.querySelectorAll(sel)) {
      if (c.closest(SEL.messagePane) || c.closest(SEL.sidebar)) continue;
      // Climb to the widest ancestor that still leaves the message pane out: the secondary view.
      let root: Element = c;
      while (root.parentElement && root.parentElement.tagName !== "BODY" && !root.parentElement.querySelector(SEL.messagePane)) root = root.parentElement;
      return { root, how };
    }
  }
  return null;
}

/** Message rows in the pane, top to bottom: the virtual-list item around each message container. */
export function paneRows(root: Element): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const c of root.querySelectorAll(SEL.messageContainer)) {
    const row = c.closest(".c-virtual_list__item") ?? c;
    if (root.contains(row) && !seen.has(row)) {
      seen.add(row);
      out.push(row);
    }
  }
  return out;
}

export function rowKey(row: Element): string {
  return row.getAttribute("data-item-key") || row.querySelector(SEL.messageContainer)?.getAttribute(SEL.messageTsAttr) || row.getAttribute(SEL.messageTsAttr) || row.id;
}

/** Controls that load replies the pane isn't showing (UNVERIFIED wording, TEXT.moreReplies). */
export function moreRepliesControls(root: Element): Element[] {
  return [...root.querySelectorAll("button, a, [role=button]")].filter((el) => TEXT.moreReplies.test(squash(el.textContent ?? "")));
}

/** Sample and row HTML is scrubbed of session tokens before it leaves the page (same rules as hr scrub-dom). */
export function cleanHtml(html: string, opts: { dropSvg?: boolean } = {}): string {
  const out = scrubTokens(html).html;
  // Icons are inline SVG paths: bulky and never read by the parser.
  return opts.dropSvg ? out.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, "<svg></svg>") : out;
}

/** One thread as read from the pane: every row's HTML once, and the order rows were rendered in at each step. */
export interface ThreadRaw {
  thread_ts: Ts;
  reply_count_shown: number | null;
  latest_reply_shown?: Ts;
  stop_reason: ThreadStopReason;
  note?: string;
  pane_how?: PaneFound["how"];
  /** Keys in DOM order, one list per scroll step. */
  batches: string[][];
  /** Scrubbed outerHTML per key (the fullest rendering seen). */
  rows: Record<string, string>;
}

export class ThreadRecorder {
  readonly batches: string[][] = [];
  readonly rows: Record<string, string> = {};

  /** Records the rendered rows; returns how many keys were new. */
  record(rows: Element[]): number {
    const keys: string[] = [];
    let fresh = 0;
    for (const r of rows) {
      const k = rowKey(r);
      if (!k) continue;
      const html = cleanHtml(r.outerHTML, { dropSvg: true });
      if (!(k in this.rows)) fresh++;
      if (!(k in this.rows) || html.length > this.rows[k]!.length) this.rows[k] = html;
      keys.push(k);
    }
    if (keys.length) this.batches.push(keys);
    return fresh;
  }

  get size(): number {
    return Object.keys(this.rows).length;
  }
}

/** Builds rows from HTML strings. Browser: DOMParser. Bun: linkedom. */
export type HtmlToRows = (html: string) => Element[];

export const browserRows: HtmlToRows = (html) => [...new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html").getElementById("r")!.children];

/** The ThreadRun for one raw thread: replies under the parent, authors resolved across batches like a channel. */
export function threadRunFromRaw(raw: ThreadRaw, ctx: { channelId: string; channelName: string; runId: string; capturedAt: string; base: string }, toRows: HtmlToRows): ThreadRun {
  const acc = new Accumulator();
  const broadcast = new Set<Ts>();
  for (const keys of raw.batches) {
    const rows: RawRow[] = [];
    for (const el of toRows(keys.map((k) => raw.rows[k] ?? "").join(""))) {
      const r = parseRow(el, ctx.base);
      if (!r) continue;
      rows.push(r);
      if ("ts" in r && TEXT.alsoSent.test(squash(el.textContent ?? ""))) broadcast.add(r.ts);
    }
    acc.ingest(rows);
  }
  const replies: Message[] = acc
    .finalize()
    .messages.filter((m) => m.ts !== raw.thread_ts && Number(m.ts) > Number(raw.thread_ts))
    .map((m) => {
      const out: Message = {
        id: messageId(ctx.channelId, m.ts),
        channel_id: ctx.channelId,
        channel_name: ctx.channelName,
        ts: m.ts,
        thread_ts: raw.thread_ts,
        author_name: m.sender.name,
        text: m.text,
        links: m.links,
        permalink: m.permalink,
        captured_at: ctx.capturedAt,
        run_id: ctx.runId,
      };
      if (broadcast.has(m.ts)) out.subtype = "thread_broadcast";
      if (m.sender.title) out.author_title = m.sender.title;
      if (m.sender.id) out.author_id = m.sender.id;
      out.author_kind = m.sender.bot ? "bot" : "user";
      if (m.sender.external) out.author_external = true;
      if (m.mentions?.length) out.mentions = m.mentions;
      return out;
    });
  const run: ThreadRun = { thread_ts: raw.thread_ts, reply_count_shown: raw.reply_count_shown, stop_reason: raw.stop_reason, replies };
  if (raw.note) run.note = raw.note;
  return run;
}

/** True once the pane renders the parent post (the top of the thread). */
export function parentRendered(root: Element, parent: Ts): boolean {
  return paneRows(root).some((r) => tsFromAttr(rowKey(r)) === parent);
}

export interface SidebarChannel {
  id: string;
  name: string;
}

/** Channels the sidebar renders right now, in sidebar order. */
export function sidebarChannels(doc: ParentNode): SidebarChannel[] {
  const out: SidebarChannel[] = [];
  for (const el of doc.querySelectorAll(SEL.sidebarChannel)) {
    const id = el.getAttribute(SEL.sidebarChannelIdAttr) ?? "";
    const qa = el.querySelector(SEL.sidebarChannelName)?.getAttribute("data-qa") ?? "";
    const name = qa.replace(/^channel_sidebar_name_/, "") || squash(el.textContent ?? "");
    if (/^[CG][A-Z0-9]+$/.test(id) && name) out.push({ id, name });
  }
  return out;
}

/** Channels a sync discovers by name when the config doesn't list them yet: sponsor prefixes (user 2026-11-06)
 *  and announcement channels (design doc §Sync). */
export const SYNC_CHANNEL = /^(?:spons|partner|cohost)-|announce/i;

/** What the build hands the sync (extension/build-config.ts): the event's configured channels, in config order. */
export interface SyncConfig {
  event: string;
  channels: string[];
}

export function syncConfigFrom(sponsors: Record<string, unknown>, event: { event?: string; authority_channels?: string[] }): SyncConfig {
  return { event: event.event ?? "", channels: [...new Set([...Object.keys(sponsors), ...(event.authority_channels ?? [])])] };
}

export interface SyncSelection {
  targets: SidebarChannel[];
  /** In the config but not in the sidebar (not joined, or a renamed channel). */
  missing: string[];
  /** Not in the config; picked by SYNC_CHANNEL. Add them to sponsors.json if they belong to the event. */
  discovered: string[];
}

/** Config channels first, in config order (user 2026-11-06: selection comes from the event config); then
 *  channels the prefixes find that the config doesn't list yet, in sidebar order. */
export function syncTargets(found: SidebarChannel[], config: string[] = []): SyncSelection {
  const byName = new Map(found.map((c) => [c.name, c]));
  const targets = config.map((n) => byName.get(n)).filter((c): c is SidebarChannel => !!c);
  const inConfig = new Set(config);
  const extra = found.filter((c) => !inConfig.has(c.name) && SYNC_CHANNEL.test(c.name));
  const seen = new Set<string>();
  return {
    targets: [...targets, ...extra].filter((c) => !seen.has(c.id) && seen.add(c.id)),
    missing: config.filter((n) => !byName.has(n)),
    discovered: extra.map((c) => c.name),
  };
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
