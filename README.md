# HackRecon

A hackathon agent for one hacker. It reads the event as it happens (the Devpost page, the event site, Slack, Discord), works out what matters to the project the hacker is building, and reaches them in a chat they already use. It never acts for them: it drafts, and the hacker sends.

The hacker meets it as **Donna**: the Telegram bot, the alert text, the extension's status lines and the board all say Donna. The repo, the `hr` CLI, file paths and the crawler's User-Agent keep the name HackRecon.

Built on Cal Hacks 13.0 (Oct 2026), the only event with captured Slack, a Slack export to check against and hand labels. The next live test is Iterate, Nov 14, on Discord.

Private, single-user, local. It is not distributed.

## What it answers

A hacker at a live event has five questions, and the event's Slack is the wrong place to start on most of them:

- **What should I build, and which prizes can one project enter?** The Devpost page answers this; Slack adds clarifications.
- **What's happening now, and what changed?** The event site says what was planned; Slack says what moved. At Cal Hacks the submission deadline moved from 09:00 to 09:30 in a Slack post.
- **What can I claim?** Credits, prizes and offers posted in 54 sponsor channels, most of them buried under questions.
- **Who should I talk to, and where are they?** Sponsor reps, identified only on evidence, and the booth they're at.
- **Am I ready to submit?** Devpost's submission rules plus each chosen track's stated requirements, checked against the repo. This is the most expensive one to get wrong.

## How it works

```
  the event's spaces                         the hacker
  ──────────────────                         ──────────
  Devpost, event site ──fetch──┐             Plan: idea, stack, repo link
  Slack (read-only API) ──┐    │                    │
  Discord (open tabs,     │    ▼                    ▼
   followed crossposts) ──┴─► capture ─► canon + live layer ─► merge ─► Plan · Ship · Credits · Sessions · People
                                  │            │                 │                 │
                                  │      every field has a       │      board (127.0.0.1), Telegram, SMS
                                  │      verified quote          │
                                  └── classify new posts ────────┴─► alerts: at once, or in the 2-hour digest
```

**Canon and the live layer.** A public page is what the organizer committed to in writing; Slack and Discord are where it changes. Pages are fetched and read into typed entities (tracks, prizes, criteria, rules, schedule items), each field with a quote that code checks is on the page. Posts are classified (Haiku) into offers, deadlines, workshops and changes. When the two disagree, the newest authorized post wins on that field and the page's value stays beside it ("Page: 09:00 · Slack, organizer, Sat 8:12 PM: 09:30"), so a false override is visible, never silent.

**Authority.** Only some posters can override canon, and only by signals a hacker can't set: restricted-posting channels, crossposts the hacker's own bot followed, or channel IDs the hacker listed. A display-name tag or a post's text never grants it. Organizers can override any event entity; a sponsor's rep only their own sponsor's tracks, prizes, offers and booth; a hacker's post never overrides anything.

**Plan.** The hacker pastes a repo link (or types an idea). Donna drafts the description, stack and what each piece is used for, each draft with the repo lines it came from, to confirm one by one. Plan then ranks the sponsor tracks the project fits, each with a verified quote of the requirement it meets, and lists the gaps between the repo and each likely track's stated requirements, the credits worth claiming, the sessions in the hacker's free time, and the people to pitch with the booth questions to ask them.

**Ship.** The tracks the hacker entered, their requirements and entry steps rechecked against the repo's latest commit, and the deadline with any post that moved it.

**Every number traces to a source.** Every amount, date and requirement on screen points to a quoted span. "Not stated" is a value and is never filled with a guess.

## Three doors, one brain

Every door talks to the same brain. No door has logic of its own.

| Door | Built | Notes |
|---|---|---|
| Board (`hr board`) | Plan, Ship, Credits, Sessions, People; drafts to confirm one by one | Local, 127.0.0.1 only. A hosted board behind a login is decided, not built |
| Chat | Telegram, two-way | Alerts arrive there. Anything typed is a question, answered from the Plan and the event's data with the source channel named, or "I don't know" |
| Messaging | SMS through Twilio, alerts only | iMessage and WhatsApp planned; a channel is one adapter in `pipeline/channels.ts` |

**When it speaks** (`pipeline/alerts.ts`, no model calls). One alert per post, the most urgent match: a room or time change, a deadline, tracks posted, judging info, a workshop, a sponsor offer. Changes, organizer deadlines, tracks and judging go out at once; workshops and offers go out at once only when they name a stack item or a Plan track's sponsor or product. Everything else waits for a digest every 2 hours, up to 6 items. At most one immediate message per 10 minutes and four an hour. A post alerts only while it's under 6 hours old, never twice. Answers stop at 20 an hour, and a question older than 15 minutes when Donna reads it is skipped, since the answer may have changed.

## Consent rules

