import { describe, expect, test } from "bun:test";
import { compareSponsors, devpostCanonPages, discoverUrls, organizersFromRestricted, pickDevpostHit, sponsorsDraft } from "./discover.ts";
import { needsExtension, parseRobots, PoliteFetcher, robotsAllows, USER_AGENT } from "./fetch.ts";
import type { Entity, Message, PageSnapshot } from "./schema.ts";

const msg = (o: Partial<Message>): Message => ({
  text: "",
  id: `C1:${o.ts ?? "1.0"}`,
  channel_id: "C1",
  channel_name: "0-announcements",
  ts: "1.0",
  author_name: "Org",
  author_id: "U1",
  links: [],
  permalink: `https://x.slack.com/archives/C1/p${o.ts ?? "1"}`,
  captured_at: "",
  run_id: "r",
  ...o,
});

describe("discoverUrls", () => {
  const ms = [
    msg({ ts: "3.0", text: "Submit on our Devpost <http://cal-hacks-13-0.devpost.com/>. Check our live site <http://hive.example.org>" }),
    msg({ ts: "2.0", text: "Devpost: https://cal-hacks-13-0.devpost.com and last year https://cal-hacks-12-0.devpost.com/ and a project https://devpost.com/software/x" }),
    msg({ ts: "1.0", channel_name: "spons-acme", text: "our schedule https://acme.dev/schedule and https://other-event.devpost.com" }),
    msg({ ts: "4.0", thread_ts: "3.0", text: "reply https://reply-event.devpost.com" }),
  ];
  const d = discoverUrls(ms, new Set(["0-announcements"]));
  test("the most-linked Devpost subdomain in announcement posts is the event; others are listed, never canon", () => {
    expect(d.devpost?.url).toBe("https://cal-hacks-13-0.devpost.com/");
    expect(d.devpost?.posts).toHaveLength(2);
    expect(d.devpost_other.map((f) => f.url)).toEqual(["https://cal-hacks-12-0.devpost.com/"]);
  });
  test("schedule candidates need a schedule word or path; other channels and thread replies don't count", () => {
    expect(d.schedule.map((f) => [f.url, f.why])).toEqual([["https://hive.example.org/", 'linked as "live site"']]);
  });
  test("Devpost's standard pages", () => {
    expect(devpostCanonPages("https://e.devpost.com/")).toEqual(["https://e.devpost.com/", "https://e.devpost.com/rules"]);
  });
});

describe("pickDevpostHit", () => {
  const hits = [{ title: "Cal Hacks 13.0", url: "https://cal-hacks-13-0.devpost.com/" }, { title: "DDoSki's Hack Night", url: "https://d.devpost.com/" }];
  test("only an exact (normalized) title match is picked", () => {
    expect(pickDevpostHit("Cal Hacks 13.0", hits).hit?.url).toBe("https://cal-hacks-13-0.devpost.com/");
    expect(pickDevpostHit("cal hacks 13.0", hits).hit).not.toBeNull();
    expect(pickDevpostHit("Cal Hacks", hits).hit).toBeNull();
    expect(pickDevpostHit("X", [...hits, ...hits]).why).toContain("no hackathon titled");
    expect(pickDevpostHit("Cal Hacks 13.0", [hits[0]!, hits[0]!]).why).toContain("2 hackathons");
  });
});

describe("sponsorsDraft", () => {
  const track = (sponsor: string): Entity => ({ id: sponsor, kind: "track", sponsor, name: { value: `[${sponsor}] Best`, source: { kind: "page", url: "", quote: "", captured_at: "" } }, fields: {}, history: [], origin: "page" });
  const tracks = ["Fetch.ai", "CRS", "Capital One", "Bitdeer AI", "Convex", "event"].map(track);
  const chans = ["0-announcements", "spons-fetch-ai", "spons-crs-credit-api", "spons-capital-one", "spons-bitdeer", "cohost-convex", "spons-supercell", "random"];
  const d = sponsorsDraft(tracks, chans, new Set(["0-announcements"]));
  test("prize tags match channels by words; unknown channels are named from the channel and flagged", () => {
    expect(Object.fromEntries(Object.entries(d.sponsors).map(([c, s]) => [c, `${s.sponsor}/${s.kind}`]))).toEqual({
      "0-announcements": "event/event",
      "cohost-convex": "Convex/cohost",
      "spons-bitdeer": "Bitdeer AI/sponsor",
      "spons-capital-one": "Capital One/sponsor",
      "spons-crs-credit-api": "CRS/sponsor",
      "spons-fetch-ai": "Fetch.ai/sponsor",
      "spons-supercell": "Supercell/sponsor",
    });
    expect(d.channels_without_tag).toEqual(["spons-supercell"]);
    expect(d.tags_without_channel).toEqual([]);
  });
  test("compared with a hand-written file, aliases count as agreement", () => {
    const r = compareSponsors(d.sponsors, { "spons-fetch-ai": { sponsor: "Fetch.ai", kind: "sponsor", aliases: [] }, "spons-bitdeer": { sponsor: "Bitdeer", kind: "sponsor", aliases: ["Bitdeer AI"] }, "x": { sponsor: "X", kind: "sponsor", aliases: [] } });
    expect([r.matched, r.n]).toEqual([2, 3]);
  });
});

