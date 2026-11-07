// Zero setup (user 2026-11-07): what `hr discover` derives from the workspace and Devpost, on Cal Hacks' shapes.
import { describe, expect, test } from "bun:test";
import { devpostQuery, eventDraft, localIso, organizersFrom, organizerTag, slackDeadlines, timezoneFromQuote, toolGatedPatterns, workspaceSubdomain } from "./autoconfig.ts";
import type { Entity, Item, Message } from "./schema.ts";

const fv = <T>(value: T, quote = "", url = "https://cal-hacks-13-0.devpost.com/rules") => ({ value, source: { url, quote } as never });
const rule = (name: string, deadline: string, quote: string, kind = "submission"): Entity => ({
  id: name, kind: "rule", sponsor: "event", name: fv(name), fields: { deadline: fv(deadline, quote), rule_kind: fv(kind) }, history: [], origin: "page",
});
const track = (name: string): Entity => ({ id: name, kind: "track", sponsor: "x", name: fv(name), fields: {}, history: [], origin: "page" });
const post = (id: string, ts: string, text: string, author_id = "UORG", channel_name = "0-announcements"): Message =>
  ({ id, ts, text, author_id, channel_name, channel_id: "C1", permalink: `https://cal-hacks-13-0.slack.com/archives/C1/p${ts.replace(".", "")}` }) as Message;
const dl = (message_id: string, deadline_iso: string): Item => ({ message_id, item_index: 0, kind: "deadline", deadline_iso }) as Item;

describe("event from the workspace", () => {
  test("the subdomain most permalinks share, searched as words unless the workspace's name is known", () => {
    const sub = workspaceSubdomain(["https://cal-hacks-13-0.slack.com/archives/C1/p1", "https://cal-hacks-13-0.slack.com/archives/C2/p2", "https://other.slack.com/archives/C3/p3"]);
    expect(sub).toBe("cal-hacks-13-0");
    expect(devpostQuery(null, sub)).toBe("cal hacks 13 0");
    expect(devpostQuery("Cal Hacks 13.0", sub)).toBe("Cal Hacks 13.0");
    expect(workspaceSubdomain([])).toBeNull();
  });
  test("the organizer tag is the title less its edition", () => {
    expect(organizerTag("Cal Hacks 13.0")!.test("CAL HACKS | Dana")).toBe(true);
    expect(organizerTag("Cal Hacks 13.0")!.test("CalHacks Dana")).toBe(true);
    expect(organizerTag("TreeHacks 2026")!.test("Dana (TreeHacks)")).toBe(true);
    expect(organizerTag("Cal Hacks 13.0")!.test("Dana")).toBe(false);
  });
});

describe("organizers", () => {
  test("only signals a hacker can't set are written; a name tag, a title or posting in a named channel is only proposed", () => {
    const got = organizersFrom(
      [
        { id: "A", is_admin: true, names: "Dana" },
        { id: "B", is_owner: true, is_admin: true, names: "CAL HACKS | Lee" },
        { id: "C", names: "CAL HACKS | Sam" },
        { id: "D", names: "Kim", title: "Logistics Director" },
        { id: "E", names: "Hacker" },
        { id: "F", is_admin: true, deleted: true, names: "Gone" },
        { id: "G", is_admin: true, is_bot: true, names: "Bot" },
      ],
      organizerTag("Cal Hacks 13.0"),
      ["H"],
      ["I", "A"],
    );
    expect(got.organizers).toEqual([
      { id: "A", why: ["admin"] },
      { id: "B", why: ["admin", "owner"] },
      { id: "H", why: ["restricted-posting channel"] },
    ]);
    expect(got.proposals).toEqual([
      { id: "C", why: ["event name tag"] },
      { id: "D", why: ["title"] },
      { id: "I", why: ["posted in a channel named like announcements"] },
    ]);
  });
});

