import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findTokens, scrubTokens, total } from "./domscrub.ts";
import { EVENTS_DIR, SLACK_DOM_FIXTURES_DIR } from "./event.ts";

// Fake values shaped like the real ones; none of these is a live credential.
const DIRTY = [
  `<script>window.boot_data = {"api_token":"xoxc-1111111111-2222222222-3333333333-abcdef0123456789","team_id":"T0"};</script>`,
  `<meta content="xoxd-AbCdEfGhIjKlMnOpQrStUv%2Bxyz">`,
  `<img src="https://files.slack.com/files-pri/T0-F0/x.png?t=xoxe-0123456789abcdef0123">`,
  `<a href="https://files.slack.com/files-tmb/T0-F1/y.png?pub_secret=0123456789abcdef01">y</a>`,
  `Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345`,
  `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
].join("\n");

describe("scrubTokens", () => {
  test("strips every kind and leaves nothing a second scan finds", () => {
    const { html, found } = scrubTokens(DIRTY);
    expect(total(found)).toBeGreaterThanOrEqual(6);
    expect(total(findTokens(html))).toBe(0);
    for (const v of ["xoxc-1111", "xoxd-AbCd", "xoxe-0123", "abcdefghijklmnopqrstuvwxyz012345", "eyJhbGci", "0123456789abcdef01"]) expect(html).not.toContain(v);
  });
  test("leaves Slack markup the parser reads alone", () => {
    const html = `<div data-qa="message_container" data-msg-ts="1761300001.000100"><a href="https://calhacks.slack.com/archives/C0/p1761300001000100?thread_ts=1761300000.000100&cid=C0">3 replies</a></div>`;
    expect(scrubTokens(html)).toEqual({ html, found: findTokens(html) });
    expect(total(findTokens(html))).toBe(0);
  });
});

const DIR = join(EVENTS_DIR, "calhacks-13", SLACK_DOM_FIXTURES_DIR);
describe.skipIf(!existsSync(DIR))("saved DOM samples carry no session tokens", () => {
  test("every sample scans clean (run `bun run hr scrub-dom` if this fails)", () => {
    const dirty = readdirSync(DIR)
      .filter((f) => f.endsWith(".html"))
      .filter((f) => total(findTokens(readFileSync(join(DIR, f), "utf8"))) > 0);
    expect(dirty).toEqual([]);
  });
});
