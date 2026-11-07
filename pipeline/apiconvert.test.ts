// The API pull's converter (user 2026-11-07): Slack's message objects in the DOM capture's text format, and the
// pull-against-export check.
import { describe, expect, test } from "bun:test";
import { apiKeys, captureFromApi, compareKeys, exportKeys, renderText, type ApiChannelFile, type ApiUser } from "./apiconvert.ts";
import { parseCaptureFile, parseThreadCaptureFile } from "./schema.ts";

const ORIGIN = "https://cal-hacks-13-0.slack.com";
const users = new Map<string, ApiUser>([["U1", { id: "U1", profile: { display_name: "Arinze Obiezue" } }]]);
const channels = new Map([["C9", "0-ask-directors"]]);

describe("renderText: the DOM serializer's rules", () => {
  test("links as `label <href>`, the URL alone when the label is the URL (with or without its scheme)", () => {
    expect(renderText("Hey hackers! <https://platform.claude.com/offers/x|Use this link> to get $50", users, channels, ORIGIN)).toEqual({
      text: "Hey hackers! Use this link <https://platform.claude.com/offers/x> to get $50",
      links: ["https://platform.claude.com/offers/x"],
      mentions: [],
    });
    expect(renderText("at <https://hive.hackberkeley.org/hardware|hive.hackberkeley.org/hardware>.", users, channels, ORIGIN).text).toBe("at https://hive.hackberkeley.org/hardware.");
    expect(renderText("queue: <https://hive.hackberkeley.org/q>", users, channels, ORIGIN).text).toBe("queue: https://hive.hackberkeley.org/q");
    expect(renderText("via <mailto:a@b.co|a@b.co>", users, channels, ORIGIN).text).toBe("via a@b.co <mailto:a@b.co>");
  });
  test("mentions, channels and broadcasts as rendered; emphasis, bullets and entities dropped", () => {
    const r = renderText("<@U1> Sent you a dm! Ask in <#C9|0-ask-directors>, <!channel>\n• *bold* and _it_ &amp; `code`", users, channels, ORIGIN);
    expect(r.text).toBe(`@Arinze Obiezue Sent you a dm! Ask in #0-ask-directors <${ORIGIN}/archives/C9>, @channel\nbold and it & code`);
    expect(r.mentions).toEqual([{ id: "U1", label: "@Arinze Obiezue" }]);
    expect(r.links).toEqual([`${ORIGIN}/archives/C9`]);
  });
});

describe("captureFromApi", () => {
  const file: ApiChannelFile = {
    kind: "api-channel",
    channel_id: "C1",
    channel_name: "spons-apify",
    started_at: "2026-11-07T20:00:00.000Z",
    finished_at: "2026-11-07T20:00:05.000Z",
    oldest: null,
    history: [
      { ts: "1792000000.000100", user: "U1", text: "credits!", reply_count: 2, latest_reply: "1792000200.000100" },
      { ts: "1792000050.000100", subtype: "channel_join", user: "U2", text: "joined" },
      { ts: "1792000200.000100", thread_ts: "1792000000.000100", subtype: "thread_broadcast", user: "U1", text: "also here" },
    ],
    replies: { "1792000000.000100": [{ ts: "1792000100.000100", thread_ts: "1792000000.000100", user: "U2", text: "how?" }, { ts: "1792000200.000100", thread_ts: "1792000000.000100", subtype: "thread_broadcast", user: "U1", text: "also here" }] },
  };
  test("the DOM sync's two files, valid; system rows skipped and counted; permalinks as Slack builds them", () => {
    const { channel, threads } = captureFromApi(file, { origin: ORIGIN, runId: "api-x", users, channels });
    expect(() => parseCaptureFile(JSON.parse(JSON.stringify(channel)))).not.toThrow();
    expect(() => parseThreadCaptureFile(JSON.parse(JSON.stringify(threads)))).not.toThrow();
    expect(channel.messages.map((m) => [m.ts, m.subtype ?? null, m.author_name])).toEqual([
      ["1792000000.000100", null, "Arinze Obiezue"],
      ["1792000200.000100", "thread_broadcast", "Arinze Obiezue"],
    ]);
    expect(channel.system_rows_skipped).toBe(1);
    expect(channel.messages[0]!.permalink).toBe(`${ORIGIN}/archives/C1/p1792000000000100`);
    expect(channel.messages[0]!.reply_count).toBe(2);
    expect(threads.threads[0]!.replies.map((r) => [r.ts, r.permalink])).toEqual([
      ["1792000100.000100", `${ORIGIN}/archives/C1/p1792000100000100?thread_ts=1792000000.000100&cid=C1`],
      ["1792000200.000100", `${ORIGIN}/archives/C1/p1792000200000100?thread_ts=1792000000.000100&cid=C1`],
    ]);
  });

  test("against the export: replies counted without sent-to-channel copies, as the 494 baseline counts them", () => {
    const exp = exportKeys([...file.history, ...file.replies["1792000000.000100"]!]);
    expect([...exp.visible]).toEqual(["1792000000.000100", "1792000200.000100"]);
    expect([...exp.replies]).toEqual(["1792000100.000100"]);
    expect(compareKeys("spons-apify", apiKeys([file]).get("spons-apify"), exp)).toEqual({
      channel: "spons-apify",
      posts: { export: 2, matched: 2, missing: [], extra: 0 },
      replies: { export: 1, matched: 1, missing: [], extra: 0 },
    });
    const late = { ...file, history: [...file.history, { ts: "1792900000.000100", user: "U1", text: "after the export" }] };
    const noReplies = { ...late, replies: {} };
    expect(compareKeys("spons-apify", apiKeys([noReplies]).get("spons-apify"), exp)).toEqual({
      channel: "spons-apify",
      posts: { export: 2, matched: 2, missing: [], extra: 1 },
      replies: { export: 1, matched: 0, missing: ["1792000100.000100"], extra: 0 },
    });
  });
});
