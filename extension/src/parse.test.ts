// serializeBody over generic HTML. Slack-specific selectors are covered by parse.fixtures.test.ts.
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { serializeBody } from "./parse.ts";

function body(html: string): Element {
  return parseHTML(`<div id="b">${html}</div>`).document.getElementById("b") as unknown as Element;
}

describe("serializeBody", () => {
  test("labeled links become `label <href>` and are listed (OV7)", () => {
    expect(serializeBody(body('Claim: <a href="https://x.dev/claim?c=1">Use this link</a> today'))).toEqual({
      text: "Claim: Use this link <https://x.dev/claim?c=1> today",
      links: ["https://x.dev/claim?c=1"],
    });
  });

  test("bare links aren't doubled", () => {
    expect(serializeBody(body('<a href="https://x.dev/">https://x.dev/</a> and <a href="https://y.dev">y.dev</a>')).text).toBe(
      "https://x.dev/ and https://y.dev",
    );
  });

  test("Slack's redirect wrapper is unwrapped", () => {
    const r = serializeBody(body('<a href="https://slack-redir.net/link?url=https%3A%2F%2Fx.dev%2Fa">go</a>'));
    expect(r.links).toEqual(["https://x.dev/a"]);
  });

  test("mentions and in-app links stay as plain text", () => {
    const r = serializeBody(body('hi <a href="/team/U0ZC7F5B60C">@Ada</a> see <a href="https://calhacks.slack.com/team/U1">@Bob</a>'));
    expect(r).toEqual({ text: "hi @Ada see @Bob", links: [] });
  });

  test("message permalinks count as links", () => {
    const p = "https://calhacks.slack.com/archives/C1/p1791591648310369";
    expect(serializeBody(body(`see <a href="${p}">this</a>`)).links).toEqual([p]);
  });

  test("line breaks, blocks and emoji alt text", () => {
    const r = serializeBody(body('<div>$50 credits <img alt=":tada:"></div><div>line two<br>line three</div><ul><li>a</li><li>b</li></ul>'));
    expect(r.text).toBe("$50 credits :tada:\nline two\nline three\na\nb");
  });

  test("the (edited) label is dropped", () => {
    expect(serializeBody(body('deadline Sunday <span class="c-message__edited_label">(edited)</span>')).text).toBe("deadline Sunday");
  });
});
