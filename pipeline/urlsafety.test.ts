// The no-action-URL rule (user 2026-11-07): any site, signed in or not.
import { describe, expect, test } from "bun:test";
import { PoliteFetcher } from "./fetch.ts";
import { pathWords, refuseLoad } from "./urlsafety.ts";

describe("refuseLoad", () => {
  test("a path naming any of the eight actions is never loaded, however it's spelled", () => {
    for (const u of [
      "https://devpost.com/software/add",
      "https://devpost.com/software/new",
      "https://devpost.com/software/hindsight-68sruh/edit",
      "https://example.com/posts/12/delete",
      "https://example.com/api/destroy_session",
      "https://devpost.com/submit-to/26000-cal-hacks-13-0/manage/submissions",
      "https://example.com/blog/publishPost",
      "https://hive.hackberkeley.org/teams/join?code=x",
      "https://example.com/%61dd",
      "https://example.com/EDIT",
    ])
      expect([u, refuseLoad(u)]).toEqual([u, expect.stringContaining("never loaded")]);
  });
  test("words that only contain a verb, and verbs in the query, are not the path naming an action", () => {
    for (const u of [
      "https://cal-hacks-13-0.devpost.com/",
      "https://cal-hacks-13-0.devpost.com/rules",
      "https://devpost.com/software/hindsight-68sruh",
      "https://example.com/news/address-book",
      "https://example.com/submissions",
      "https://example.com/schedule?mode=edit",
    ])
      expect([u, refuseLoad(u)]).toEqual([u, null]);
    expect(pathWords("/blog/publishPost/new_item")).toEqual(["blog", "publish", "post", "new", "item"]);
  });
  test("the fetcher refuses before any request, including on a redirect hop", async () => {
    let calls = 0;
    const site = async (u: string) => {
      if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      calls++;
      return u.endsWith("/start") ? new Response("", { status: 302, headers: { location: "/software/add" } }) : new Response("<html></html>", { headers: { "content-type": "text/html" } });
    };
    const f = new PoliteFetcher(site as never, async () => ["93.184.216.34"]);
    expect((await f.get("https://example.com/items/new")).detail).toContain("never loaded");
    expect(calls).toBe(0);
    const r = await f.get("https://example.com/start");
    expect(r.detail).toContain("never loaded");
    expect(calls).toBe(1); // only /start; the redirect target was never requested
  });
});
