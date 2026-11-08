// The fake Discord event's replay (discord-replay.json): snowflake ids from each post's time, and each post as the
// web client renders it, so the DOM reader and the pipeline are tested on the same posts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISCORD_EPOCH_MS } from "../discord.ts";

export interface ReplayPost {
  via: "dom" | "bot";
  channel: { id: string; name: string };
  read_only: boolean;
  at: string;
  author: string | null;
  tag: string;
  html: string;
  source_message?: string;
  source_channel?: string;
}
export interface Replay {
  guild: { id: string; name: string };
  own_server: { id: string; name: string; feed_channel: { id: string; name: string } };
  plan: { input: { idea: string; stack: { name: string; used_for: string | null }[] }; tracks: { track_id: string; name: string; sponsor: string; fit: "likely" | "possible"; product_names: string[] }[] };
  posts: ReplayPost[];
}

export const replay = JSON.parse(readFileSync(join(import.meta.dir, "discord-replay.json"), "utf8")) as Replay;
export const CHANNEL_PAGE = readFileSync(join(import.meta.dir, "../../extension/testdata/discord-channel.html"), "utf8");

/** A snowflake for a time; `n` keeps posts in one millisecond apart. */
export const snowflake = (iso: string, n = 0) => String(((BigInt(Date.parse(iso)) - DISCORD_EPOCH_MS) << 22n) + BigInt(n));
export const idOf = (p: ReplayPost) => snowflake(p.at, replay.posts.indexOf(p));

/** One post as Discord's list renders it; a follow-up (author null) has no header. */
export function renderLi(p: ReplayPost): string {
  const id = idOf(p);
  const header = p.author
    ? `<h3><span id="message-username-${id}"><span class="username_a1">${p.author}</span></span>${p.tag ? `<span class="botTag_b2"><span>${p.tag}</span></span>` : ""}<time datetime="${new Date(p.at).toISOString()}">${p.at}</time></h3>`
    : "";
  return `<li id="chat-messages-${p.channel.id}-${id}" class="messageListItem_c3"><div class="message_d4">${header}<div id="message-content-${id}" class="markup_e5">${p.html}</div></div></li>`;
}

/** The fake channel page set to one channel: its title, its composer (read-only or not), its posts rendered. */
export function channelPage(channel: { id: string; name: string }, readOnly: boolean, posts: ReplayPost[], guildName = replay.guild.name): string {
  return CHANNEL_PAGE.replace("<title>#announcements | Example Hacks</title>", `<title>#${channel.name} | ${guildName}</title>`)
    .replace("You do not have permission to send messages in this channel.", readOnly ? "You do not have permission to send messages in this channel." : `<textarea placeholder="Message #${channel.name}"></textarea>`)
    .replace('<ol data-list-id="chat-messages"></ol>', `<ol data-list-id="chat-messages">${posts.map(renderLi).join("")}</ol>`);
}
