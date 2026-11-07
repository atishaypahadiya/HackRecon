// serializeBody over generic HTML, plus parseRows on observed edge-case rows.
// Selector coverage against real pages is in parse.fixtures.test.ts.
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { Accumulator } from "./accumulate.ts";
import { parseRows, serializeBody } from "./parse.ts";

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

// Rows built from the markup verified in fixtures/slack-dom/, reduced to what the parser reads.
// Each case is a row observed in the day-1 capture of the locked 25 (2026-10-27).
const W = "https://cal-hacks-13-0.slack.com/archives";

function row(key: string, inner: string): string {
  return `<div class="c-virtual_list__item" data-qa="virtual-list-item" role="listitem" data-item-key="${key}" id="message-list_${key}">${inner}</div>`;
}
function post(o: { ts: string; sender?: string; senderId?: string; href?: string; body?: string }): string {
  const sender = o.sender
    ? `<span class="c-message__sender c-message_kit__sender" data-qa="message_sender"><button ${o.senderId ? `data-message-sender="${o.senderId}" ` : ""}data-qa="message_sender_name" class="c-message__sender_button">${o.sender}</button></span>`
    : "";
  const stamp = o.href ? `<a data-ts="${o.ts}" class="c-link c-timestamp" href="${o.href}"><span data-qa="timestamp_label">9:19 PM</span></a>` : "";
  const body = o.body === undefined ? "" : `<div class="c-message_kit__blocks"><div class="c-message__message_blocks" data-qa="message-text"><div class="p-rich_text_section">${o.body}</div></div></div>`;
  return row(
    o.ts,
    `<div data-qa="message_container" class="c-message_kit__background"><div class="c-message_kit__gutter__right" data-qa="message_content">${sender}${stamp}${body}</div></div>`,
  );
}
function pane(rows: string[]): ParentNode {
  return parseHTML(`<div data-qa="message_pane" class="p-message_pane"><div data-qa="slack_kit_list">${rows.join("")}</div></div>`)
    .document as unknown as ParentNode;
}

describe("parseRows: non-posts and broadcasts from the day-1 capture", () => {
  const rows = parseRows(
    pane([
      // 0-announcements: the list-top slot rendered empty, without the channel intro markup.
      row("0000000000.000001", `<div></div>`),
      post({ ts: "1792819005.075629", sender: "Charlie [Cal Hacks]", senderId: "U0ZC363EB7D", href: `${W}/C0C7TCNCR1N/p1792819005075629`, body: "Welcome to Cal Hacks!" }),
      // cohost-hyphenate: deleted parent with replies: author shown, no timestamp link, no body.
      post({ ts: "1792960234.096399", sender: "ab1234", senderId: "U0Z65505026" }),
      // spons-cartesia: a reply also sent to the channel.
      post({
        ts: "1792882762.278609",
        sender: "Grant Tanner",
        senderId: "U0Z453CBA01",
        href: `${W}/C0C72S4D3LL/p1792882762278609?thread_ts=1792867132.187939&amp;cid=C0C72S4D3LL`,
        body: "More details on credits:",
      }),
      // spons-wajo-ai: GitHub's notice to the viewer only (no sender id, never in the export).
      post({ ts: "1793061633.116200", sender: "GitHub", href: `${W}/C0C6X92JH62/p1793061633116200`, body: "You won't see this prompt again." }),
    ]),
  );

  test("list-top placeholder is not a post (it breaks grouping like a divider)", () => {
    expect(rows[0]).toEqual({ kind: "divider" });
  });

  test("tombstone and Slack notice are skipped with their reason", () => {
    expect(rows.filter((r) => r.kind === "system").map((r) => r.kind === "system" && [r.ts, r.nonPost])).toEqual([
      ["1792960234.096399", "tombstone"],
      ["1793061633.116200", "slack_ui_notice"],
    ]);
  });

  test("broadcast is kept and carries its parent ts", () => {
    const b = rows.find((r) => r.kind === "message" && r.ts === "1792882762.278609");
    expect(b && b.kind === "message" && b.threadTs).toBe("1792867132.187939");
    const plain = rows.find((r) => r.kind === "message" && r.ts === "1792819005.075629");
    expect(plain && plain.kind === "message" && plain.threadTs).toBeUndefined();
  });

  test("end to end: two posts captured, non-posts counted by reason", () => {
    const acc = new Accumulator();
    acc.ingest(rows);
    const out = acc.finalize();
    expect(out.messages.map((m) => [m.ts, m.threadTs])).toEqual([
      ["1792819005.075629", undefined],
      ["1792882762.278609", "1792867132.187939"],
    ]);
    expect(out.nonPostsSkipped).toEqual({ tombstone: 1, slack_ui_notice: 1 });
    expect(out.unresolvedAuthors).toEqual([]);
  });

  test("a post seen half-rendered later stays a post", () => {
    const acc = new Accumulator();
    acc.ingest(parseRows(pane([post({ ts: "1792819005.075629", sender: "Charlie [Cal Hacks]", href: `${W}/C0C7TCNCR1N/p1792819005075629`, body: "hi" })])));
    acc.ingest(parseRows(pane([post({ ts: "1792819005.075629", sender: "Charlie [Cal Hacks]" })])));
    expect(acc.finalize().messages.map((m) => m.ts)).toEqual(["1792819005.075629"]);
  });
});

