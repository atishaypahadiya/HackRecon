// End to end on the fake Discord event (user 2026-11-07): replayed posts land in a fake channel page one at a time and
// in the bot's fake API, and each tick runs ingest → items → alerts → texts with the clock at that post's time.
// Classify is stood in for by the items it would return (the live replay runs the real one, under the cost guard).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { freshPosts, readChannel, readSidebar } from "../extension/src/discord-dom.ts";
import { writeJsonFile } from "./classify.ts";
import type { DiscordDomFile } from "./discord.ts";
import { DiscordBot, type BotDeps } from "./discordbot.ts";
import { ITEMS_PATH, PLAN_PATH } from "./event.ts";
import { readMessages } from "./runs.ts";
import type { Item } from "./schema.ts";
import { channelPage, idOf, replay, type ReplayPost } from "./testdata/discord-replay.ts";
import { snowflakeMs } from "./discord.ts";
import { ingestDiscord, runAlerts } from "./watch.ts";

const TOKEN = "MTQwMDAwMDAwMDAwMDAwMDAwMQ.Gx1y2z.abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const G = replay.guild.id;
let home = "";
let downloads = "";
const was = process.cwd();

/** What classify would return for each replayed post (by its text), as items. */
const CLASSIFIED: Record<string, Partial<Item>[]> = {
  "Workshop: Build and deploy agents on Modal": [{ kind: "workshop", sponsor: "Modal", event_start_iso: "2026-11-14T15:00:00-08:00" }],
  "Every hacker gets $50 in Modal credits": [{ kind: "credit", sponsor: "Modal", amount_text: "$50", amount_unit: "USD", amount_basis: "per_person" }],
  "Acme is hiring summer interns": [{ kind: "job", sponsor: "Acme" }],
  "Reminder: project submissions are due": [{ kind: "deadline", sponsor: "event", deadline_iso: "2026-11-15T09:00:00-08:00", deadline_status: "resolved_relative" }],
};

/** The bot's view of the user's own server at a moment: crossposts already published by then. */
function fakeOwnServer(now: () => number): BotDeps {
  const own = replay.own_server;
  return {
    now,
    sleep: async () => {},
    fetch: async (url) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/api\/v10/, "");
      const body =
        path === "/users/@me/guilds"
          ? [{ id: own.id, name: own.name }]
          : path === `/guilds/${own.id}/channels`
            ? [{ id: own.feed_channel.id, name: own.feed_channel.name, type: 0 }]
            : replay.posts
                .filter((p) => p.via === "bot" && Date.parse(p.at) <= now())
                .map((p) => ({ id: idOf(p), content: p.html, flags: 2, webhook_id: "9", author: { username: p.author }, message_reference: { guild_id: G, channel_id: p.source_channel, message_id: p.source_message } }))
                .filter((m) => !u.searchParams.get("after") || BigInt(m.id) > BigInt(u.searchParams.get("after")!))
                .reverse();
      return { status: 200, headers: { get: () => null }, json: async () => body };
    },
  };
}

const sent: { at: string; body: string }[] = [];
const ticks: string[][] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "hr-discord-"));
  downloads = join(home, "downloads");
  mkdirSync(downloads);
  mkdirSync(join(home, "event", "data"), { recursive: true });
  process.chdir(join(home, "event"));
  writeJsonFile(PLAN_PATH, replay.plan);
  const seen = new Map<string, Set<string>>();
  const rendered = new Map<string, ReplayPost[]>();
  let first = true;
  for (const p of replay.posts) {
    const tick = Date.parse(p.at) + 60_000;
    if (p.via === "dom") {
      // The user's tab on that channel: Discord renders the new post below the ones already shown.
      const shown = [...(rendered.get(p.channel.id) ?? []), p];
      rendered.set(p.channel.id, shown);
      const { document } = parseHTML(channelPage(p.channel, p.read_only, shown));
      const doc = document as unknown as Document;
      const view = readChannel(doc, `/channels/${G}/${p.channel.id}`, document.title)!;
      const posts = freshPosts(view, seen.get(p.channel.id) ?? seen.set(p.channel.id, new Set()).get(p.channel.id)!);
      const unread = first ? readSidebar(doc, G).filter((c) => c.unread && c.role !== "other" && c.channel_id !== p.channel.id) : [];
      first = false;
      const file: DiscordDomFile = { kind: "discord-dom", captured_at: new Date(tick).toISOString(), guild_id: G, guild_name: view.guild_name, posts, unread: unread.map((c) => ({ channel_id: c.channel_id, channel_name: c.channel_name, role: c.role, since: p.at })) };
      writeFileSync(join(downloads, `${new Date(tick).toISOString().replace(/[:.]/g, "-")}-${p.channel.id}.json`), JSON.stringify(file));
    }
    const bot = new DiscordBot(TOKEN, fakeOwnServer(() => tick));
    await ingestDiscord({ dir: downloads, bot, now: new Date(tick) });
    // classify --new, stood in for: items for every captured post it would find something in.
    writeJsonFile(ITEMS_PATH, readMessages().flatMap((m) => (Object.entries(CLASSIFIED).find(([k]) => m.text.startsWith(k))?.[1] ?? []).map((it, i) => ({ message_id: m.id, item_index: i, offer_key: "", amount_text: "", amount_unit: "other", amount_basis: "unknown", deadline_status: "none", urls: [], model: "fake", classified_at: "", ...it }))));
    const r = await runAlerts({ nowMs: tick, tz: "America/Los_Angeles", organizerIds: new Set(), send: async (body) => (sent.push({ at: p.at, body }), { sid: `SM${sent.length}` }) });
    ticks.push(r.fresh.map((a) => `${a.level} ${a.kind}`));
  }
});
afterAll(() => {
  process.chdir(was);
  rmSync(home, { recursive: true, force: true });
});