describe("deadlines and the timezone", () => {
  test("the zone Devpost's deadline names; none named stays unknown", () => {
    expect(timezoneFromQuote("October 25th @ 8 AM PST")).toBe("America/Los_Angeles");
    expect(timezoneFromQuote("Feb 16 @ 9:00am EST")).toBe("America/New_York");
    expect(timezoneFromQuote("October 25th @ 8 AM")).toBeNull();
    expect(localIso(Date.parse("2026-10-09T22:40:59Z"), "America/Los_Angeles")).toBe("2026-10-09T15:40:59-07:00");
  });

  // Cal Hacks: Devpost says 9:00; organizers moved it to 9:30 in #0-announcements.
  const messages = [
    post("m1", "1792000000.000001", "<!channel> We're officially less than 30 minutes till submissions are due"),
    post("m2", "1792000100.000001", "<!channel> Hey everyone! We’ve extended the Devpost submission deadline to 9:30 AM."),
    post("m3", "1792000200.000001", "<!channel> :bangbang: *JUDGING TABLE NUMBERS*"),
    post("m4", "1792000300.000001", "<!channel> we have public voting available until 2 pm, please log into devpost and submit your votes"),
    post("m5", "1792000400.000001", "Deadline for our raffle is 5pm", "UHACKER"),
    post("m6", "1792000500.000001", "Our prize is due at 4", "UORG", "spons-x"),
  ];
  const items = [dl("m1", "2026-10-25T09:00:00-07:00"), dl("m2", "2026-10-25T09:30:00-07:00"), dl("m3", "2026-10-25T10:30:00-07:00"), dl("m4", "2026-10-25T14:00:00-07:00"), dl("m5", "2026-10-24T17:00:00-07:00"), dl("m6", "2026-10-24T16:00:00-07:00")];
  const slack = slackDeadlines(items, messages, new Set(["0-announcements"]), new Set(["UORG"]));

  test("organizer deadlines in announcement channels only; a later submission time supersedes an earlier one", () => {
    expect(slack.map((s) => [s.what, s.submission, s.superseded_by ?? null])).toEqual([
      ["We're officially less than 30 minutes till submissions are due", true, "Hey everyone! We’ve extended the Devpost submission deadline to 9:30 AM."],
      ["Hey everyone! We’ve extended the Devpost submission deadline to 9:30 AM.", true, null],
      ["JUDGING TABLE NUMBERS", false, null],
      ["we have public voting available until 2 pm, please log into devpost and submit your votes", false, null], // "submit your votes" isn't the deadline
    ]);
  });

  test("event.json: Devpost's deadline superseded by the organizers' extension; restatements dropped; start and end never guessed", () => {
    const { config, sources } = eventDraft({
      title: "Cal Hacks 13.0",
      root: "https://cal-hacks-13-0.devpost.com/",
      why: "search",
      entities: [rule("Submit your hack", "2026-10-25T09:00-07:00", "October 25th @ 9 AM PST"), track("[MLH] Best Use of Gemini API"), track("[MLH] Best Use of ElevenLabs"), track("[Apify] Best Use of Apify")],
      slackSchedule: slack,
      oldestTs: Date.parse("2026-10-09T22:40:59Z") / 1000,
      authority: null,
    });
    expect(config.timezone).toBe("America/Los_Angeles");
    expect(config.oldest_message).toBe("2026-10-09T15:40:59-07:00");
    expect([config.hacking_start, config.hacking_end]).toEqual([null, null]);
    expect(config.canon_pages).toEqual(["https://cal-hacks-13-0.devpost.com/", "https://cal-hacks-13-0.devpost.com/rules"]);
    expect(config.tool_gated_prizes).toEqual(["[MLH] Best Use of *"]); // Apify's own product isn't tool-gated
    expect(config.schedule.map((s) => [s.at, s.superseded_by ?? null])).toEqual([
      ["2026-10-25T09:00-07:00", "Hey everyone! We’ve extended the Devpost submission deadline to 9:30 AM."], // Devpost's, superseded
      ["2026-10-25T09:30:00-07:00", null],
      ["2026-10-25T10:30:00-07:00", null],
      ["2026-10-25T14:00:00-07:00", null],
    ]);
    expect(sources.timezone).toContain("October 25th @ 9 AM PST");
  });

  test("no zone on the page: UTC, and the user is told", () => {
    const { config } = eventDraft({ title: "X", root: "https://x.devpost.com/", why: "", entities: [], slackSchedule: [], oldestTs: null, authority: { channels: ["announcements"], source: "names" } });
    expect(config.timezone).toBe("UTC");
    expect(config.unconfirmed.some((u) => u.startsWith("timezone:"))).toBe(true);
    expect(config.authority_channels).toEqual(["announcements"]);
    expect(config.oldest_message).toBeUndefined();
  });

  test("tool-gated needs two tracks under one tag", () => {
    expect(toolGatedPatterns([track("[MLH] Best Use of Gemini API")])).toEqual([]);
  });
});