- **No self-bots.** On Slack, five read-only methods from an allowlist (`conversations.list`, `.history`, `.replies`, `users.list`, `users.info`); nothing that posts, reacts or marks read. `extension/src/slackapi.ts` is the only code that reaches `/api/`, and a test pins the method list and scans every extension source file for anything else. On Discord, the extension reads only what open tabs render: it never navigates, clicks, scrolls or types, and it uses no user token. The Donna bot uses its own token, GET requests only, to 3 allowlisted routes, in the hacker's own server.
- **The hacker sends every message to another person.** Donna writes openers and drafts; she messages only the hacker.
- **No LinkedIn scraping.** LinkedIn appears only as search links; nothing is fetched.
- **Credentials stay put.** Tokens come from `.env` or live in extension memory (`chrome.storage.session`). They never reach disk, logs, captures or errors, and every saved file is scanned for token patterns first.
- **Workspace data is never committed.** Only synthetic fixtures are tracked; `pipeline/event.test.ts` fails if any workspace folder is.
- **Spending is capped and announced** (`pipeline/costguard.ts`). Every model client is wrapped. Before each call it estimates the call from the request (input at 2 characters a token, uncached, plus the whole output budget, at list price), and a run estimated over $1 is refused without `--yes`. Chat answers stop at $1 per watch session and $3 per event day, and Donna says so.
- **Open:** consent at scale. If Donna served many hackers at one event, what may she hold about people who never used her? This is undecided, and it gates any multi-user version.

## Numbers

All from Cal Hacks 13.0. Model-graded numbers are agreement with a judge or with Devpost's outcomes, never accuracy, and each says which.

**Slack read-only pull, live (2026-11-07).** A full pull: 18 min 13 s, 387 calls, 0 retries, 0 channel errors, 56 channels. `hr compare-api` against the Slack export: 54/54 channels, posts 1177/1177, replies 585/585, the 25 priority channels' replies 494/494; the 30 posts and 7 replies only in the pull are all newer than the export. A quiet incremental pull: 255 s, 72 calls (three runs alike). After an extension reload with no click, the next timer pull ran on the session the Slack tab handed back.

**Zero setup** (`hr discover`, no model). Cal Hacks' hand-written config deleted and regenerated from the workspace, Devpost and the last sync: 53 of 54 sponsor channels with the same sponsor and kind (the miss is `2-opportunities`, which has no prefix), 52 of 55 organizers (the other 3 are only proposed, since name tags and titles are self-asserted), the event, timezone and canon pages identical. The schedule matches 2 of 4 hand entries by time and adds 6 the hand file never listed.

**Canon from the Devpost page.** 152 entities from the overview (52 tracks, 78 prizes, 10 criteria, 12 rules) and 4 rules from the rules page. Every quote verified. The page's stated total, $204,408, equals the sum over its 52 prize blocks of cash × winners exactly; 52 of 52 blocks have a track and a prize. The Opus judge, given only the page and the output: 0 missing, 0 misplaced. $1.71 at list price. Extractions are stored by prompt and input hash, so an unchanged page reproduces the same canon.

**Idea fit** (Sonnet ranker, 81 Cal Hacks projects that won a sponsor track, 94 project–track pairs over 40 prizes; agreement with Devpost outcomes):

| | Description only | + Built With |
|---|---|---|
| recall@3, all pairs | 37.2% (35/94) | **58.5% (55/94)** |
| recall@3, "Best Use of X" pairs | 27.6% (16/58) | 60.3% (35/58) |
| recall@5, all pairs | 41.5% (39/94) | 72.3% (68/94) |
| any hit per project | 40.7% (33/81) | 65.4% (53/81) |

The stack adds 21.3 points over all pairs, past the 10-point bar set before the run, so Plan asks for the stack. 162 rankings, 0 failed, every cited quote verified, $1.47.

**The classifier** (Haiku on all 1,007 captured posts, 0 errors; agreement with 261 rows labeled by Opus as judge, blind to Haiku):

| | Result | Bar |
|---|---|---|
| capture recall | 100.0% (68/68) | ≥ 95% |
| credit precision / recall | 93.5% (43/46) / 97.7% (43/44) | ≥ 85% |
| dated precision / recall | **72.7% (24/33)** / 88.9% (24/27) | ≥ 85% |
| per-person amount | 95.5% (42/44) | ≥ 90% |
| deadline | 91.7% (22/24) | ≥ 90% |

Dated precision fails its bar. The gate was accepted as is, with no more prompt tuning, so the classifier isn't fit to the labeled rows; everything counted from dated items says it inherits that.

