import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findTokens, scrubTokens, total } from "./domscrub.ts";
import { DEVPOST_FIXTURES_DIR, EVENTS_DIR, SLACK_DOM_FIXTURES_DIR } from "./event.ts";

// Fake values shaped like the real ones; none of these is a live credential.
const DIRTY = [
  `<script>window.boot_data = {"api_token":"xoxc-1111111111-2222222222-3333333333-abcdef0123456789","team_id":"T0"};</script>`,
  `<meta content="xoxd-AbCdEfGhIjKlMnOpQrStUv%2Bxyz">`,
  `<img src="https://files.slack.com/files-pri/T0-F0/x.png?t=xoxe-0123456789abcdef0123">`,
  `<a href="https://files.slack.com/files-tmb/T0-F1/y.png?pub_secret=0123456789abcdef01">y</a>`,
  `Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345`,
  `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
].join("\n");
// Rails (Devpost) session values, in both attribute orders.
const RAILS = [
  `<meta name="csrf-token" content="Zm9vYmFyQ1NSRnRva2VuMTIzNDU2Nzg5MA==">`,
  `<meta content="cXV1eENTUkZ0b2tlbjk4NzY1NDMyMQ==" name="csrf-token">`,
  `<input type="hidden" name="authenticity_token" value="YXV0aGVudGljaXR5VG9rZW4xMjM0NTY=" autocomplete="off">`,
  `<input value="c2Vzc2lvblZhbHVlOTg3NjU0MzIx" type="hidden" name="session_key">`,
  `<a href="/software/x/like?authenticity_token=dG9rZW5JblVSTDEyMzQ1Njc4OQ&amp;y=1">like</a>`,
  `document.cookie = "_devpost_session=c2Vzc2lvbkNvb2tpZTEyMzQ1Njc4OTA; path=/"`,
  `{"csrfToken":"anNvbkNTUkZ0b2tlbjEyMzQ1Njc4OTA="}`,
  `<div data-react-props="{&quot;user&quot;:1,&quot;csrfToken&quot;:&quot;ZW50aXR5Q1NSRnRva2VuMTIzNDU2&quot;}"></div>`,
].join("\n");

describe("scrubTokens", () => {
  test("strips every kind and leaves nothing a second scan finds", () => {
    const { html, found } = scrubTokens(DIRTY);
    expect(total(found)).toBeGreaterThanOrEqual(6);
    expect(total(findTokens(html))).toBe(0);
    for (const v of ["xoxc-1111", "xoxd-AbCd", "xoxe-0123", "abcdefghijklmnopqrstuvwxyz012345", "eyJhbGci", "0123456789abcdef01"]) expect(html).not.toContain(v);
  });
  test("Devpost: the csrf meta, authenticity_token fields and params, session cookies and JSON tokens", () => {
    const { html, found } = scrubTokens(RAILS);
    // At least one per line (the entity-quoted one is also seen by the decoded scan); zero after scrubbing is what counts.
    expect(total(found)).toBeGreaterThanOrEqual(8);
    expect(total(findTokens(html))).toBe(0);
    for (const v of ["Zm9vYmFy", "cXV1eENT", "YXV0aGVu", "c2Vzc2lvblZh", "dG9rZW5J", "c2Vzc2lvbkNv", "anNvbkNT", "ZW50aXR5"]) expect(html).not.toContain(v);
  });
  test("a token the rules can't reach through other entity quoting is still found, so a scan fails rather than passes", () => {
    expect(total(findTokens(`<div data-x="{&#34;session_id&#34;: &#34;c2Vzc2lvbklEMTIzNDU2Nzg5&#34;}">`))).toBeGreaterThan(0);
    expect(total(findTokens(`<a href="/x?y=1&amp;authenticity_token=dG9rZW4xMjM0NTY3">`))).toBeGreaterThan(0);
  });
  test("leaves Slack markup the parser reads alone", () => {
    const html = `<div data-qa="message_container" data-msg-ts="1761300001.000100"><a href="https://calhacks.slack.com/archives/C0/p1761300001000100?thread_ts=1761300000.000100&cid=C0">3 replies</a></div>`;
    expect(scrubTokens(html)).toEqual({ html, found: findTokens(html) });
    expect(total(findTokens(html))).toBe(0);
  });
});

const DIR = join(EVENTS_DIR, "calhacks-13", SLACK_DOM_FIXTURES_DIR);
const DEVPOST_DIR = join(EVENTS_DIR, "calhacks-13", DEVPOST_FIXTURES_DIR);
describe.skipIf(!existsSync(DEVPOST_DIR))("saved Devpost samples carry no session values", () => {
  test("every sample scans clean", () => {
    const dirty = readdirSync(DEVPOST_DIR)
      .filter((f) => f.endsWith(".html"))
      .filter((f) => total(findTokens(readFileSync(join(DEVPOST_DIR, f), "utf8"))) > 0);
    expect(dirty).toEqual([]);
  });
});
describe.skipIf(!existsSync(DIR))("saved DOM samples carry no session tokens", () => {
  test("every sample scans clean (run `bun run hr scrub-dom` if this fails)", () => {
    const dirty = readdirSync(DIR)
      .filter((f) => f.endsWith(".html"))
      .filter((f) => total(findTokens(readFileSync(join(DIR, f), "utf8"))) > 0);
    expect(dirty).toEqual([]);
  });
});
