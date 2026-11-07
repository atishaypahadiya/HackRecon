# TODOS

## Extension

### Approach B: live extension

**What:** Turn the one-time capture into a live extension: a side panel, IndexedDB storage, capture on every visit, in-extension classification, a diff against the last run, and daily runs via `chrome.alarms`.

**Why:** The demo replays captured Cal Hacks history. B is what a hacker would use during a live event, with "new since last run" computed for real instead of simulated by the slider.

**Context:** It was deferred in the design doc (`docs/designs/hackrecon-demo-scope.md`, Approach B) because it's 7–10 solo days with no live event to demo on. The `messages` / `items` / `reps` / `runs` schema in `schema.ts` was written to match what B stores in IndexedDB, so B adds scheduling and a diff rather than a rewrite. Keep the no-self-bot rule: read only the DOM the user's open client renders. Start with: the side panel plus IndexedDB writes from the existing capture, then the diff, then `chrome.alarms`. Chrome Web Store listing and CI come after.

**Sync this event:** auto-select sponsor channels from the sidebar by prefix, capture sequentially, incremental since last ts, user-started in a visible tab only.

**v2 overlap (2026-10-28):** v2 builds incremental capture, the 48 h thread lookback and permalink checks (eng review D17, D20). What remains here is the side panel, IndexedDB, capture on every visit and `chrome.alarms`.

**Effort:** L
**Priority:** P2
**Depends on:** the demo, and the MLH follow-up feedback

### Background API pull: the live check (2026-11-07)

Built and verified offline (design doc, Zero setup). First live pull (2026-11-07 13:08): requests carried the session (0-announcements and 2-opportunities saved), then the service worker was stopped in the third channel. Chrome ends a worker after 30 s with no extension API call, and fetch does not count; fixed with a call before every Slack request and in every wait, and a 2-minute heartbeat lock. Resumed pull (13:23–13:41, 18 min 13 s, 387 calls, 0 retries, 0 channel errors, 56 channels): `hr compare-api` gives 54/54 channels, posts 1177/1177, replies 585/585, the locked 25 494/494; the 30 posts and 7 replies only in the pull are all newer than the export. Every pull now also writes `~/Downloads/hackrecon/pull-status.json`, so one that finds nothing new leaves a record. Session hand-off (0.4.0): a Slack tab of a workspace the user synced once hands its session to the worker on load (injected into open tabs after an install or reload), so pulls resume with no click. Verified live: the user clicked Sync at 13:51, reloaded the extension at about 14:05 (which clears the in-memory session) and did not click again; the 14:21:45 timer pull ran with a session (256 s, 72 calls, 0 retries, 0 errors). `handoff-status.json` (aefc221) gets confirmed on the next reload. Incremental pull from the popup (13:47, 4 min 15 s): 72 calls, 0 retries, 0 channel errors, 2 posts read again inside the 48-hour lookback (spons-cartesia, spons-fetch-ai), no new rows against the earlier pulls; compare-api still 54/54 and 494/494. Open: one live pull on Cal Hacks, then `hr sync-ingest` and `hr compare-api`, which should report 54/54 channels and 494/494 locked replies. That run also confirms the service worker's requests carry the session cookie. An old thread (past the 48 h lookback) that gets a new reply isn't re-read (D17). After a browser restart the session is gone until the next Sync from the popup; the popup shows the last pull's status.

### main can't require CI yet (2026-11-07)

`.github/workflows/ci.yml` runs on every PR and push to main (first run, PR #3: 438 pass, 17 skip, 0 fail, 15 s), but GitHub refuses both branch protection and rulesets on a private repo without GitHub Pro (HTTP 403). Until the plan changes, merge only on a green `check`. With Pro: require the `check` status context on main, admins included.

### Quiet pulls: ask Slack which channels moved (user 2026-11-07, after the v2 → main PR)

An incremental pull now reads every channel's history: the quiet pull at 13:47 took 72 calls and 4 min 15 s to find 2 posts it already had. Instead, ask Slack once which channels have activity newer than our cursor, using the call the web client makes for its unread counts (it returns each channel's latest ts), then read history and replies only for those channels.

