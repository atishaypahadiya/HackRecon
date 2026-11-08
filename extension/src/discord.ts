// Content script on discord.com/channels/* (user 2026-11-07): watches what this tab renders and hands newly rendered
// posts, and unread badges on discovered channels, to the worker. It only reads the page: it never clicks, scrolls,
// types, navigates or calls Discord (discord-dom.ts).
import { freshPosts, readChannel, readSidebar } from "./discord-dom.ts";

const DEBOUNCE_MS = 1500;
const BADGE_POLL_MS = 30_000;
const seen = new Set<string>();
let sponsorNames: string[] = [];
let lastUnread = "";
let timer: ReturnType<typeof setTimeout> | undefined;

function tick(): void {
  const view = readChannel(document, location.pathname, document.title);
  if (!view) return;
  const posts = freshPosts(view, seen);
  const unread = readSidebar(document, view.guild_id, sponsorNames).filter((c) => c.unread && c.role !== "other" && c.channel_id !== view.channel_id);
  const key = unread.map((c) => c.channel_id).join(",");
  if (!posts.length && key === lastUnread) return;
  lastUnread = key;
  void chrome.runtime.sendMessage({ type: "discord-dom", view: { ...view, posts }, unread }).catch(() => {});
}

const soon = () => {
  clearTimeout(timer);
  timer = setTimeout(tick, DEBOUNCE_MS);
};

void chrome.runtime
  .sendMessage({ type: "discord-config" })
  .then((r: { sponsors?: string[] } | undefined) => (sponsorNames = r?.sponsors ?? []))
  .catch(() => {})
  .finally(() => {
    new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label"] });
    setInterval(tick, BADGE_POLL_MS);
    soon();
  });
