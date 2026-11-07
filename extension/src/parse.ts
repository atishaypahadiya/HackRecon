import type { RawRow, Sender } from "./accumulate.ts";
import { broadcastParent, LIST_TOP_TS, nonPostReason } from "../../pipeline/rows.ts";
import { tsFromAttr, tsFromPermalink } from "./permalink.ts";
import { BOT_SENDER_IDS, SEL, TEXT } from "./selectors.ts";

const BLOCK = new Set(["DIV", "P", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "SECTION"]);

/** Rendered rows under `root`, in DOM (top-to-bottom) order. Rows that can't be read are dropped. */
export function parseRows(root: ParentNode, base?: string): RawRow[] {
  const out: RawRow[] = [];
  for (const el of root.querySelectorAll(SEL.row)) {
    const row = parseRow(el, base);
    if (row) out.push(row);
  }
  return out;
}

export function parseRow(el: Element, base?: string): RawRow | null {
  const whole = squash(el.textContent ?? "");
  if (el.matches(SEL.channelStart) || el.querySelector(SEL.channelStart) || TEXT.channelStart.test(whole)) {
    return { kind: "channel_start" };
  }
  const stamp = el.querySelector(SEL.timestamp);
  if (!stamp && (el.matches(SEL.divider) || el.querySelector(SEL.divider))) return { kind: "divider" };

  const href = stamp?.getAttribute("href") ?? "";
  const permalink = href ? absolute(href, base) : "";
  const ts =
    tsFromPermalink(permalink) ??
    tsFromAttr(stamp?.getAttribute("data-ts")) ??
    tsFromAttr(el.getAttribute("data-item-key")) ??
    tsFromAttr(el.id.replace(/^message-list_/, ""));
  if (!ts) return null;
  // Empty list-top slot (seen in 0-announcements): not a post, and nothing above it to group with.
  if (ts === LIST_TOP_TS) return { kind: "divider" };

  const sender = parseSender(el);
  const bodyEl = el.querySelector(SEL.body);
  const { text, links, mentions } = bodyEl ? serializeBody(bodyEl, base) : { text: "", links: [] };
  const nonPost = nonPostReason({ ts, permalink, text, hasBody: !!bodyEl });
  const replies = parseReplyBar(el);
  if (nonPost) return replies ? { kind: "system", ts, sender, text, links, permalink, nonPost, replies } : { kind: "system", ts, sender, text, links, permalink, nonPost };
  const kind = isSystem(el, sender, !!bodyEl) ? "system" : "message";
  const threadTs = broadcastParent(permalink, ts);
  const row: RawRow = threadTs ? { kind, ts, sender, text, links, permalink, threadTs } : { kind, ts, sender, text, links, permalink };
  if (replies) row.replies = replies;
  if (mentions?.length) row.mentions = mentions;
  return row;
}

/** The reply bar under a parent post: the "N replies" count and the newest reply's ts. data-qa first, then text. */
export function parseReplyBar(row: Element): { count: number; last?: string } | null {
  const button = replyButton(row);
  const count = Number(TEXT.replyCount.exec(squash(button?.textContent ?? ""))?.[1] ?? NaN);
  if (!button || !Number.isInteger(count) || count < 1) return null;
  const last = tsFromAttr(row.querySelector(SEL.lastReply)?.getAttribute("data-ts"));
  return last ? { count, last } : { count };
}

/** The element to click to open the thread: data-qa first, then any button or link reading "N replies". */
export function replyButton(row: Element): Element | null {
  const byQa = row.querySelector(SEL.replyCount);
  if (byQa) return byQa;
  for (const el of row.querySelectorAll("button, a, [role=button]")) if (TEXT.replyCount.test(squash(el.textContent ?? ""))) return el;
  return null;
}

function parseSender(row: Element): Sender | null {
  const el = row.querySelector(SEL.sender);
  const name = squash(el?.textContent ?? "");
  // A header with its name not loaded yet: an author we can't name, never the one above (that's for grouped posts).
  if ((!el || !name) && row.querySelector(SEL.unknownSender)) return { name: "" };
  if (!el || !name) return null;
  const s: Sender = { name };
  const id = el.getAttribute(SEL.senderIdAttr) ?? el.closest(`[${SEL.senderIdAttr}]`)?.getAttribute(SEL.senderIdAttr);
  if (id) s.id = id;
  const title = squash(row.querySelector(SEL.senderTitle)?.textContent ?? "");
  if (title) s.title = title;
  if (row.querySelector(SEL.botBadge) || (id && BOT_SENDER_IDS.has(id))) s.bot = true;
  if (row.querySelector(SEL.externalBadge)) s.external = true;
  return s;
}

function isSystem(row: Element, sender: Sender | null, hasBody: boolean): boolean {
  if (row.querySelector(SEL.systemMessage)) return true;
  if (hasBody) return false;
  // No message body and no system class: fall back to the row's text, minus author and time.
  let rest = squash(row.textContent ?? "");
  if (sender) rest = rest.replace(sender.name, "");
  const stamp = squash(row.querySelector(SEL.timestamp)?.textContent ?? "");
  if (stamp) rest = rest.replace(stamp, "");
  return TEXT.system.test(rest.trim());
}

/** Body text with anchors as `label <href>` (OV7); returns every external href in order, and each @-mention's
 *  Slack user ID with its rendered label (the mention stays plain text: reps.ts reads the ID, never the label). */
export function serializeBody(body: Element, base?: string): { text: string; links: string[]; mentions?: { id: string; label: string }[] } {
  const links: string[] = [];
  const mentions: { id: string; label: string }[] = [];
  let out = "";
  const walk = (n: Node): void => {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? "";
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.matches(SEL.bodyNoise)) return;
    if (el.matches(SEL.paragraphBreak)) {
      out += "\n\n";
      return;
    }
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") {
      out += "\n";
      return;
    }
    if (tag === "IMG") {
      out += el.getAttribute("alt") ?? "";
      return;
    }
    if (tag === "A") {
      const href = externalHref(el.getAttribute("href"), base);
      const label = squash(el.textContent ?? "");
      const member = el.getAttribute(SEL.mentionIdAttr);
      if (member && /^[UW][A-Z0-9]{6,}$/.test(member)) mentions.push({ id: member, label });
      if (!href) {
        out += label;
        return;
      }
      links.push(href);
      out += !label || label === href || `https://${label}` === href || `http://${label}` === href ? href : `${label} <${href}>`;
      return;
    }
    const block = BLOCK.has(tag);
    if (block && out && !out.endsWith("\n")) out += "\n";
    for (const c of el.childNodes) walk(c);
    if (block && out && !out.endsWith("\n")) out += "\n";
  };
  for (const c of body.childNodes) walk(c);
  const text = out
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return mentions.length ? { text, links, mentions } : { text, links };
}

/** Null for mentions, channel links and other in-app anchors; unwraps Slack's redirect. */
function externalHref(raw: string | null, base?: string): string | null {
  if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return null;
  let href = absolute(raw, base);
  if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return null;
  try {
    const u = new URL(href);
    if (u.hostname === "slack-redir.net") href = u.searchParams.get("url") ?? href;
    else if (/(^|\.)slack\.com$/.test(u.hostname) && !u.pathname.startsWith("/archives/")) return null;
  } catch {
    return null;
  }
  return href;
}

function absolute(href: string, base?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || !base) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