- Find the method in the web client's own traffic first; don't assume its name.
- Add it to `READ_METHODS` only after confirming it marks nothing read: call it, then check that the channel's read position (`last_read`) and its unread badge in Slack haven't changed. Record the check here.
- The allowlist test grows by exactly that one method, and the source scan still refuses everything that writes or marks read.
- Fall back to the full per-channel walk if the call fails or a channel is missing from its answer.
- Target: a quiet pull in under 15 s and under 5 calls. Measure it live against the 13:47 baseline (72 calls, 255 s).

### Zero setup leftovers (2026-11-07)

`hr discover` can't derive: hacking start and end, event-level prizes, sponsor aliases, event channels with no prefix (Cal Hacks' 2-opportunities), schedule end times. Admin and owner flags come from the export until the API pull reads `users.list`. Name tags and titles are only proposed (self-asserted). The extension doesn't record the workspace's display name; the subdomain searched well on Devpost.

### Capture is frozen for Cal Hacks (user 2026-11-07)

No more Syncs for Cal Hacks; the export fills gaps. Open from the last sync, for the next live event: the loading-placeholder wait (built, unverified in Slack; 59 Cal Hacks replies were read as placeholders). The no-action-URL rule (`pipeline/urlsafety.ts`) guards the fetcher and the extension's page capture.

### Sync this event: follow-ups from the first build (user, 2026-11-06)

`extension/src/sync.ts` is the one-time fixture run. Before syncs become something a hacker runs during an event:

1. **No long visible-window requirement for live syncs.** Today the Slack window has to stay visible for the whole run, about an hour [estimated] for 53 channels and 229 threads, because Chrome throttles timers in hidden tabs (intensive throttling after 5 min). Live syncs must finish in minutes or keep working in the background. Incremental capture and D17's 60-thread budget make the run shorter. They don't remove the visibility need.
2. **Replace downloads as the transport (Approach B).** Every file goes through `chrome.downloads` into `~/Downloads/hackrecon/sync/<stamp>/`. That's ~170 files in Chrome's download list, split into parts under the 2 MB `data:` URL limit, then moved in by `hr sync-ingest`. Approach B's IndexedDB storage (above) or a native-messaging or localhost hand-off to `hr` should replace it.
3. **Sync marks every channel and thread it opens as read, which destroys the user's unread state.** Find a way to read without marking, or warn on the button before the first sync. Neither is verified. Options to test: whether Slack keeps the unread marker when a channel is opened and left quickly, whether "Mark unread" can restore it per channel, or reading from somewhere that doesn't mark. Any restore must stay within the no-self-bot rule: no Slack API calls, only clicks the user could make. Until then the warning is the minimum: the button says it will mark the event's channels read.

**Effort:** M (1 and 3 need live Slack to verify), L for 2 with Approach B
**Priority:** P1 before any live-event sync; 3 before anyone else runs Sync
**Depends on:** the first Sync run's results

### Thread capture for credit-heavy channels → now v2 step 1

**What:** Capture thread replies in the locked 25. Open each thread pane and record its replies, using the same `ts` key, the parent-message stop and the 5 × 1.5 s fallback.

**Why:** The summary (the receipt before D22) is top-level only (D4). If the day-1 stretch misses, the footnote states "N of M credit mentions were thread replies, not included". This item closes that gap.

**Status (2026-10-28):** moved into v2 (`docs/designs/hackrecon-v2.md`, build step 1, eng review D5, D17): built and run uncapped on the locked 25 before anything else in v2. Delete this item when step 1's thread recall is recorded.

**Earlier status (2026-10-27):** the day-1 stretch did not land, so this stays. Day 1 captured the locked 25 top-level only. Replies that were also sent to the channel are captured as top-level rows marked `thread_broadcast` (26 in run `day1-2026-10-27`). Other replies are not captured.

**Context:** Delete this item on day 1 if the stretch landed. Priority order comes from the export's credit-signal replies: cohost-anthropic 8, spons-cartesia 6, spons-bitdeer 5, spons-convex 3, spons-factory-ai 2, then single-mention channels. That's 494 replies in the locked 25 overall. Measure thread recall against the export's replies in those channels, then add replies to the receipt with that recall stated.

**Effort:** M
**Priority:** P3
**Depends on:** the day-1 top-level capture being saved

### Capture the 29 stretch channels → now v2 step −1

**What:** Capture the 29 sponsor channels flagged `"stretch": true` in `config/sponsors.json`. They're top-level only, under the same key, stop and keyed-recall rules as the locked 25.