describe("replayed Discord event → texts", () => {
  test("every post is read once; organizer authority only from the read-only channel and the followed crossposts", () => {
    const ms = readMessages();
    expect(ms).toHaveLength(replay.posts.length);
    expect(ms.filter((m) => m.authority).map((m) => m.channel_name).sort()).toEqual(["announcements", "announcements", "announcements", "announcements", "announcements", "announcements"]);
    const bot = ms.find((m) => m.text.startsWith("Reminder"))!;
    expect(bot).toMatchObject({ channel_name: "announcements", author_name: "Example Hacks #announcements", permalink: `https://discord.com/channels/${G}/1300000000000000010/1300000000000009001` });
    expect(snowflakeMs(idOf(replay.posts[0]!))).toBe(Date.parse(replay.posts[0]!.at));
    expect(readdirSync("captures/discord")).toHaveLength(replay.posts.filter((p) => p.via === "dom").length);
  });

  test("what each post set off, tick by tick", () => {
    expect(ticks).toEqual([
      ["now tracks", "digest unread", "digest unread"],
      ["now judging"],
      ["now workshop"],
      ["now offer"],
      [],
      ["digest offer"],
      ["now change"],
      ["now deadline"],
      [],
    ]);
  });

  test("the texts: important ones rate-limited, the rest in one digest, each with what, why and where", () => {
    expect(sent.map((s) => s.at)).toEqual(["2026-11-14T09:00:00-08:00", "2026-11-14T10:15:00-08:00", "2026-11-14T10:40:00-08:00", "2026-11-14T11:00:00-08:00", "2026-11-14T13:30:00-08:00", "2026-11-14T16:00:00-08:00"]);
    // 09:01 tracks went out; judging at 09:01:40 waited for the 10-minute gap and rode with the 10:16 workshop.
    expect(sent[0]!.body).toBe(
      "HackRecon: Tracks posted\nTracks and prizes are live! See every track on Devpost: https://example-hacks.devpost.com/\nWhy: Check your Plan's likely tracks are there as you expect: Best Use of Modal\n#announcements, Example Hacks\nhttps://discord.com/channels/1300000000000000001/1300000000000000010/" +
        idOf(replay.posts[0]!),
    );
    expect(sent[1]!.body).toStartWith("HackRecon, 2 updates:\n\n1. Judging\n");
    expect(sent[1]!.body).toContain("2. Workshop\nWorkshop: Build and deploy agents on Modal, today at 3:00 PM in Room 105.\nWhy: It's about Modal, in your stack (GPU inference for the planner); Your Plan's likely track: Best Use of Modal; Starts Sat 3:00 PM (in 5 h)");
    expect(sent[2]!.body).toContain("Sponsor offer\nModal: $50 in credits\nWhy: It's about Modal, in your stack");
    expect(sent[3]!.body).toBe("HackRecon digest, 3 items:\n1. New post: New post in #sponsor-modal (#sponsor-modal, Example Hacks)\n2. New post: New post in #acme-booth (#acme-booth, Example Hacks)\n3. Sponsor offer: Acme is hiring summer interns. Stop by our booth or apply at https://acme.example/jobs (#acme-booth, Example Hacks)");
    expect(sent[4]!.body).toContain("Room or time change\nRoom change: the Modal workshop has moved to Room 210, same time.\nWhy: It's about Modal, in your stack");
    expect(sent[5]!.body).toContain("Deadline\nReminder: project submissions are due Sunday at 9:00 AM on Devpost. Late submissions won't be judged.\nWhy: Due Sun 9:00 AM (in 17 h)\n#announcements, Example Hacks\nhttps://discord.com/channels/1300000000000000001/1300000000000000010/1300000000000009001");
  });

  test("ingesting again adds nothing, and alerts never repeat", async () => {
    const last = Date.parse(replay.posts.at(-1)!.at) + 120_000;
    expect((await ingestDiscord({ dir: downloads, bot: new DiscordBot(TOKEN, fakeOwnServer(() => last)), now: new Date(last) })).added).toBe(0);
    const r = await runAlerts({ nowMs: last, tz: "America/Los_Angeles", organizerIds: new Set(), send: async () => ({ sid: "x" }) });
    expect([r.fresh, r.outbox]).toEqual([[], []]);
    expect(existsSync("data/sms_outbox.jsonl")).toBe(true);
  });
});