**The demo flow** (2026-11-07, Hindsight's repo, board at Saturday noon): repo link → 17 drafts → Plan in 8.1 s cold (tracks at 5.0 s; 149 ms cached): 4 likely tracks and 1 possible, one gap with its repo lines, 2 credits, the Anthropic workshop at 1 PM, 4 sponsors' booth questions and reps → Ship.

**API text vs DOM text.** On the 1,007 captured posts, the API pull converted by the DOM serializer's rules matches the DOM text for 939 after whitespace normalization, links for 1000, authors for 989, author IDs for 1007. The rest are rendering quirks, like a space before a period.

## Evaluation discipline

- Opus is the judge and Haiku or Sonnet the worker. The judge sees only the source and the output, never the worker's reasoning or answers.
- `hr gate` and `hr label` never print classifier answers for rows a person hasn't labeled. A person's label always wins over the judge's.
- Thresholds are set before a run and not moved after it. A failed bar is reported as failed.
- Every run that can spend money prints its estimate first, and the estimate is checked before the first call.

## Status

As of 2026-11-08.

**Verified live:** the Slack read-only pull and its comparison against the export; discovery against the hand config; canon from the fetched Devpost page; the board's Plan and Ship flow end to end on Cal Hacks.

**Verified on a replayed event, not live:** the Discord reader (each post read once as it lands, crossposts named), the bot against a fake API (3 calls a poll, cursor kept), and alerts end to end (9 replayed posts through the real classifier gave the right texts at the right times, for $0.00 at list price).

**Not verified yet:** the Discord selectors on a real server, the bot against Discord's API, a real Telegram round trip, a real Twilio send. All four are planned for Iterate, Nov 14, with `hr watch` running through the night.

**Decided, not built:** the consent gate as one function every outgoing message passes through, with a test that refuses any recipient but the hacker; quiet hours (1–8 AM Pacific, deadline-critical alerts excepted); the hosted board behind a login; hand-added profile sources.

## Run it

Needs [Bun](https://bun.sh) 1.4, Chrome, and an Anthropic API key for anything that calls a model. Telegram, Twilio and the Discord bot are optional.

```bash
bun install
# .env: ANTHROPIC_API_KEY; optional TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (bun run hr telegram-chat-id),
#       TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, HACKRECON_SMS_TO, HACKRECON_CHANNEL=sms,
#       DISCORD_BOT_TOKEN
bun test                    # what CI runs, with tsc and the extension build
bun run build:ext           # then chrome://extensions → Load unpacked → extension/
```

A new event:

```bash
# Open the event's Slack in Chrome, then Sync in the extension's popup
bun run hr sync-ingest      # bring the newest sync or pull into events/<slug>/captures/
bun run hr sync             # fetch the event's public pages, draft the config (hr discover); no model
bun run hr canon --judge    # read the pages into canon (estimated first, refused over $1)
bun run hr classify --new   # classify only posts never classified
bun run hr board            # http://127.0.0.1, Plan, Ship, Credits, Sessions, People
bun run hr watch            # during the event: read, classify, alert, answer in Telegram
```

`bun run hr` with no command prints every command and its flags. The ones above, plus `compare` / `compare-api` (capture checks against an export), `gate`, `label`, `prelabel` (the classifier eval), `fit-eval` and `prefill-eval` (the Plan evals), `plan` and `ship` (the board's views in the terminal), `discord-ingest`, `alerts` and `ask`.

## Layout

```
extension/            Chrome MV3: Slack DOM capture, the read-only API pull (slackapi.ts, apipull.ts),
                      Discord tab reader (discord-dom.ts), page snapshots, popup
pipeline/             the hr CLI (hr.ts) and everything behind it:
  canon.ts            pages → verified entities; coverage.ts, the prize-total and block checks
  classify.ts         posts → kinds, cached by input hash; gate.ts, label.ts, prelabel.ts (the eval)
  merge.ts            canon + authorized changes, history kept; roles.ts, reps.ts, people.ts (authority, reps)
  plan.ts, ship.ts    the views; fit.ts (track ranking), gaps.ts, prefill.ts (drafts from a repo)
  alerts.ts           what speaks, when; channels.ts (Telegram, SMS); agent.ts (Donna's answers: one call
                      per question, tools that write only the hacker's own state, posts in as quoted data)
  discordbot.ts       the Donna bot (GET only, 3 routes); discover.ts, autoconfig.ts (zero setup)
  costguard.ts        the spend guard every model client goes through
board/                the board's page and its live and prefill scripts
events/<slug>/config/ per-event config (tracked); captures/, data/, review/ are never tracked
docs/designs/         the v1 and v2 design docs: every decision with its evidence
VISION.md             the direction: what's decided, what's proposed
DESIGN.md             the board's visual language
TODOS.md              open work, with what each item depends on
```

## Limitations

- One event of data. Every measured number is from Cal Hacks 13.0, the event the prompts, rules and selectors were built on. Iterate is the first event none of it was tuned on.
- Discovery reads Slack and Devpost only. An event on Discord and Luma discovers nothing, so Iterate's config is hand-written.
- An old Slack thread (past the 48-hour lookback) that gets a new reply isn't re-read.
- After a browser restart the Slack session is gone until the next Sync from the popup.
- The Discord reader follows Discord's web client as of Nov 2026 and is untested on a real server.
- The classifier's dated precision is below its bar (72.7%), and nothing built on dated items hides that.
- Model inputs are still built with names redacted; dropping that changes every cache key and re-runs the passes.
- Single user. What Donna may hold about other people at an event, if she served more than one hacker, is an open question, and no multi-user version comes before it's answered.
