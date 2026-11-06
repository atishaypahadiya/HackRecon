# HackRecon capture extension

Captures the Slack channel open in the current tab, as the web client renders it, into `<channel_id>.json` (schema: `pipeline/schema.ts`, `CaptureFile`). It only scrolls the visible message pane. It makes no Slack API calls, opens no profile cards, and sends nothing anywhere.

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
4. `<channel_id>.json` lands in Downloads. Move it to `captures/` (gitignored).

Leave the tab visible while it runs. Do channels in `config/sponsors.json` order, the locked 25 first.

## Check it against the export, right away

```bash
bun run hr compare captures/                     # every capture
bun run hr compare ~/Downloads/C0C7TCNCR1N.json  # one file
bun run hr compare captures/ --json captures/compare.json
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

Then in a terminal: `pbpaste > events/<slug>/fixtures/slack-dom/<channel>-<case>.html`. Cover each of these at least once (the coverage tests name any that are missing):

| Case | Where to find one | File name |
|---|---|---|
| Channel-start header | scroll any channel to the very top | must contain `channel-start` (other samples may show it too) |
| Grouped posts (no repeated author header) | consecutive posts by one person | anything else |
| Bot post | Slackbot "… from Moss was added to this channel" (spons-moss, spons-wajo-ai, spons-capital-one) | |
| System rows | "joined #channel" rows (most channels) | |
| Labeled link | a post with "Use this link"-style text | |

Then `bun test extension/`. Fix `src/selectors.ts` until it passes, and rebuild.
