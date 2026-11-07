import { describe, expect, test } from "bun:test";
import { countAuthors, hackerOnlyChannels } from "./hackerchannels.ts";
import { SCHEMA_VERSION, parseAuthorsCaptureFile } from "./schema.ts";

describe("authors-only capture of hacker-only channels", () => {
  test("by name unless event.json lists them", () => {
    expect(hackerOnlyChannels(["1-team-formation", "1-introductions", "spons-apify", "intro-to-hackathons"])).toEqual(["1-introductions", "1-team-formation"]);
    expect(hackerOnlyChannels(["1-team-formation", "find-a-team"], ["find-a-team"])).toEqual(["find-a-team"]);
  });

  test("reduced to sender IDs and counts; bots skipped; hidden senders counted, not guessed", () => {
    const r = countAuthors([{ author_id: "U2" }, { author_id: "U1" }, { author_id: "U2" }, { author_kind: "bot", author_id: "B1" }, {}]);
    expect(r).toEqual({ authors: [{ id: "U1", posts: 1 }, { id: "U2", posts: 2 }], unidentified: 1 });
  });

  const file = {
    schema_version: SCHEMA_VERSION,
    kind: "authors",
    source: "extension",
    run_id: "r",
    channel_id: "C1",
    channel_name: "1-team-formation",
    started_at: "",
    finished_at: "",
    stop_reason: "channel_start",
    threads: { parents: 3, read: 2 },
    authors: [{ id: "U0C96ADHY8K", posts: 2 }],
    unidentified: 0,
  };
  test("the parser accepts exactly those fields", () => {
    expect(parseAuthorsCaptureFile(file).authors).toHaveLength(1);
  });
  test("any text, name or extra field is refused", () => {
    expect(() => parseAuthorsCaptureFile({ ...file, messages: [] })).toThrow("not an authors-only field");
    expect(() => parseAuthorsCaptureFile({ ...file, authors: [{ id: "U0C96ADHY8K", posts: 1, name: "Shiloah" }] })).toThrow("expected only id and posts");
    expect(() => parseAuthorsCaptureFile({ ...file, authors: [{ id: "looking for a team!", posts: 1 }] })).toThrow("expected a Slack user ID");
    expect(() => parseAuthorsCaptureFile({ ...file, threads: { parents: 1, read: 1, text: "hi" } })).toThrow("expected only parents and read");
  });
});
