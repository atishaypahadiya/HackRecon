// Reads what a Discord web-client tab renders (user 2026-11-07): the open channel's posts and the sidebar's unread
// badges. Read-only by construction: these functions only query the document they're given. No user token, no
// Discord API, no navigation, clicks, scrolling or typing (Discord bans self-bots).
// UNVERIFIED against a real event server until registration is approved: the selectors follow Discord's web client
// as of 2026-11 and are tested on a fake channel (testdata/discord-channel.html) built to that shape.
import { channelRole, crosspostSource, type ChannelRole, type DiscordPost } from "../../pipeline/discord.ts";

export const DSEL = {
  message: 'li[id^="chat-messages-"]',
  content: '[id^="message-content-"]',
  username: '[id^="message-username-"]',
  /** "APP", "BOT", or "SERVER" on a post Discord relayed from a followed announcement channel. */
  tag: '[class*="botTag"]',
  embed: 'article[class*="embed"]',
  embedTitle: '[class*="embedTitle"]',
  embedDescription: '[class*="embedDescription"]',
  channelLink: 'a[href^="/channels/"][data-list-item-id^="channels___"]',
  guildName: 'nav[aria-label] header h2',
  composer: "form",
} as const;

const NO_POST = /do not have permission to send messages/i;

export interface ChannelView {
  guild_id: string;
  channel_id: string;
  guild_name: string;
  channel_name: string;
  read_only: boolean;
  posts: DiscordPost[];
}

export interface SidebarChannel {
  channel_id: string;
  channel_name: string;
  unread: boolean;
  role: ChannelRole;
}

/** "/channels/<guild>/<channel>[/<message>]": DMs ("@me") are never read. */
export function locate(pathname: string): { guild_id: string; channel_id: string } | null {
  const m = /^\/channels\/(\d+)\/(\d+)/.exec(pathname);
  return m ? { guild_id: m[1]!, channel_id: m[2]! } : null;
}

/** The tab title is "#channel | Server" (a leading "Discord |" and unread counts like "(3)" are dropped). */
export function titleParts(title: string): { channel_name: string; guild_name: string } {
  const parts = title.split(" | ").map((p) => p.replace(/^\(\d+\)\s*/, "").trim()).filter((p) => p && p !== "Discord");
  const ch = parts.find((p) => p.startsWith("#"));
  return { channel_name: ch ? ch.slice(1) : "", guild_name: parts.find((p) => !p.startsWith("#")) ?? "" };
}

/** Text as the user sees it: links as `label <href>` (the URL alone when the label is the URL), line breaks kept. */
function serialize(root: Element, links: string[]): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) return void (out += n.textContent ?? "");
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return void (out += "\n");
    if (tag === "img") return void (out += el.getAttribute("alt") ?? "");
    if (tag === "a" && el.getAttribute("href")) {
      const href = el.getAttribute("href")!;
      const label = (el.textContent ?? "").trim();
      if (/^https?:/.test(href)) links.push(href);
      const bare = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
      return void (out += label && bare(label) !== bare(href) ? `${label} <${href}>` : href);
    }
    el.childNodes.forEach(walk);
    if (/^(div|p|li|pre|h[1-6]|blockquote)$/.test(tag)) out += "\n";
  };
  walk(root);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The open channel's rendered posts, oldest first. A follow-up post shows no name: it takes the author above it. */
export function readChannel(doc: Document, pathname: string, title: string): ChannelView | null {
  const at = locate(pathname);
  if (!at) return null;
  const names = titleParts(title);
  const guild_name = names.guild_name || (doc.querySelector(DSEL.guildName)?.textContent ?? "").trim();
  // The composer only: a form holding no message list. A post quoting the phrase never counts.
  const read_only = [...doc.querySelectorAll(DSEL.composer)].some((f) => !f.querySelector(DSEL.message) && !f.closest(DSEL.message) && NO_POST.test(f.textContent ?? ""));
  const posts: DiscordPost[] = [];
  let author = "";
  let tag = "";
  for (const li of doc.querySelectorAll(DSEL.message)) {
    const m = /^chat-messages-(\d+)-(\d+)$/.exec(li.id);
    if (!m || m[1] !== at.channel_id) continue;
    const name = li.querySelector(DSEL.username)?.textContent?.trim();
    if (name) {
      author = name;
      tag = (li.querySelector(DSEL.tag)?.textContent ?? "").trim().toUpperCase();
    }
    const links: string[] = [];
    const content = li.querySelector(DSEL.content);
    const lines = content ? [serialize(content, links)] : [];
    for (const e of li.querySelectorAll(DSEL.embed))
      for (const part of [e.querySelector(DSEL.embedTitle), e.querySelector(DSEL.embedDescription)]) if (part) lines.push(serialize(part, links));
    const text = lines.filter(Boolean).join("\n");
    if (!text || !author) continue;
    const src = tag === "SERVER" ? crosspostSource(author) : null;
    posts.push({
      via: "dom",
      guild_id: at.guild_id,
      guild_name,
      channel_id: at.channel_id,
      channel_name: names.channel_name,
      message_id: m[2]!,
      author_name: author,
      author_kind: tag ? "bot" : "user",
      ...(src ? { crosspost: src } : {}),
      ...(read_only ? { read_only_channel: true } : {}),
      text,
      links: [...new Set(links)],
    });
  }
  return { guild_id: at.guild_id, channel_id: at.channel_id, guild_name, channel_name: names.channel_name, read_only, posts };
}

/** The sidebar's text channels for this server. Its aria-label reads like "unread, announcements (announcement
 *  channel)" or "2 mentions, sponsor-modal (text channel)": either prefix means an unread badge. */
export function readSidebar(doc: Document, guildId: string, sponsorNames: string[] = []): SidebarChannel[] {
  const out = new Map<string, SidebarChannel>();
  for (const a of doc.querySelectorAll(DSEL.channelLink)) {
    const m = new RegExp(`^/channels/${guildId}/(\\d+)$`).exec(a.getAttribute("href") ?? "");
    if (!m) continue;
    const label = a.getAttribute("aria-label") ?? "";
    const unread = /^(unread|\d+ mentions?),/i.test(label);
    const name = label.replace(/^(?:(?:unread|\d+ mentions?),\s*)+/i, "").replace(/\s*\([^)]*channel\)$/i, "").trim() || (a.textContent ?? "").trim();
    out.set(m[1]!, { channel_id: m[1]!, channel_name: name, unread, role: channelRole(name, sponsorNames) });
  }
  return [...out.values()];
}

/** Posts not handed over yet. `seen` lives as long as the tab's page. */
export function freshPosts(view: ChannelView, seen: Set<string>): DiscordPost[] {
  const fresh = view.posts.filter((p) => !seen.has(p.message_id));
  for (const p of fresh) seen.add(p.message_id);
  return fresh;
}

/** A message from this extension's own content script in a Discord channel tab. */
export function fromDiscordTab(sender: { id?: string; tab?: { url?: string } }, extensionId: string): boolean {
  return sender.id === extensionId && /^https:\/\/discord\.com\/channels\//.test(sender.tab?.url ?? "");
}
