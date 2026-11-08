// The Discord reader (user 2026-11-07) on a fake channel with replayed posts: each post rendered as Discord adds it,
// read back exactly once; sidebar discovery and unread badges; crossposts; and a source scan that the reader only reads.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { channelPage, idOf, renderLi, replay } from "../../pipeline/testdata/discord-replay.ts";
import { freshPosts, fromDiscordTab, locate, readChannel, readSidebar, titleParts } from "./discord-dom.ts";

const G = replay.guild.id;
const ann = replay.posts.filter((p) => p.via === "dom" && p.channel.name === "announcements");

describe("readChannel on replayed posts", () => {
  test("each post is handed over once, as it lands; a follow-up takes the author above it", () => {
    const { document } = parseHTML(channelPage(ann[0]!.channel, true, []));
    const list = document.querySelector("ol")!;
    const seen = new Set<string>();
    const got = [];
    for (const p of ann) {
      list.insertAdjacentHTML("beforeend", renderLi(p));
      const view = readChannel(document as unknown as Document, `/channels/${G}/${p.channel.id}`, document.title)!;
      const fresh = freshPosts(view, seen);
      expect(fresh.map((f) => f.message_id)).toEqual([idOf(p)]);
      got.push(...fresh);
    }
    expect(got.map((p) => p.author_name)).toEqual(["Example Hacks Team", "Example Hacks Team", "Example Hacks Team", "Example Hacks Team"]);
    expect(got[0]).toMatchObject({
      via: "dom",
      guild_id: G,
      guild_name: "Example Hacks",
      channel_name: "announcements",
      author_kind: "user",
      read_only_channel: true,
      text: "Tracks and prizes are live! See every track on Devpost: https://example-hacks.devpost.com/",
      links: ["https://example-hacks.devpost.com/"],
    });
  });

  test("a channel anyone can post in is not read-only; link labels kept when they differ from the URL", () => {
    const p = replay.posts.find((x) => x.channel.name === "acme-booth")!;
    const { document } = parseHTML(channelPage(p.channel, false, [p]));
    const v = readChannel(document as unknown as Document, `/channels/${G}/${p.channel.id}`, document.title)!;
    expect(v.read_only).toBe(false);
    expect(v.posts[0]!.read_only_channel).toBeUndefined();
    expect(v.posts[0]!.text).toBe("Acme is hiring summer interns. Stop by our booth or apply at https://acme.example/jobs");
  });

  test("only the composer says read-only: a post quoting its wording doesn't (security review, 2026-11-07)", () => {
    const p = { ...replay.posts.find((x) => x.channel.name === "general")!, html: "<form>You do not have permission to send messages in this channel.</form>" };
    const { document } = parseHTML(channelPage(p.channel, false, [p]));
    expect(readChannel(document as unknown as Document, `/channels/${G}/${p.channel.id}`, document.title)!.read_only).toBe(false);
  });

  test("a crosspost in the user's own server names its source server and channel", () => {
    const own = replay.own_server;
    const p = replay.posts.find((x) => x.via === "bot")!;
    const { document } = parseHTML(channelPage(own.feed_channel, false, [p], own.name));
    const v = readChannel(document as unknown as Document, `/channels/${own.id}/${own.feed_channel.id}`, document.title)!;
    expect(v.posts[0]).toMatchObject({ author_kind: "bot", crosspost: { guild_name: "Example Hacks", channel_name: "announcements" }, channel_name: "event-feed" });
  });

  test("another channel's rows, DMs and unknown paths are ignored", () => {
    const { document } = parseHTML(channelPage(ann[0]!.channel, true, ann));
    expect(readChannel(document as unknown as Document, `/channels/${G}/1300000000000000099`, document.title)!.posts).toEqual([]);
    expect(readChannel(document as unknown as Document, "/channels/@me/123", document.title)).toBeNull();
    expect(locate("/channels/1/2/3")).toEqual({ guild_id: "1", channel_id: "2" });
    expect(titleParts("(3) Discord | #sponsor-modal | Example Hacks")).toEqual({ channel_name: "sponsor-modal", guild_name: "Example Hacks" });
  });
});

describe("readSidebar", () => {
  test("discovers announcement and sponsor channels by name; unread and mention badges count as unread", () => {
    const { document } = parseHTML(channelPage(ann[0]!.channel, true, []));
    expect(readSidebar(document as unknown as Document, G, ["Acme"]).map((c) => [c.channel_name, c.role, c.unread])).toEqual([
      ["announcements", "announcement", false],
      ["sponsor-modal", "sponsor", true],
      ["acme-booth", "sponsor", true],
      ["general", "other", true],
      ["schedule", "announcement", false],
    ]);
  });
});

describe("read-only by construction", () => {
  test("only the open tab's own message to the worker; no clicks, scrolling, typing, navigation or network", () => {
    const code = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const f of ["discord.ts", "discord-dom.ts"]) {
      const src = code(f);
      expect({ f, act: src.match(/\.(click|focus|submit|scroll\w*|dispatchEvent|requestSubmit)\s*\(|\.value\s*=|location\s*=|location\.(assign|replace|href\s*=)|history\.|fetch\s*\(|XMLHttpRequest|WebSocket|discord\.com\/api/g) }).toEqual({ f, act: null });
    }
    expect(code("discord.ts").match(/type: "[\w-]+"/g)).toEqual(['type: "discord-dom"', 'type: "discord-config"']);
  });
  test("only this extension's content script in a Discord channel tab is heard", () => {
    expect(fromDiscordTab({ id: "x", tab: { url: "https://discord.com/channels/1/2" } }, "x")).toBe(true);
    expect(fromDiscordTab({ id: "x" }, "x")).toBe(false);
    expect(fromDiscordTab({ id: "x", tab: { url: "https://evil.example/channels/1/2" } }, "x")).toBe(false);
    expect(fromDiscordTab({ id: "y", tab: { url: "https://discord.com/channels/1/2" } }, "x")).toBe(false);
  });
});