describe("organizersFromRestricted", () => {
  test("top-level human posters in restricted channels, most posts first", () => {
    const ms = [msg({ author_id: "U1" }), msg({ author_id: "U1", ts: "2.0" }), msg({ author_id: "U2", ts: "3.0" }), msg({ author_id: "U3", ts: "4.0", thread_ts: "1.0" }), msg({ author_id: "U4", channel_name: "chat" }), msg({ author_id: "B1", author_kind: "bot" })];
    expect(organizersFromRestricted(ms, new Set(["0-announcements"])).map((p) => [p.id, p.posts])).toEqual([["U1", 2], ["U2", 1]]);
  });
});

describe("robots.txt", () => {
  const txt = "User-agent: *\nDisallow:\n\nUser-agent: BadBot\nDisallow: /\n\nUser-agent: HackRecon\nUser-agent: other\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.pdf$\n";
  test("our group wins over *; longest match wins; Allow wins a tie; wildcards and $", () => {
    const r = parseRobots(txt);
    expect(robotsAllows(r, "/")).toBe(true);
    expect(robotsAllows(r, "/private/x")).toBe(false);
    expect(robotsAllows(r, "/private/ok")).toBe(true);
    expect(robotsAllows(r, "/private/ok/more")).toBe(false);
    expect(robotsAllows(r, "/a/b.pdf")).toBe(false);
    expect(robotsAllows(r, "/a/b.pdf?x")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /\n"), "/x")).toBe(false);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "/x")).toBe(true);
    expect(robotsAllows("none", "/x")).toBe(true);
    expect(robotsAllows("deny", "/x")).toBe(false);
  });
});

describe("PoliteFetcher", () => {
  const html = (body: string) => new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
  const mk = (routes: Record<string, () => Response>) => {
    const calls: { url: string; ua: string }[] = [];
    const f = new PoliteFetcher(async (url, init) => {
      calls.push({ url, ua: (init.headers as Record<string, string>)["User-Agent"]! });
      const r = routes[url];
      return r ? r() : new Response("nf", { status: 404 });
    });
    return { f, calls };
  };
  test("one request per URL per sync, robots.txt once per host, honest User-Agent", async () => {
    const { f, calls } = mk({ "https://e.devpost.com/robots.txt": () => new Response("User-agent: *\nDisallow:\n"), "https://e.devpost.com/": () => html("<p>hi</p>") });
    const [a, b] = await Promise.all([f.get("https://e.devpost.com/"), f.get("https://e.devpost.com/")]);
    expect(a.status).toBe("fetched");
    expect(b).toBe(a);
    expect(calls.map((c) => c.url)).toEqual(["https://e.devpost.com/robots.txt", "https://e.devpost.com/"]);
    expect(calls.every((c) => c.ua === USER_AGENT)).toBe(true);
  });
  test("robots disallow, unreachable robots, login redirects, 403 and off-site redirects", async () => {
    const { f } = mk({
      "https://a.com/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
      "https://b.com/robots.txt": () => new Response("down", { status: 503 }),
      "https://c.com/": () => new Response(null, { status: 302, headers: { location: "/login?next=/" } }),
      "https://d.com/": () => new Response("no", { status: 403 }),
      "http://e.com/": () => new Response(null, { status: 301, headers: { location: "https://e.com/" } }),
      "https://e.com/": () => html("ok"),
      "https://f.com/": () => new Response(null, { status: 302, headers: { location: "https://elsewhere.net/" } }),
    });
    expect((await f.get("https://a.com/")).status).toBe("blocked_by_robots");
    expect((await f.get("https://b.com/")).detail).toContain("unreachable");
    expect((await f.get("https://c.com/")).status).toBe("needs_extension");
    expect((await f.get("https://d.com/")).status).toBe("refused");
    const e = await f.get("http://e.com/");
    expect([e.status, e.final_url, e.requests]).toEqual(["fetched", "https://e.com/", 2]);
    expect((await f.get("https://f.com/")).detail).toContain("off-site");
  });
  test("a page with no text or a short login form needs the extension", () => {
    const snap = (blocks: PageSnapshot["blocks"], no_text?: string) => ({ blocks, no_text }) as PageSnapshot;
    expect(needsExtension(snap([], "no text captured"), "")).toContain("without JavaScript");
    expect(needsExtension(snap([{ i: 0, path: [], text: "Sign in" }]), '<input type="password">')).toContain("login form");
    expect(needsExtension(snap([{ i: 0, path: [], text: "x".repeat(900) }]), '<input type="password">')).toBeNull();
    expect(needsExtension(snap([{ i: 0, path: [], text: "Schedule" }, { i: 1, path: [], text: "Loading the schedule…" }]), "")).toContain("JavaScript");
  });
});