**Why:** D11 locked 25 channels and made the other 29 a day-1 stretch. They hold 10 more credit-signal posts and the reps for those sponsors (e.g. Atlassian, Elastic, SpaceXsi, Llama Ventures), which the Reps tab otherwise lists as not captured.

**Status (2026-10-28):** moved into v2 as build step −1 (eng review D5): captured with the v1 extension before any v2 code. Still not captured.

**Earlier status (2026-10-27):** not captured yet. The locked 25 passed the day-1 exit check (run `day1-2026-10-27`). Keep this item until the 29 are captured and recorded with `hr record-run`.

**Context:** Delete this item on day 1 if the stretch landed. Stretch channels never count toward the capture-failure threshold. The receipt's "of N attempted" comes from the runs record, so it updates on its own. Access to the workspace may be revoked at any time, so do this before anything else post-demo.

**Effort:** S
**Priority:** P2
**Depends on:** the locked 25 captured and saved

## Pages

### ~~`hr init`~~ Superseded in v2

Discovery drafts sponsors.json, organizers and the canon pages after one sync (user, 2026-11-06). See docs/designs/hackrecon-v2.md §5.

### ~~`hr fetch`~~ Done in v2

Folded into `hr sync` (D11 reversed by the user, 2026-11-06): public pages are fetched on every sync. See docs/designs/hackrecon-v2.md §1 Sources.

## Reps

### ~~organizers.json: user IDs only~~ Done 2026-11-06

The DOM exposes the sender's user ID (`data-message-sender`): 1004 of 1006 human posts in the Oct 27 captures carry one, and 1186 of 1186 in the Nov 6 sync. `organizers.json` is now `{id, why}` only. Reps and organizers are keyed by ID (`rolesById` in `pipeline/roles.ts`), because display names change mid-event: "LenaRose (Annapurna Labs)" became "LenaRose" between captures. A post with no ID gets no role.

Two accounts of one person are linked by `hr person-links` (user 2026-11-07; design doc §Step 1 notes). Each link needs the same email, the same avatar image, or the same real name + title + company, never a name alone.

### ~~Reps the role signals miss (Apify)~~ Done 2026-11-07

`hr rep-signals` (`pipeline/reps.ts`) adds three signals: an email on the sponsor's domain, an organizer mentioning the user ID beside the sponsor's name, and likely staff (a staff post, an answer to a hacker, never in a hacker-only channel). Likely staff is shown with its evidence and never gets a role. Apify's rep is Pat Hale (likely staff). Design doc §Step 1 notes.

### ~~Hacker-only channels at a live event~~ Changed 2026-11-07

Captured normally, with text (user 2026-11-07). The authors-only files from the 2026-11-07 sync still feed `hr rep-signals`.

### Model inputs still redact names

**What:** Quotes no longer redact names (user 2026-11-07), but the classifier, grouping and prelabel inputs are still built redacted (`inputs.ts`, `redact.ts`). Dropping that changes every cache key, so classify, group and the judge re-run [cost not measured; state it before running].

**Effort:** S
**Priority:** P3
**Depends on:** the demo

### Sponsor email domains

**What:** Fill sponsors.json `domains` so reps.ts signal 1 can fire where a workspace shows emails. None are listed. At Cal Hacks it's moot: 1 of 2,900 accounts shows an email. Left dormant (user 2026-11-07).

**Effort:** S
**Priority:** P4
**Depends on:** a workspace that shows emails

### Same-person links without the export

**What:** Build `config/person_links.json` from what a sync can see, not the baseline's users.json: the avatar `img` each message row already renders, hashed as `hr person-links` does.

**Why:** A live event has no export. Today the links come from the Cal Hacks users.json snapshot, which a hacker won't have.

**Context:** Of the three rules, only the avatar one fires in this workspace: 1 of 2,900 accounts shows an email, and there's no company field. The row's avatar is already in the DOM, so this needs no extra request and no profile card (both ruled out). The hash and threshold are `pipeline/people.ts`'s.

**Effort:** S
**Priority:** P2
**Depends on:** Approach B (live syncs)

## Plan

### ~~Prefill the Plan input from a project link~~ Moved into v2 step 4 (P1b)

Now task P1b in docs/designs/hackrecon-v2.md, ahead of P2–P6 (user 2026-11-06).

