# TODOS

## Extension

### Approach B: live extension

**What:** Turn the one-time capture into a live extension: a side panel, IndexedDB storage, capture on every visit, in-extension classification, a diff against the last run, and daily runs via `chrome.alarms`.

**Why:** The demo replays captured Cal Hacks history. B is what a hacker would use during a live event, with "new since last run" computed for real instead of simulated by the slider.

**Context:** It was deferred in the design doc (`docs/designs/hackrecon-demo-scope.md`, Approach B) because it's 7–10 solo days with no live event to demo on. The `messages` / `items` / `reps` / `runs` schema in `schema.ts` was written to match what B stores in IndexedDB, so B adds scheduling and a diff rather than a rewrite. Keep the no-self-bot rule: read only the DOM the user's open client renders. Start with: the side panel plus IndexedDB writes from the existing capture, then the diff, then `chrome.alarms`. Chrome Web Store listing and CI come after.

**Effort:** L
**Priority:** P2
**Depends on:** the demo, and the MLH follow-up feedback

### Thread capture for credit-heavy channels (only if the day-1 stretch didn't land)

**What:** Capture thread replies in the locked 25. Open each thread pane and record its replies, using the same `ts` key, the parent-message stop and the 5 × 1.5 s fallback.

**Why:** The receipt is top-level only (D4). If the day-1 stretch misses, the footnote states "N of M credit mentions were thread replies, not included". This item closes that gap.

**Context:** Delete this item on day 1 if the stretch landed. Priority order comes from the export's credit-signal replies: cohost-anthropic 8, spons-cartesia 6, spons-bitdeer 5, spons-convex 3, spons-factory-ai 2, then single-mention channels. That's 494 replies in the locked 25 overall. Measure thread recall against the export's replies in those channels, then add replies to the receipt with that recall stated.

**Effort:** M
**Priority:** P3
**Depends on:** the day-1 top-level capture being saved

### Capture the 29 stretch channels (only if the day-1 stretch didn't land)

**What:** Capture the 29 sponsor channels flagged `"stretch": true` in `config/sponsors.json`. They're top-level only, under the same key, stop and keyed-recall rules as the locked 25.

**Why:** D11 locked 25 channels and made the other 29 a day-1 stretch. They hold 10 more credit-signal posts and the reps for those sponsors (e.g. Atlassian, Elastic, SpaceXsi, Llama Ventures), which the Reps tab otherwise lists as not captured.

**Context:** Delete this item on day 1 if the stretch landed. Stretch channels never count toward the capture-failure threshold. The receipt's "of N attempted" comes from the runs record, so it updates on its own. Access to the workspace may be revoked at any time, so do this before anything else post-demo.

**Effort:** S
**Priority:** P2
**Depends on:** the locked 25 captured and saved

## Reps

### organizers.json: user IDs only

**What:** Reduce `config/organizers.json` to Slack user IDs only, with no names, once the DevTools hour confirms the DOM exposes the sender's user ID.

**Why:** It's the one baseline-derived product input (A5). Names in a config file are personal data the tool doesn't need if IDs can be matched.

**Context:** A5 built it once from the export's `users.json` (admins, owners, CAL HACKS tags, director/exec/organizer/logistics titles; 55 accounts) with names and IDs, because the DOM's ID attribute was unconfirmed. If the DOM shows no user ID, keep the display-name fallback and close this item with that reason.

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

## Completed
