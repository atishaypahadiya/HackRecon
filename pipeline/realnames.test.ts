import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { commonWords, findIn, identities, localEventData } from "./realnames.ts";

describe("finding real people in a file (invented people throughout)", () => {
  const ids = identities(
    [
      { id: "U0ZREAL0001", names: ["Dana Kim, Bright Data", "danakim"], email: "dana@example.org" },
      { id: "U0ZREAL0002", names: ["[EXAMPLE HACKS] Evan Cole", "evcole_77"] },
      { names: ["founders", "Pat", "builders"] },
    ],
    ["write to partners@acme.example for credits"],
    new Set(["founder", "build"]),
  );

  test("full names, handles, ids and emails; an English word or a first name alone is never a handle", () => {
    expect([...ids.full].sort()).toEqual(["dana kim", "evan cole"]);
    expect([...ids.handles].sort()).toEqual(["danakim", "evcole_77"]);
    expect([...ids.emails].sort()).toEqual(["dana@example.org", "partners@acme.example"]);
  });

  test("each hit by file and line, whatever the case or punctuation", () => {
    const text = [
      `expect(posterRole(m("Dana Kim, Bright Data")))`,
      "// one of the founders of Mana, said Pat",
      `{ "author_id": "U0ZREAL0002" }`,
      "ping evcole_77. or PARTNERS@acme.example",
      "a U0ZREAL00021 is another id",
    ].join("\n");
    expect(findIn("x.ts", text, ids).map((h) => [h.line, h.kind, h.match])).toEqual([
      [1, "full name", "dana kim"],
      [3, "id", "U0ZREAL0002"],
      [4, "email", "PARTNERS@acme.example"],
      [4, "handle", "evcole_77"],
    ]);
  });
});

// The check itself: needs the events' own data, which is never tracked, so it skips in CI.
const data = localEventData("events");
const tracked = Bun.spawnSync(["git", "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean);

describe("no real people in tracked files (user 2026-11-08)", () => {
  test.skipIf(!data.people.length)(`no tracked file names anyone from a local event (${data.sources.join(", ") || "no event data here"})`, () => {
    const ids = identities(data.people, data.texts, commonWords("events"));
    const hits = tracked.flatMap((f) => {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        return [];
      }
      return text.includes("\0") ? [] : findIn(f, text, ids);
    });
    // Replace each with an invented name or ID; the test this file came from keeps its shape.
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind}`)).toEqual([]);
  });
});
