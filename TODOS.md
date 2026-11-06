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

### organizers.json: user IDs only

**What:** Reduce `config/organizers.json` to Slack user IDs only, with no names, once the DevTools hour confirms the DOM exposes the sender's user ID.

**Why:** It's the one baseline-derived product input (A5). Names in a config file are personal data the tool doesn't need if IDs can be matched.

**Context:** A5 built it once from the export's `users.json` (admins, owners, CAL HACKS tags, director/exec/organizer/logistics titles; 55 accounts) with names and IDs, because the DOM's ID attribute was unconfirmed. If the DOM shows no user ID, keep the display-name fallback and close this item with that reason. Note (v2, D19): override authority uses ids backed by admin/owner status or listed by the user; names never grant authority, so ids matter more in v2.

**Effort:** S
**Priority:** P3
**Depends on:** the day-1 DevTools hour (sender user-ID attribute)

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
