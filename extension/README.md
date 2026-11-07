# HackRecon capture extension

Captures the Slack channel open in the current tab, as the web client renders it, into `<channel_id>.json` (schema: `pipeline/schema.ts`, `CaptureFile`). It also captures any other page open in the tab (Devpost, an event site) into `<host>-<path>.page.json` (`PageSnapshot`). It only scrolls the visible message pane. It makes no Slack API calls, opens no profile cards, and sends nothing anywhere.

## Build and load

```bash
bun install
bun run build:ext          # writes extension/dist/
```

In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `extension/`. Rebuild and hit the reload icon after any change.

## Capture a channel

1. Open the channel at `app.slack.com/client/...`.
2. Click the extension icon, then **Capture this channel**.
3. The overlay shows progress. It jumps to the newest message, then scrolls up one step every 1.5 s. It stops at the channel-start header (`stop_reason: channel_start`), or after 5 steps with no new messages (`no_new_keys`). **Stop and download** ends it early (`user_stopped`).
4. `<channel_id>.json` lands in Downloads. Move it to `events/<slug>/captures/` (gitignored).

Leave the tab visible while it runs. Do channels in `events/<slug>/config/sponsors.json` order, the locked 25 first.

## Capture a page

1. Open the page (e.g. the hackathon's Devpost overview, then its rules page).
2. Click the extension icon and answer **Can anyone open this page without logging in?** Pick "No" for anything you only see logged in (Hive, a sponsor portal). That answer decides whether the text is redacted before any model sees it; a file with no answer is treated as logged-in.
3. Click **Capture this page**. It reads the page once, as rendered, and downloads `<host>-<path>.page.json`. No requests, no scrolling.
4. Move it to `events/<slug>/captures/pages/` and run `bun run hr pages` to check it against `canon_pages` in `config/event.json`.

Content inside an iframe or a PDF isn't captured; the snapshot says so (`no_text`).

## Check it against the export, right away

```bash
bun run hr compare                              # every capture in events/current/captures/
bun run hr compare ~/Downloads/C0C7TCNCR1N.json  # one file
bun run hr compare --json events/current/captures/compare.json
```

Per channel you get:
- keyed recall by `ts` over the export's real top-level posts. It passes at ≥ 90%, and every miss is listed with its permalink.
- author match, which passes at ≥ 95%.
- bot posts found.
- extras, labeled as system-row leak, thread reply, posted after the export, or not in the export.
- `stop_reason`, the time, and system rows skipped vs the export.

Posters the export can't name are listed as "no name in export". These are the Slack Connect accounts in spons-moss and spons-wajo-ai. Check their captured name by hand.

The last line lists the locked-25 channels that don't pass yet. Exit code 1 means some channel failed keyed recall: fix it and re-capture (day-2 morning rule).

## Saving DOM samples (`events/<slug>/fixtures/slack-dom/`, gitignored)

Every Slack selector lives in `src/selectors.ts`. They were verified on 2026-10-27 against samples from spons-moss, spons-capital-one and spons-factory-ai. The few with no matching element in those samples (inline titles, APP badges) are marked UNVERIFIED. `src/parse.fixtures.test.ts` checks the parser against each sample using the export as the answer key:
- kept vs skipped rows
- authors after carry-forward
- the Slack Connect flag
- exact text for posts without markup
- ts consistency
- channel-start detection

If Slack changes its DOM, save fresh samples and rerun it.

To save one: scroll a channel to the spot you want, open DevTools → Console, and run

```js
copy(document.body.outerHTML)
```

Then in a terminal: `pbpaste > events/<slug>/fixtures/slack-dom/<channel>--<case>.html`, and then `bun run hr scrub-dom`. `outerHTML` can carry the session (xoxc- tokens in boot data, the xoxd- cookie, signed file URLs); scrub-dom strips them in place and prints counts only, and `bun test` fails while any sample still has one. Cover each of these at least once (the coverage tests name any that are missing):

| Case | Where to find one | File name |
|---|---|---|
| Channel-start header | scroll any channel to the very top | must contain `channel-start` (other samples may show it too) |
| Grouped posts (no repeated author header) | consecutive posts by one person | anything else |
| Bot post | Slackbot "… from Moss was added to this channel" (spons-moss, spons-wajo-ai, spons-capital-one) | |
| System rows | "joined #channel" rows (most channels) | |
| Labeled link | a post with "Use this link"-style text | |
| Thread pane, top (step 1) | a thread open in the side pane, scrolled up until the parent message shows | `--thread-top` |
| Thread pane, end (step 1) | the same pane scrolled to its last reply | `--thread-end` |
| Reply row (step 1) | the channel with the pane closed, a post showing "N replies · Last reply …" | `--reply-row` |
| More replies (step 1) | a pane showing a "Show more replies"-style control, if Slack renders one | `--thread-more` |

Then `bun test extension/`. Fix `src/selectors.ts` until it passes, and rebuild.