describe("headers whose author name Slack hadn't loaded (2026-11-06 sync)", () => {
  test("an unknown header is not a grouped post: blank author, not the one above", async () => {
    const { parseHTML } = await import("linkedom");
    const { Accumulator } = await import("./accumulate.ts");
    const row = (ts: string, head: string) =>
      `<div class="c-virtual_list__item" data-item-key="${ts}"><div data-qa="message_container" data-msg-ts="${ts}"><div data-qa="message_content">${head}<a class="c-timestamp" data-ts="${ts}" href="https://w.slack.com/archives/C1/p${ts.replace(".", "")}?thread_ts=1792951566.402279&amp;cid=C1">t</a><div data-qa="message-text">hi ${ts}</div></div></div></div>`;
    const html = `<div data-qa="message_pane">${row("1792954145.002549", '<span data-qa="message_sender"><button data-qa="message_sender_name">Alex Lane</button></span>')}${row("1792954221.441149", '<span class="c-missing_text c-missing_text--unknown"></span>')}${row("1792954250.000100", "")}</div>`;
    const doc = parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
    const acc = new Accumulator();
    acc.ingest(parseRows(doc, "https://app.slack.com/"));
    const out = acc.finalize();
    expect(out.messages.map((m) => m.sender.name)).toEqual(["Alex Lane", "", ""]);
    expect(out.unresolvedAuthors).toEqual(["1792954221.441149", "1792954250.000100"]);
  });

  test("a deleted parent with replies is kept as a thread to open, not a post", async () => {
    const { parseHTML } = await import("linkedom");
    const { Accumulator } = await import("./accumulate.ts");
    const html = `<div data-qa="message_pane"><div class="c-virtual_list__item" data-item-key="1792831361.174779"><div data-qa="message_container" data-msg-ts="1792831361.174779"><div data-qa="message_content"><div>This message was deleted.</div><div data-qa="reply_bar"><button data-qa="reply_bar_count">4 replies</button><span data-qa="reply_bar_hover_last_reply" data-ts="1792840000.000100">Last reply</span></div></div></div></div></div>`;
    const doc = parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
    const acc = new Accumulator();
    acc.ingest(parseRows(doc, "https://app.slack.com/"));
    const out = acc.finalize();
    expect(out.messages).toEqual([]);
    expect(out.deletedParents).toEqual([{ ts: "1792831361.174779", count: 4, last: "1792840000.000100" }]);
  });
});
