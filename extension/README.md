# HackRecon capture extension

Captures the Slack channel open in the current tab, as the web client renders it, into `<channel_id>.json` (schema: `pipeline/schema.ts`, `CaptureFile`). It also captures any other page open in the tab (Devpost, an event site) into `<host>-<path>.page.json` (`PageSnapshot`). It only scrolls the visible message pane. It makes no Slack API calls, opens no profile cards, and sends nothing anywhere.

## Build and load

```bash
bun install
bun run build:ext          # writes extension/dist/
```

In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `extension/`. Rebuild and hit the reload icon after any change.

## Sync this event

1. Open the event's Slack at `app.slack.com/client/...`.
2. Click the extension icon, then **Sync this event**. Keep the Slack window visible until it finishes (Chrome slows timers in hidden tabs).
3. It reads the sidebar and picks the event's channels from its config: every channel in `sponsors.json` (event channels like 2-opportunities included) and `event.json`'s `authority_channels`, in config order. `bun run build:ext` writes that list to `dist/sync-config.json` from `events/current`, so rebuild after changing the config. Channels the config doesn't list yet are found by prefix (`spons-`, `partner-`, `cohost-`, announcements) and reported in `sync.json` as discovered, next to any config channel missing from the sidebar. It opens each one with a sidebar click and captures it as below. Then it opens every thread it found, longest first. For each, it clicks "N replies", reads the pane from the parent down to the last reply, clicks any "show more replies" control, and closes the pane (`sync.json` records which close-button selector matched). Pacing: 1.5 s per scroll step, 1.5 s between threads, 3 s between channels. **Stop sync** ends it after the current step; finished channels are already saved.
4. Everything goes to `~/Downloads/hackrecon/sync/<stamp>/`: `captures/<channel_id>.json`, `.threads.json` and `.threads.raw.json` (the pane rows as scrubbed HTML, per scroll step), thread-pane samples in `slack-dom/`, and `sync.json` (what happened per channel and thread).
5. `bun run hr sync-ingest` copies the bundle into `events/<slug>/captures/sync-<stamp>/` and the samples into `fixtures/slack-dom/`, and prints a summary. Then `bun run hr compare events/current/captures/sync-<stamp>` scores channels and threads against the export.

It never posts, reacts or messages, makes no Slack API calls and opens no profile cards. Opening channels and threads marks them read, as it would for you.

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

## DOM samples (`events/<slug>/fixtures/slack-dom/`, gitignored)

Every Slack selector lives in `src/selectors.ts`. The channel selectors were verified on 2026-10-27 against samples from spons-moss, spons-capital-one and spons-factory-ai. The reply bar and sidebar selectors were verified against the same samples on 2026-11-06. The few with no matching element in those samples (inline titles, APP badges, the thread pane's own markup) are marked UNVERIFIED. `src/parse.fixtures.test.ts` checks the parser against each channel sample using the export as the answer key:
- kept vs skipped rows
- authors after carry-forward
- the Slack Connect flag
- exact text for posts without markup
- ts consistency
- channel-start detection

Samples are not saved by hand (user, 2026-11-06). **Sync this event** saves thread-pane samples on its own, scrubbed of session tokens before they leave the page (the same rules as `hr scrub-dom`):
- `<channel>--thread-<ts>-top.html` and `-end.html`: the pane at its top and at its end, for the sync's first thread and for threads with at least 8 replies (6 at most)
- `-more.html`: a pane showing a "more replies" control (2 at most)
- `-empty.html`: a pane that opened but gave no replies (2 at most)
- `-notfound-<ts>.html`: the page after a click on "N replies" that opened no pane (2 at most), for fixing the pane selectors

`src/thread.fixtures.test.ts` checks every pane sample against the export: the pane is found, and each reply read belongs to that parent and has the export's author. `bun test` fails while any sample still carries a token. If Slack changes its DOM, run a sync, then `bun test extension/`, fix `src/selectors.ts` until it passes, rebuild, and `bun run hr rebuild-threads` reparses the saved rows without another sync.