### ~~Read your own Devpost draft's selected prizes (Ship prefill)~~ Dropped 2026-11-07

The user ticks tracks in Ship (user 2026-11-07). The visit was removed.

### Gap check: find counter-evidence for requirements that name no product

**What:** Pick repo lines for the gap check by what each requirement asks, not only by the track's product names. Today `repoFacts` (pipeline/repo.ts) keeps only lines naming a likely track's product (Apify, Claude, Factory …), so a requirement that names none, such as voice, deployment or open source, gets no repo lines and can't find counter-evidence.

**Why:** A gap needs a project fact that differs from the requirement. With no relevant repo lines in front of the model, the check reports "none found" for those requirements even when the code clearly does something else (no audio code for a voice track, no deploy config for "deployed", no license file for "open source").

**Context:** Found on Hindsight (2026-11-06): the one gap it found was on a requirement naming Apify, and 115 repo lines were all about the likely tracks' products. Directions to weigh:
- Code-level signals per requirement kind: a LICENSE file, deploy config (Dockerfile, render.yaml, vercel.json), audio/speech dependencies in package.json or pyproject.
- Requirement keywords as extra search terms.
- A bounded repo summary (file tree plus dependency lists) as facts.

Each fact still needs its path:line, and "the repo has no LICENSE file" is a fact about absence, so it needs its own wording rule before it can back a gap.

**Effort:** M
**Priority:** P2
**Depends on:** Plan gaps (built)

### Hand-read the fit pairs the drafted stack lost

**What:** Read, by hand, the won pairs that run B (Built With) had in its top 5 and runs C and C+ (repo-drafted stack) missed, in `events/calhacks-13/review/prefill_eval.json`. For each, write the cause. Look for causes other than the stack, such as a description that names the sponsor, ranking variance between two runs on near-identical input, a track that is title-only, or a Built With tag that names the prize. No model run.

**Why:** P1b closed (user 2026-11-06) with C+ − B at −2.5 points @5 (95% CI −9.5 to +4.7) on 81 pairs. The interval can't say whether the drafted stack costs anything. Reading the 5 lost and 3 gained pairs is the cheapest way to tell a stack gap from noise.

**Context:** Each pair's key is `slug|prize`. Built With tags, drafts and added sponsor products are in the same file (`scores`, `added`). B's hits are in `review/fit_baseline.json` `pair_hits`. The fit rankings themselves are in `data/fit_cache.json`, keyed by fitHash of the request.

**Effort:** S
**Priority:** P3
**Depends on:** nothing

## Product

### Rerun /office-hours in startup mode after the MLH reply

**What:** Run `/office-hours` in startup mode once MLH responds to the demo, to decide whether HackRecon becomes an MLH-distributed tool or stays personal.

**Why:** This plan was scoped as a personal-first hackathon demo. The MLH reply is the first real demand signal, and it changes the problem framing (users, distribution, consent at scale).

**Context:** Bring the MLH reply, the Cal Hacks organizers' answer on demo anonymization (D18), and the demo's measured numbers (capture recall, gate results, receipt basis). The Approach B TODO above depends on this conversation.

**Effort:** S
**Priority:** P2
**Depends on:** the MLH reply

### Money clock (cut from the demo board, D22)

**What:** Bring back the money clock on the replay board. It showed the open per-person credit value at each frame D: the sum of the amount at D over distinct credit groups that are priced at D, where either the deadline status at D is `resolved` and that deadline is after D, or the status is `none`. Offers with status `unresolved` are never counted. It rises when credits are posted and drops when deadlines pass. The rule is the one removed from the design doc's Replay semantics, unchanged.

**Why:** It was the demo's original hook (the Missed-It Receipt). It was cut after day 2 because only 4 of 38 credit offers stated a per-person amount ($270, possibly $220 after one merge), so the clock would barely move. The board leads with signal-in-noise instead.

**Context:** Reconsider it when an event has enough priced, time-limited credits to make the line move, e.g. after the stretch 29 or thread capture adds priced offers, or for a live event under Approach B. It needs the offer aggregation in `offers.ts` (amount at D, deadline at D), which the board builds anyway.

**Effort:** S
**Priority:** P3
**Depends on:** offers.ts (T7); enough priced offers to be worth showing

## Completed
