# Design: HackRecon v2, the hacker's operating system for a hackathon

Written 2026-10-28 from the user's v2 brief.
Branch: v2. Base: tag `v1` (`6dcefc1`).
Status: REVIEWED by /plan-eng-review 2026-10-28 (decisions D1–D20, see Decision ledger).
Predecessor: `docs/designs/hackrecon-demo-scope.md` (v1, decisions D1–D26). Its constraints carry over unless this doc changes them by name.

## The brief (user, 2026-10-28, verbatim)

> v1 is done (tag it v1). Starting v2: HackRecon becomes the hacker's operating system for a hackathon, with five views: Build (tracks + track stacker), Claim (v1 offers), Now (schedule + live changes), Meet (reps + booths + openers), Ship (submission checklist). Key architecture change: multi-source. Public pages are canon (Devpost: tracks, prizes, judging criteria, submission rules; event site: schedule), Slack is the live layer (changes, credits, reps, fixes). Merge rule: page is canon, Slack updates override with both shown. Also add thread capture to the extension. Per-event config so it runs at the next hackathon. Build order: sources → entities + Opus-judged eval → merge → views (Build, Ship, Now, Meet) → generalize.

## Problem

v1 answers one question: "what can I grab right now?" It does this from Slack alone, replayed over a finished event. A hacker at a live event has four more questions, and Slack is the wrong place to start answering any of them:

- **What should I build, and which prizes can one project enter?** Devpost answers this. Slack only adds clarifications.
- **What's happening now, and what changed?** The event site answers the first part and Slack the second. At Cal Hacks the Devpost deadline moved from 09:00 to 09:30 in a Slack post (`config/event.json`, hand-sourced in v1).
- **Who should I talk to, and where are they?** Slack holds the rep posts and "find us at table 14". v1 found 22 candidates across 15 of 23 sponsors.
- **Am I ready to submit?** Devpost's submission rules plus each chosen track's requirements answer this. It's the most expensive one to get wrong.

v1 also ran off hand-written config (`config/event.json`, `config/sponsors.json`) and off `config/organizers.json`, which was built from a Slack export that won't exist at the next event.

## What changes from v1

| | v1 | v2 |
|---|---|---|
| Sources | Slack top-level posts (and broadcast replies) | Public pages (Devpost, event site) as canon; Slack top-level **and thread replies** as the live layer |
| Unit | Offer (Opus-grouped from credit posts) | Typed entities: Track, Prize, Criterion, Rule, ScheduleItem, Offer, Rep, Booth. Each has sources and a change history |
| Truth | Whatever Slack said | Page is canon. An authorized Slack update overrides a field, and both values are shown |
| Views | One board (Claim) | Build, Claim, Now, Meet, Ship |
| Config | Cal Hacks, hand-written | Per event: `events/<slug>/`, with the next event set up by a command and a short hand check |
| Time | Replay of a finished week | Runs at a live event (capture, `hr sync`, board). Replay stays as a demo mode over a finished one |

## Constraints (carried over, restated where v2 touches them)

- **No self-bots.** The product never sends a request to Slack beyond what the user's open web client makes in response to UI actions in the visible tab. Opening a thread pane is a UI action, so thread capture stays inside the rule if it opens threads the way a user does: one at a time, at a human pace, user-started, in a visible tab. No Slack API calls with the session token.
- **Public pages** are read the same way: the extension snapshots the page the user has open. See "Sources" for the `hr fetch` question.
- **No LinkedIn scraping.** Search URLs only. The user sends every message. Openers are drafts with a `{first_name}` placeholder filled in locally.
- **No invented numbers.** Every number, date and requirement on screen traces to a quoted source span. "Not stated" is a first-class value and is never filled with a guess.
- **No backend, no accounts.** Data stays on disk. Slack text sent to the Anthropic API is redacted as in v1. Page text (D12): a snapshot marked `access: "public"` (opens without logging in) is sent as published; one marked `"authenticated"` (e.g. Hive) is redacted like Slack, with quotes checked against the redacted text. The flag is set in the capture popup, never inferred from the domain, and a missing flag means redacted. The one-sentence project idea typed in Build is sent with track and criterion quotes for idea fit (D6).
- **Local board server** listens on 127.0.0.1 only. Its one POST route (`/fit`, D6) accepts a request only when the Origin header is the board's own origin and the per-run token embedded in the page matches.
- **Demo mode** hides author names only. The evidence (offer text, page quotes) is always shown (D24).
- **Labels:** the labeling and gate tools (`hr label`, `hr gate`) never print classifier answers for rows the user hasn't labeled. The views show model output labeled with its model, as v1's board does ("Grouped by claude-opus-5-5 · not hand-checked").

## Premises

1. **Canon vs live.** A public page is what the organizer committed to in writing before the event. Slack is where it changes. When they disagree, the newest authorized Slack statement wins on that field, and the page value stays visible beside it ("Page: 09:00 · Slack, organizer, Sat 8:12 PM: 09:30"). A false override is then visible and checkable, never silent.
2. **Authority (D8).** Only some posters can override canon. Organizers can override any event entity. A sponsor-side poster can override only their own sponsor's Track, Prize, Offer or Booth. A hacker's post never overrides anything. It can raise a question ("Is the deadline 9 or 9:30?") but can't change a value.
3. **Cal Hacks 13.0 is the development fixture.** It's the only event with captured Slack, v1 labels and a slackdump baseline (thread-reply recall is measured against the export's 494 replies in the locked 25). The generalize step proves the config works for a second event before any claim that "it runs at the next hackathon".
4. **Opus is the judge, Haiku or Sonnet the worker, as in v1 (D21).** Every eval number is "agreement with Opus", labeled that way, never "accuracy". No hand check on canon (D15): model-free coverage checks back the judge instead.

## Architecture

```
            ┌───────────── capture (extension, user-started, visible tab) ─────────────┐
            │  Slack channel (top-level + threads)        Public page snapshot          │
            └──────────────┬──────────────────────────────────────┬────────────────────┘
                           ▼                                       ▼
            events/<slug>/captures/slack/*.json      events/<slug>/captures/pages/*.json
                           │                                       │
                           ▼                                       ▼
            classify (Haiku): kind + entity hints     extract (Opus): canon entities,
            per message, cached by input hash          every field with a quoted span
                           │                                       │
                           ▼                                       ▼
            link (Opus): Slack message → change        verify (code): quotes exist, numbers
            on an entity field, or new entity           inside quotes, enums valid
                           │                                       │
                           └──────────────►  merge (code)  ◄───────┘
                                     canon + authorized overrides, history kept
                                                   │
                                                   ▼
                                  events/<slug>/data/entities.json
                                                   │
                                                   ▼
                       hr board → Build · Claim · Now · Meet · Ship (one local page)
                                   │                       ▲
                                   │ POST /fit (Origin +   │ ranked tracks, each with a
                                   ▼  per-run token, D6)   │ verified quoted requirement
                              fit.ts: idea + track/criterion quotes → Sonnet → verify → cache
```

Page snapshots carry `access: public | authenticated` (D12); authenticated text is redacted before any model call, like Slack.

Each stage is a pure function of its inputs and is cached by input hash, as `hr group` is today. Re-running `hr sync` after a fresh capture only pays for what changed.

### Module layout (eng review D2)

| Module | Owns | Hides |
|---|---|---|
| `pipeline/event.ts` | Every per-event path and config load (`events/<slug>/…`, `--event`) | Path layout; no other module holds a path constant |
| `pipeline/canon.ts` | Page snapshot → verified canon entities | Snapshot parsing, the extraction prompt, quote verification, retries |
| `pipeline/live.ts` | Slack messages → `Change`s and Slack-only entities | Kind hints, the link prompt, quote verification, retries |
| `pipeline/merge.ts` | `merge(canon, changes, roles)`, pure | Authority and conflict rules |
| `pipeline/schema.ts` | Entity, FieldValue, SourceRef, Change, PageSnapshot types | — |
| shared helper (lifted from `group.ts`) | Model call → parse → check → retry with the error | Used by `group.ts`, `canon.ts`, `live.ts`; v1 grouping keeps its tests |
| `pipeline/fit.ts` (D6, D16) | Idea + track/criterion quotes → Sonnet → ranked tracks with a verified quoted requirement each; cached by input hash | Served by `hr board` as POST /fit (Origin + per-run token) |
| `board/views.js` | Build, Now, Meet, Ship render functions | Shares the board shell, fonts, drawer and done state with Claim (`board/index.html`) |

### 1. Sources

**Slack, top-level** works as in v1, plus **incremental capture**. A channel captured before resumes from its newest stored `ts` and stops when it reaches it (new stop reason `caught_up`), then keeps scrolling back over parents from the last 48 h (`thread_lookback_hours`, D20) to read their reply counts and last-reply times. Older parents that are entity sources are checked by opening their permalink (D20). Sync time is measured at step 5.

**Slack, threads (new).** For each captured top-level message with a reply count, open its thread pane by clicking "N replies", the way a user does. Scroll the pane to its end, record the replies with `thread_ts` set, close it, and wait 1.5 s before the next one. Details:
- The keys, the `ts` rule and the 5 × 1.5 s no-new-keys fallback are the same as for channels.
- Order: threads with the most replies first, inside channels in the event's priority order.
- Budget (D17): the one-time fixture capture is uncapped. Live syncs skip threads whose parent row shows the same reply count and "last reply" time as last sync, order changed threads by parent kind (offers, tracks, deadlines, rep posts) then new-reply count, and cap at 60 after that filter; the rest carry over.
- Recall is measured against the export's 494 replies in the locked 25 by `ts`. The target is ≥ 90% (v1's channel bar).
- New selectors go in `selectors.ts` with DOM samples in `fixtures/slack-dom/` (thread pane, reply count, "N more replies", the pane close button).

**Public pages (new; D11 reversed by the user 2026-11-06).** Public pages are fetched automatically, not captured by hand. `hr sync` fetches every page canon and the schedule need on every sync (`pipeline/fetch.ts`): one request per URL per sync, robots.txt read once per host per sync and respected (RFC 9309: our group, else `*`; longest match wins; 4xx means no rules; 5xx or unreachable means nothing is fetched from that host that sync), an honest User-Agent (`HackRecon/2.0 (+https://github.com/atishaypahadiya/hackrecon; a hacker's local tool, one request per page per sync)`), no cookies, at most 3 same-site redirects, each robots-checked. A fetched snapshot is `captured_by: "fetch"`, `access: "public"`. A page that answers with a login (401/403, a redirect to a login path, a password form with little text) or has no text without JavaScript is reported "needs the extension" with its URL. Probed 2026-11-06: Devpost's robots.txt (devpost.com and the event subdomain) allows `*` everywhere; its hackathon search (`devpost.com/api/hackathons?search=`) returns Cal Hacks 13.0 for "Cal Hacks 13.0"; Hive has no robots.txt (404, so no rules) and is a JavaScript app.

**The extension reads only pages that need the user's login** (or a browser to render). Its **Capture this page** works on any http(s) tab and snapshots the rendered page:
- the URL, the title and `captured_at`;
- a heading-structured outline (h1–h6 with their text blocks and block order; Devpost puts prize titles in h5/h6, measured 2026-10-28: 11 h5, 48 h6), which D7's anchors need;
- tables as rows;
- every link with its label;
- (no edit time: a content script can't read response headers, and `document.lastModified` is the load time on dynamic pages, so edit times come only from snapshot windows, D13).

That covers JS-rendered and login-gated pages (e.g. an event's live site) with the same "read what the user's browser shows" rule. Each snapshot is hashed over its normalized outline text (counters, participant counts and relative times like "3 days left" stripped). A recapture with the same hash is a no-op. A changed hash triggers re-extraction, and only a changed extracted field is a canon change shown in Now (the organizer edited the page). Devpost multi-page events (overview, rules, prizes, resources) are captured page by page. The event config lists which URLs make up canon (`canon_pages`, and `schedule_pages` for the schedule, D3), so a missing one is reported. With no schedule page listed, every schedule item is Slack-only and labeled "from Slack".

~~Resolved (D11): extension-only.~~ Reversed by the user, 2026-11-06 (verbatim): "Reverse D11: public pages are fetched automatically, not captured by hand." The `hr fetch` TODO is folded into `hr sync` above.

**Discovery (user, 2026-11-06; part of v2, not a TODO).** Goal, verbatim: "the user opens Slack and clicks 'Sync this event' once; HackRecon finds everything else." `pipeline/discover.ts`, run by `hr sync` after every Slack capture:
1. **Event URLs.** The Devpost root is the `*.devpost.com` subdomain linked most in top-level posts of the announcement channels; other Devpost events linked there (last year's) are listed, never canon. `canon_pages` = the root and `/rules`. Schedule candidates are links whose sentence calls them a schedule, agenda, timeline, live site or hacker guide, or whose path says so. No Devpost link: Devpost's search by the event name, taking only an exact (normalized) title match. Config the user wrote (`canon_pages`, `schedule_pages`) wins over discovery, and a disagreement is printed.
2. **Fetch** every public page on every sync, as above; canon re-runs only for pages whose snapshot hash changed.
3. **sponsors.json** is drafted from Devpost prize tags (`[Apify] Best Use of Apify`, the track `sponsor` in canon) matched to the channel sidebar by name words (`spons-crs-credit-api` → CRS, `spons-bitdeer` → Bitdeer AI); a channel prefix gives the kind (`spons-`/`sponsor-`/`partner-` → sponsor, `cohost-`/`host-` → cohost); announcement channels are `event`. Unmatched tags and channels are listed. The draft is written only when no sponsors.json exists; otherwise it is compared channel by channel and the agreement printed.
4. **Organizers** are the top-level posters in restricted-posting channels (D19's signal people can't set themselves). Written to `config/organizers.json` only when none exists and the flag came from Slack; otherwise new posters are listed in `data/discovered.json`, never applied.
- **Trust and reach (security review, 2026-11-06).** A channel's name proves nothing, since hackers can often create channels. Under the name fallback only posts by organizer ids already listed count, and with no list, Slack links are printed and never fetched or made canon. The Devpost search fallback (exact title) is still used. Every fetch hop must be http(s), carry no credentials, use no IP-literal or local host, and resolve only to public addresses (no loopback, RFC 1918, link-local/metadata, CGNAT, ULA or multicast). Redirects stay on the host or move between it and its own subdomains.
- **Announcement channels** come from Slack's restricted-posting notice, recorded per capture as `posting_restricted` (true / false / null when no composer region is found). The selector is UNVERIFIED until a DOM sample of a restricted channel is saved in `fixtures/slack-dom/`. Until then `authority_channels` in event.json, else channel names containing "announce", stand in, and the run says which source it used.
- **Measured on Cal Hacks (offline, from the 25 v1 captures, 2026-11-06):** announcement channels from the name fallback (no capture has the flag yet): `0-announcements`. Devpost found: `https://cal-hacks-13-0.devpost.com/` (2 announcement posts). Schedule candidate: `https://hive.hackberkeley.org/` (linked as "live site"). Organizers: 29 distinct top-level posters in #0-announcements, all 29 already in the 55-id organizers.json. Sponsors: the draft agrees with the hand-written sponsors.json on 24 of 25 channels (sponsor and kind); the miss is `2-opportunities` (an event channel without "announce" in its name). Devpost sponsors with no channel: Atlassian, Coinbase, Elastic, MLH, Meta, SpaceXSI, Visa (7). Sponsor channels with no Devpost prize: cohost-annapurna-labs, spons-runpod, spons-supercell, spons-wajo-ai (4).
- **First live syncs (2026-11-06):** sync 1 fetched the overview and rules with HTTP 200, and both hash exactly as the step-2 snapshots (3489bbc282097465, d1b749c62bba3c95), so canon is unchanged. Each sync made 5 HTTP requests (3 pages + 2 robots.txt). Hive is a JavaScript shell ("Loading the hacking schedule…"), so it is reported as needing the extension and not saved. Sync 2, two minutes later, got HTTP 403 from Devpost's Cloudflare on the overview, while a curl right after got 200. So 403/429 counts as "refused": no retry inside the sync, the last snapshot stands, and the next sync tries again. Only 401 or a login redirect means "needs the extension". Across 4 syncs that day, the Devpost overview came back 200 in 1 and 403 in 3; the rules page came back 200 in 3. One of the 403 syncs used a node:https client that pinned the checked address: Cloudflare answered it with `cf-mitigated: challenge`, while Bun's fetch with the same headers got 200, so the fetcher stays on fetch (fetch.ts names the leftover DNS-rebinding window and what bounds it). The user then asked for undici with a pinning DNS lookup, provided the dispatcher works under Bun. It doesn't: under Bun 1.4.4, undici 8.12.4's `Agent({ connect: { lookup } })` was never called, and `localtest.me` was dialed on loopback (ECONNREFUSED) instead of refused. undici was removed again and no workaround was built, per the user's instruction to report first. The pre-request check still refuses such names. What this means for the D11 reversal: automatic fetch can't be the only path to the overview. When a canon page is refused, the run names it, the board shows when its snapshot was taken, and the extension's Capture this page (still `access: public`) is the fallback. Open: how often that happens at a live event, measured as the share of syncs refused per page.
- **Devpost through the extension, automatic (user, 2026-11-06):** "Devpost via the extension must be automatic inside 'Sync this event' (background tab, no user click), since Cloudflare refuses about 60% of plain fetches." After an announcement channel's capture, the content script sends the event's Devpost root and `/rules` to the service worker (`extension/src/background.ts`). The manifest limits this to `https://*.devpost.com/*`, and the worker checks every URL again before opening it: https, one label under devpost.com, not Devpost's own subdomains. After redirects the tab must still be on such a host. Schedule sites linked in posts are never opened automatically with the user's cookies (security review 2026-11-06). The blanket optional host permission was dropped. Each page opens in a background tab that is never focused, one at a time. The worker waits until the text settles (same length on two polls, at least 200 characters, at most 25 s). If a bot check is still showing at the end, it gives up and never interacts with it. The page is saved to `~/Downloads/hackrecon/pages/` and the tab closed. `hr sync` ingests those files (`pipeline/ingest.ts`). Access, per D12, is never inferred from the domain. An automatic capture is always "authenticated" and redacted. The tab carries the user's cookies, so any part of it (text, links, title) could be a logged-in view (security review 2026-11-06; an earlier hash-match rule didn't cover links or title). Public text still arrives unredacted through hr sync's cookie-less fetch whenever Cloudflare lets it through. A capture older than, or identical to, the current snapshot doesn't replace it. Tested with unit tests and an offline ingest of a copied snapshot. The Chrome side (settle timing, the Cloudflare wait) is UNVERIFIED until step 5's Slack session.
- **"Sync this event"** (extension) replaces the per-channel button: one click captures the event's channels (sidebar order, sponsor and announcement channels first), their threads under D17's budget, the sidebar's channel list and each channel's posting flag, and downloads one bundle that `hr sync` ingests. It drives the Slack tab the way the user would (open a channel, scroll, open "N replies"); it never posts, reacts or messages (no self-bots). It needs Slack access to build and verify, so it lands with thread capture in step 5; `hr sync` runs today on per-channel captures.

### 2. Entities

```ts
type EntityKind = "track" | "prize" | "criterion" | "rule" | "schedule_item" | "offer" | "rep" | "booth";

interface SourceRef {
  kind: "page" | "slack";
  url: string;                 // page URL or Slack permalink
  quote: string;               // verbatim span the value came from (verified to exist in the source)
  captured_at: string;         // ISO, when we captured it
  posted_at?: string;          // slack only: the post's own time (from ts); merge orders Slack changes by this (D13)
  author_role?: PosterRole;    // slack only: v1's "organizer" | "sponsor-side" | "other" ("other" = hackers and unknown posters), plus "bot"
  snapshot_hash?: string;      // page only
}

interface FieldValue<T> {
  value: T | null;             // null = not stated (never guessed)
  source: SourceRef;
}

interface Entity {
  id: string;                  // D7: page entity = kind + canonical URL + heading path of its quote; Slack-origin = kind + first post's permalink.
                               // Re-extraction keeps an id when its quote matches after normalizing whitespace, case and punctuation, above a similarity
                               // threshold. Below it, or with two candidates, the mark is listed as "no longer on the page"; never attached to the wrong entity.
  kind: EntityKind;
  sponsor: string | "event";
  name: FieldValue<string>;
  fields: Record<string, FieldValue<unknown>>;   // kind-specific, below
  history: AppliedChange[];    // every override and page edit, oldest first, computed by merge
  origin: "page" | "slack";    // where the entity was first stated
}

interface Change {             // emitted by canon.ts (page diffs) and live.ts (Slack); never carries merge results
  entity_id: string;           // which entity it touches (D7 id)
  field: string;
  to: FieldValue<unknown>;     // the proposed value, with its source (posted_at for Slack, snapshot window for pages)
  kind: "set" | "question";
}
interface AppliedChange extends Change {   // computed by merge.ts only
  from: FieldValue<unknown>;   // the value it replaced, computed in timeline order (D13)
  status: "applied" | "unauthorized" | "question" | "ambiguous";   // set by merge from roles (D8) and windows (D13)
}
```

Kind-specific fields. Each one is a `FieldValue`, so it's quoted or explicitly null.

| Kind | Fields | Canon source | Live source |
|---|---|---|---|
| track | description, requirements[] (e.g. "must use the Claude API"), eligible_with (stacking rule text), max_entries | Devpost | Slack clarifications by organizers or that sponsor |
| prize | track_id, place, award_text, amount_usd (only if stated), per (team or person) | Devpost | Slack (rare) |
| criterion | name, weight (if stated), description | Devpost | Slack |
| rule | text, applies_to (all or track_id), kind (submission, eligibility, conduct), deadline | Devpost rules page | Slack (deadline moves, "demo video optional now") |
| schedule_item | what, start, end, place | Pages listed in event.json `schedule_pages` (e.g. a live site such as Hive); none listed → Slack-only, labeled "from Slack" (D3) | Slack (time and room changes) |
| offer | v1 Offer fields (value_short, claim_short, limit, code, claim_url, usd) | Devpost resources (rare) | Slack (the main source, as in v1) |
| rep | sponsor, role_hint, first_post (permalink), candidate_first | none | Slack (v1 rule A5) |
| booth | sponsor, place_text, hours | Event site map (if any) | Slack ("we're at table 14") |

Extraction:
- **Pages → entities:** one Opus call per page snapshot with a JSON schema. Code then **verifies** every field (v1's `checkGroups` pattern):
  - the `quote` exists verbatim in the snapshot text;
  - every number and date in `value` appears in the `quote`;
  - enum fields are valid;
  - nothing references an id that doesn't exist.
  - A failed check goes back to the model with the error, up to 2 retries, as in `groupOffers`.
- **Slack → candidates:** the Haiku classifier grows from the v1 item kinds to "which entity kinds does this message touch". It's cached by input hash. Its prompt carries entity kinds only, so a page edit doesn't invalidate the cache for every message; naming the entity a message is about happens in the link pass, cached per message and the candidate entities' ids and values.
- **Slack → changes:** the **link** pass (Opus, batched per channel and day) turns candidate messages into one of four outcomes:
  - `Change`s on existing entities;
  - new `offer`, `rep` or `booth` entities;
  - questions;
  - nothing.

  It runs under the same quote verification.
- **Offers** keep v1's grouping pass (`hr group`) and `withLabelAmounts`, moved behind the entity interface. Claim must not regress.

### 3. Merge

`merge(canon: Entity[], changes: Change[], roles): Entity[]` is pure code with no model in it:

1. Start from page canon: a page's first snapshot is the baseline.
2. A later snapshot that changes a field is a page `Change`, placed in its window (previous snapshot's `captured_at`, this snapshot's `captured_at`], because the edit time is unknown (D13).
3. Authorized Slack changes (D8) are placed at their `ts`. An unauthorized one is kept with `status: "unauthorized"` in history, never as the value.
4. One timeline: the latest change wins. A Slack change whose ts falls inside a page change's window is ambiguous: both values are shown with "Page and Slack disagree; page changed between <t1> and <t2>", and no winner is picked (D13).
5. The baseline page value is always kept and displayed beside the shown value. A Slack change that a later snapshot repeats exactly collapses into the page (no double display).
6. Slack-only entities (offers, reps, booths, and tracks announced only in Slack) have `origin: "slack"` and are labeled "from Slack" in every view.

**Override authority (D19)** trusts only signals a poster can't set themselves:
- organizer: an id in `organizers.json` backed by workspace admin/owner status (from the export), or an id the user lists; or any post in an `authority_channels` channel;
- `authority_channels` at a new event: channels where Slack restricts posting ("only certain members can post") are proposed automatically by the capture, and the user confirms the list once in config;
- sponsor-side (own sponsor's Track, Prize, Offer or Booth only): Slack's external-org badge, or an id the user lists for that sponsor;
- a display-name tag (e.g. `[CAL HACKS]`), profile title or sponsor name alone never grants authority: the post shows as "unverified poster" in the entity's history, and the run report lists every such poster so the user can add real organizers.

v1's name/title patterns stay as classifier hints only. Anything unresolved is `other`, so it can't override. That's the safe default.

### 4. Views

One local page per event with five tabs: **Plan** (the default), Claim, Now, Meet, Ship. DESIGN.md applies throughout: daylight glass, the de-slop test, mono metadata, ink actions. Every value shows its source on demand. Every overridden value shows both. Done and selection state is per viewer in browser storage, as v1's done state is.

- **Plan (new, the default tab; user, 2026-11-06).** The user types their project in one line and their stack (the stack field is asked for because the D16 rule fired: B − A = 21.3 points). HackRecon returns a personal game plan in five sections. Every item carries a project-specific reason and a source link:
  1. **Tracks to target:** idea fit (below) with each track's stated entry steps. Replaces a standalone Build tab; the track list with prizes, requirements and criteria stays reachable from each item.
  2. **Credits to claim:** Claim's offers matched to the stack and the targeted tracks.
  3. **Sessions to attend,** in time order: workshops and talks from the schedule that bear on the stack or a targeted track.
  4. **Booths and reps to visit,** each with a grounded question to ask, drawn from an ambiguous requirement, a judging criterion, or an unmet entry step.
  5. **People to pitch:** reps of targeted tracks, each with a one-line pitch that uses only facts from the user's description and the rep's own posts.
  - **Stack input (user 2026-11-06).**
    - **Fields:** one row per stack item, a name field plus one optional short field, placeholder "what it does in your project". Data: `StackItem { name, used_for }` in plan.ts. The CLI form is `--stack "Apify: pull course catalogs, Claude API: the Ask assistant, Vercel"`, split at the first ": " so "ASI:One" stays a name.
    - **What reads it:**
      - The ranker sees "Apify (used for: …)" only when given, so the fit reason can state it. A plain stack renders byte-identical to a names-only list, so the eval's Built With requests keep their cache keys (re-checked from cache: 162 rankings, 0 uncached, 0 pairs moved).
      - Booths' opening uses the first that applies:
        - (1) the item's used_for: "We use Apify to pull course catalogs from university sites; …", "We use Claude API for the Ask assistant; …";
        - (2) the description's own "to/for …" clause;
        - (3) a stack entry that already says its use, "<thing> <past participle> in|with|on <product>": "We designed the UI in Figma; what does ‘Best Design’ reward beyond that?";
        - (4) "We use <product> for <the description's first sentence>".
    - **Built in P1 (2026-11-06):** the board's Plan input has these fields; see Step 4 progress.
  - **Layout (design review D2, user 2026-11-06).** Once filled, the project input collapses to one line (description · stack, then Edit). Under it, a single **"Next for you"** line, not a tile: the next time-bound item from the plan (a session, booth hours, a claim window or a deadline), e.g. "Sat 2:00 · Apify workshop, Gate 4 · in 40 min". It's hidden before the event starts and when nothing is upcoming. Then on desktop, Tracks 8 col | Credits 4 col, and Sessions | Booths and reps | People, 4 col each. Tablet: Tracks 12; Credits 12; the band 12 (three columns). Phone order: input, Next for you, Tracks, the band (Sessions, Booths, People), Credits. Tracks lead because the other four sections are matched to the targeted tracks.
    ```
    [ Hindsight: transfer planner…  ·  Vercel, FastAPI, Claude API…        Edit ]
    Sat 2:00 · Apify workshop, Gate 4 · in 40 min
    +--------------------------------------+ +------------------+
    | Tracks to target                     | | Credits to claim |
    +--------------------------------------+ +------------------+
    +------------------+ +------------------+ +------------------+
    | Sessions         | | Booths and reps  | | People to pitch  |
    +------------------+ +------------------+ +------------------+
    ```
  - **Containers (D7, user 2026-11-06; a Plan exception to DESIGN.md's tile rule).** Only Tracks and Credits are tiles, and on Plan a tile is a container, not a button: each row is the button and opens its own drawer, so no control sits inside another. Sessions, Booths and reps, and People are plain sections (a heading plus rows, no card border or card background), so Plan reads as two anchored blocks plus a list, not five stacked cards. **D8 (user):** the three plain sections sit side by side in one borderless band under the two tiles: 90% white, no border, 16px radius, 20px padding, column gaps and no dividers. It reads as one list, and every word stays on a measured surface (the field never carries text). On phone the band's sections stack in plan order (Sessions, Booths, People), each with its heading, still one band. Phone is <600px, DESIGN.md's single breakpoint set (D10).
  - **Tabs on phone (D10, user 2026-11-06).** First, fit all five at <600px by cutting the tabs' horizontal padding to about 10px, keeping the 44px tap height. Estimated about 270px at 15/600 against 328px available at 360px; not measured, so /design-review checks it at 360 and 390. Only if they still overflow at 360px (the smallest common Android width) does the bar scroll sideways: no scrollbar, a right-edge fade only while tabs are off-screen, the active tab kept in view. Ship is never off-screen within 24 h of the submission deadline: in that window, a scrolling bar pins Ship at its right end.
  - **Screen readers (D11, user 2026-11-06).** Landmarks: a header holding the tablist, and main holding Plan; each section has an h2 and carries `aria-busy` while matching. One polite live region announces "Plan ready: 4 tracks, 2 credits, 3 sessions" once every section settles, then one combined "N updates" per sync (debounced, never one per item). The Next for you line is an assertive region only under D5's urgent rule (within 60 minutes, a deadline moved earlier, a cancellation). With `prefers-reduced-motion`, streamed sections appear without fades.
  - **Likely and possible (D12, user 2026-11-06).** The Tracks tile lists likely fits first, then a muted mono "Also possible" line, then possible fits in the same row format. Both levels need verified quotes. A possible track shows its entry-step checkboxes at rest only once the user marks it targeted. Why: the ranker returns up to FIT_TOP = 5. On the T7 set with the stack, recall@3 is 58.5% (55/94) and recall@5 is 72.3% (68/94). Showing the whole list catches 13 more won pairs of 94 than the top 3 alone.
  - **A row (D3, user 2026-11-06).** At rest: the item's name, one project-specific reason line, then mono metadata (fit word or time, source ↗). If a track's entry step asks for more than ticking the track on Devpost (an opt-in, a supplemental form, a specific line in the description), that step shows at rest too, as a compact one-line checkbox under the reason ("☐ Fill the supplemental form"). It's the same item as in Ship's checklist, so ticking it in either place ticks both. Plain "tick the track" steps stay in the drawer. Copy-only items (a booth question, a pitch) show their text at rest, since the text is what you take. The row opens the drawer, which holds the verified quote, the remaining entry steps, and the track's full requirements and criteria.
    ```
    [Anthropic] Claude for Public Benefit                      likely fits
    Your Ask assistant runs on Claude for students navigating transfer rules
    ☐ Say which track in your description                     devpost ↗
    ```
  - **States (D4, user 2026-11-06).** One rule for every empty or failed state, verbatim: "never instruct the user to fetch, capture or configure anything. States say what HackRecon knows and what it's doing about it." Login-gated sources are read by the extension on the next sync if the user is logged in, and Plan doesn't tell them to.

    | Section | Before you type | Working | Failed | Nothing verified | Partial / stale |
    |---|---|---|---|---|---|
    | Input | The input alone, with "52 tracks on Devpost; your plan appears once you describe your project" (count from canon) | — | — | — | — |
    | Tracks | hidden | title + "Matching…"; streams in first | "Couldn't rank tracks just now; trying again on the next change" | "No track's stated requirements match this description" | metadata reads "Devpost as of Fri 9:14" when the last sync was refused |
    | Credits | hidden | "Matching…" | as Tracks | "No offer posted so far matches your stack" | — |
    | Sessions | hidden | "Matching…" | as Tracks | "No schedule found yet. Organizers haven't posted one; HackRecon checks again every sync." | "Schedule as of …" |
    | Booths and reps | hidden | "Matching…" | as Tracks | "No rep of a targeted track has posted yet" | — |
    | People | hidden | "Matching…" | as Tracks | same as Booths | — |
    | Next for you | hidden | hidden | hidden | hidden (before the event, or nothing upcoming) | — |

    A section with no verified items stays on the page with its sentence. It never disappears, so "no suggestion without a quote" stays visible.
  - **Speed (D4, user).** "20–40 s per fit call is too slow for a type-and-see loop." The five sections run in parallel and each streams in when ready, tracks first. An unchanged description and stack show cached results instantly (cache key = input hash, as D6). Target: under 8 s to the first useful section. Not measured yet: the T7 eval recorded tokens and calls but no timings, and the "20–40 s" in the review question was an estimate, not a measurement. Step 4's exit gate times it on the dogfood input.
  - **Live updates (D5, user 2026-11-06).** A new item appears at the end of its section, marked with the mono "New". A changed item keeps its place, marked "Changed", with old → new in the drawer. Nothing reorders until the user presses the quiet "Show N updates" line under Next for you, or reopens Plan. Markers clear once Plan has been opened after they arrived. Urgent changes skip the queue: a deadline moved earlier, a claim window or session starting within 60 minutes, or a cancellation. These update the Next for you line at once (it's one line, so the layout doesn't shift) and mark the affected row in place.
  - **After the submission deadline (D6, user 2026-11-06).** Plan turns into Judging. Next for you shows the judging slot ("Sun 10:30 · Be at your table, judging until 12:30", from the quoted logistics post). Tracks shows only the tracks the user entered, each with a short **"Pitch to the criteria"** outline: each quoted judging criterion → the matching fact from the project description. A criterion with no matching fact reads "nothing in your description yet", never an invented fact. People shows the reps of those tracks; nothing says they judge unless a source quote says so. Only items whose own limit has passed close. Credits still open move to **"Still claimable after the event"** with their limits. Once results are posted (a canon or announcement change naming winners), Plan shows **"Follow up"**: reps of the tracks entered, and credits still open.
  - **Journey (Pass 3).**

    | Step | User does | User feels | Plan specifies |
    |---|---|---|---|
    | 1 | Opens HackRecon after one Sync | "Is this about my event?" | Event name in the tab bar; the input names the track count from canon (D4 states) |
    | 2 | Types the project line and stack | Committing an idea, a bit exposed | One line plus stack; the plan streams in, tracks first, with an 8 s target (D4) |
    | 3 | Scans Tracks | "Which of these can I actually win?" | Name + a reason about *their* project at rest; "likely fits", never "eligible" (D3, rules) |
    | 4 | Ticks hard entry steps, copies a code | Progress, nothing missed | Entry-step checkboxes shared with Ship (D3); code chip copies and marks done (DESIGN.md) |
    | 5 | Walks to a booth | Wants a non-generic question | The question at rest, grounded in a quoted requirement or criterion; copy-only |
    | 6 | Mid-event, something changes | "Did I miss something?" | Urgent changes update Next for you at once; the rest is queued behind "Show N updates" (D5) |
    | 7 | Submits | Relief, then nerves | Judging view: slot, pitch-to-criteria outline per entered track (D6) |
    | 8 | Results posted | Win, or (Hindsight) no track prizes | Follow up: reps of entered tracks and credits still open, without consolation copy (D6) |

    5 seconds: event name, your project, the next thing to do. 5 minutes: tracks with reasons, entry steps ticked. After the event: what is still open, and who to follow up with.
  - Rules (user, verbatim): "no suggestion without a verified source quote; never claims eligibility; updates live with 'new' markers; never sends anything." Mechanism: every item's quote is checked against its source entity or post (the same check as fit's); fit language is "likely fits", never "eligible"; an item whose source changed or appeared since the user last opened Plan carries "New"; questions and pitches are copy-only, like Meet's openers.
  - The description and stack go to the ranker as in D6 (POST /fit, Origin + per-run token, cached by input hash). Credits, sessions, booths and pitches use the same endpoint with their own verified outputs.
  - Eval (user): tracks by the Devpost-winners eval (D23 baseline above); credits, sessions and booths by the Opus judge on relevance, with n beside each rate. Dogfood on the user's real Cal Hacks project.
- **Build** (folded into Plan's tracks section): tracks with their prizes, requirements and criteria. The **track stacker** (D4):
  - **Idea fit:** the user describes their project in one sentence, and Build ranks tracks by how well the idea matches each track's stated requirements and criteria. Each ranked track quotes the matching requirement ("likely fits: uses an LLM agent → Microsoft challenge"). Fit is a suggestion with evidence, never a guarantee.
  - **Selecting tracks** shows the union of their requirements, criteria per track, and stated prize per track (never a summed "expected value"), and adds each track's stated entry steps (opt-ins, supplemental forms, "say which track in your description"), quoted, to Ship.
  - Stated stacking limits, where a page has one, show as ordinary quoted rules. There's no pairwise "allowed together?" grid.
- **Claim:** v1's board, unchanged in behavior. Offers now also come from thread replies and Devpost resources.
- **Now:** the schedule (D3: config-listed schedule pages, else Slack), merged. Hacker questions never appear here (D9); an entity that ≥ 3 distinct hackers asked about with no authorized answer yet carries a muted "N asked" marker, no text or names. It shows:
  - what's on now and next;
  - every change, with old and new values and the source post;
  - deadlines in one strip, both organizer and offer deadlines (v1's Closes-soon, extended).
  - The replay scrubber becomes a demo-mode control, shown only when the event is finished or `?replay` is set.
- **Meet:** reps by sponsor with their first post. Plus:
  - booths with a place and hours, from quoted posts or the map;
  - per rep, a drafted one-line opener that refers to their actual post (redacted input, `{first_name}` filled in locally), plus a LinkedIn **search** URL. Owner: `live.ts`, worker model per D21, cached by input hash; verify: every number, product name and date in the opener appears in the rep's quoted post, else the opener is dropped and Meet shows the post alone.
  - The user copies the opener and sends it themselves.
- **Ship:** a checklist built from:
  - submission rules;
  - the stated entry steps of the tracks selected in Build (D4);
  - the requirements of the tracks selected in Build;
  - the submission deadline, merged with any Slack extension;
  - judging logistics (be at your table 10:30–12:30).
  - Each item has its source and a done check. Items added by a Slack change are marked as such.
  - **Layout (design review D13, user 2026-11-06).** Top line: the deadline countdown, "Submissions close Sun 9:30 · in 5 h 12 min", from canon merged with any Slack extension. When canon and Slack differ, the line shows the merge: "Sun 9:30 · Devpost said 9:00", with sources on demand. Below it, one 12-col tile with three groups, each heading carrying a mono "N of M done":
    1. **Required to submit.** The first item is always "Submit on Devpost, not just save a draft". It's sourced from an organizer post saying so when one exists. At Cal Hacks that's #0-announcements, 1792945574.409879: "There are still 113 draft submissions as of now! Please make sure you fully click through to Submit by 9:30 AM." Without such a post it is HackRecon's standing item, marked as such. The submission rules follow.
    2. **For the tracks you entered:** entry steps and requirements per track. These are the same items as Plan's D3 checkboxes, so ticking either place ticks both.
    3. **Judging:** logistics such as "Be at your table 10:30–12:30".
    - Each item: a native checkbox (DESIGN.md), the quoted line, source ↗. Slack-added items say "added in #0-announcements".
    - **Last hour:** under 60 minutes to the deadline, Ship collapses to the countdown plus the unticked Required items only. The other groups fold to one line each and expand on click.
  - **Recheck gaps (user 2026-11-06).** An item for the tracks the user plans to enter, shown when a repo is linked.
    - **What it does:** reruns the gap check (Plan's, same rules) on those tracks against the repo's latest commit.
    - **What it shows:** the commit and the time it was checked, e.g. "Hindsight @ db92f7d, latest as of Fri 3:23 PM; checked 3:23 PM".
    - **Open gaps** go above the checklist, each with its sentence, the page's quote and the project's quotes with their sources (repo lines link to the commit).
    - **Caching:** when the latest commit is the one already checked, the stored result stands ("the commit hasn't changed since") with no clone update and no model call. A new commit updates the cache clone and reruns. If the matching repo lines are unchanged, the gap check's own cache answers, with links re-pointed at the new commit.
    - **Scope:** "Tracks the user plans to enter" are Ship's "tracks you entered", whatever their fit, so possible tracks are checked too.
    - **Built (engine):** `pipeline/ship.ts` `recheckGaps`, `hr ship --from … --enter "…"`, and `POST /ship/gaps` (same Origin + token guard). The item's rendering is P9.

### 5. Per-event config and generalize

```
events/<slug>/
  event.json        name, timezone, slack workspace URL, canon page URLs, channel priority, authority channels, organizer patterns
  sponsors.json     channel → sponsor (as in v1), plus Devpost sponsor names for matching
  config/organizers.json                                   (gitignored, D10)
  captures/         slack/*.json, pages/*.json            (gitignored)
  data/             caches, entities.json, board.json      (gitignored)
  review/           labels, judge runs, eval reports       (gitignored, D10)
  fixtures/         DOM and page samples                   (gitignored, D10)
```

`hr` takes `--event <slug>`, defaulting to `events/current` (a one-line file).
- **Cal Hacks migration:** `calhacks-13` moves into this layout with `git mv` for config and a move for the gitignored data. Paths in `hr` stop being constants.
- **Generalize** (the last step): write a second event's `event.json` and `sponsors.json` by hand (about an hour for Cal Hacks), capture its pages and whatever Slack access the user has there, and build its board. It's done when that event's pages pass the D15 coverage checks with no code changes (D18). Auto-drafting the config (`hr init`) is deferred to TODOS (eng review D1).

Resolved (D10): the per-event layout is step 0, right after step −1, with .gitignore safeguards first. (`hr init` auto-drafting is deferred, D1.)

## Eval (step 2: entities + Opus-judged eval)

Like v1, every number is agreement with Opus, said so on every report, plus a hand check where the set is small.

| Set | Size (Cal Hacks, est.) | Producer | Judge | Gate |
|---|---|---|---|---|
| Canon entities from pages | [estimated] ~20–40 tracks/prizes, 5 criteria [measured: Devpost page, 2026-10-28], ~10–20 rules, schedule items: none on calhacks.io (F1) | Opus extract + code verify | Opus judge (fresh context: "given this page, list what's missing or misplaced") plus model-free coverage checks (D15) | Verify: 100% of quotes found, numbers in quotes. Judge: no missing track, prize, criterion or rule. Coverage (D15): prize sum reconciles with the page's stated total (at Cal Hacks $204,408, "$204,408+ in prizes" on the 2026-11-06 snapshot; the 2026-10-28 probe read $159,822, see below) with unmatched figures listed; prize-block count = extracted prize count; every $-amount and date on the page attached or listed "unattached". Any mismatch fails |
| Slack → kind candidates | 977 top-level + replies captured | Haiku | Opus prelabel (v1 `hr prelabel`, extended to kinds) | Recall ≥ 0.9 on `change` and `booth`; as v1's gate for `credit` |
| Slack → changes (link) | Every candidate | Opus link | Opus judge on a stratified sample + every applied change to a deadline or time | **Applied-change precision ≥ 0.95** on deadlines and times (a false override shows a wrong deadline). Recall ≥ 0.8. Every miss is listed with its permalink |
| Idea fit (D16, D23) | 81 Cal Hacks 13.0 projects that won a sponsor track; 94 (project, sponsor track) pairs over 40 prizes [measured 2026-11-06] | Sonnet ranker | Devpost won sponsor tracks; event-level prizes (12 wins: "Cal Hacks …" + [MLH] Commit Fellowship) excluded and listed separately; submitted tracks aren't public | 100% cited quotes verified. Ablation over all 94 pairs: run A (description only) = headline recall@3; run B (description + public Built With) recall@3 beside it; Build asks for the stack if B − A ≥ 10 points over all 94 pairs or ≥ 20 points pooled over the 58 "Best Use of X" pairs (user rule, 2026-11-06). Per-prize recall@3 (A, B) for the 21 "Best Use of X" prizes (58 pairs), `tool_gated_prizes` as a tag only. Secondary: per-project any-hit for A and B (n=81). n beside every rate. Threshold set after the first run |
| Thread capture | 494 export replies in the locked 25 | Extension | Export (ground truth) | Keyed recall ≥ 0.9 |
| Claim regression (D14) | 20 offers, 3 priced [measured: data/board.json] | v1 pipeline | Checked-in fingerprint of v1's board.json (ids, counts, times, excerpt hashes; no workspace text) | `bun test` matches on every build; allowed differences listed per field with the decision that allows them |

The judge never sees the producer's reasoning, only the source and the output (v1 rule: blind to Haiku). Disagreements land in `hr label` for the user to settle, and the user's label wins.

### Canon results, Cal Hacks 13.0 Devpost (step 3, 2026-11-06)

Input: fixture snapshots built from the public overview and rules pages (`hr pages --from-html`, `captured_by: "fixture"`), not extension captures, so the output goes to `data/canon.fixtures.json` and never reaches a board. Re-run on extension captures before step 4 ships.

- **Page total changed (corrected 2026-11-06).** Two figures, two dates, same URL (`cal-hacks-13-0.devpost.com`):
  - **$159,822**: the 2026-10-28 live probe, the sidebar's "Prizes $ 159,822". Correct for that day's page, and no longer on it.
  - **$204,408**: the 2026-11-06 snapshots (the 17:35 fixture and the 19:19 fetch, same hash 3489bbc282097465), stated twice: "$204,408+ in prizes" under Prizes and "$204,408 in cash" in the overview stats.
  - The page changed between those dates. Why isn't known: there is no snapshot from between them.
  - **What the checks use:** D15's prize_total gate parses the current snapshot's "… in prizes" line (`coverage.ts`), so today it's $204,408. No fixed figure is in the code.
  - **Measured, not inferred:** Σ over prize blocks of each block's "$X in cash" × "N winners" equals $204,408 exactly. Whether Devpost computes its total that way isn't known; the two just agree. It overstates some sponsors' own text (Hyphenate: $16,000 × 5 winners = $80,000 vs "8000$, 5000$, 3000$ for the top 3 teams").
- **Three runs** (run 1 → prompt fixes → run 2 → run 3), $1.43–1.54 per extraction pass and $0.17 per judge pass at list price:

| Run | Entities (overview + rules) | prize_total | prize_blocks | Unattached figures | Opus judge |
|---|---|---|---|---|---|
| 1 | 148 + 3 | PASS | PASS (52/52) | 8 (after a comma fix in the money pattern) | 2 missing (Meta Round 2 condition, SpaceXSI raffle) |
| 2 | 149 + 3 | PASS | PASS | 4 | 2 missing (Tiger Data and SpaceXSI judging basis) |
| 3 | 154 + 3 | PASS | PASS | 5 | **0 missing, 0 misplaced** |

- **Coverage checks as implemented** (`pipeline/coverage.ts`): (1) the page total = Σ track `cash_value_usd` × `winners`; (2) every prize block has a track named from its heading and at least one prize; (3) every $-amount and date is in a verified quote from its block or listed "unattached", a listing, not a failure. These differ from D15's wording; see Unresolved decisions.
- **D7 ids.** Ids that included a model-chosen name kept 100 of 148 across two extractions of the same snapshot. Ids now come only from page-fixed parts: a track by its heading path; a prize by its track and stated place (by stated amount when several prizes share one place); a rule by its path and the first words of its verbatim text; a criterion by its path and name. Across the three runs every recurring id is kept (148/148, 149/149, rules 3/3); later runs only add entities. The tolerant-match threshold (0.8) is therefore uncalibrated: an unchanged snapshot never needs it. Calibrate it on the first re-capture whose snapshot hash changes.

**Canon on the step-2 snapshot as real canon (D11 reversed, 2026-11-06).** `hr canon --judge` on the step-2 snapshots, now in `captures/pages`: 152 entities from the overview (52 tracks, 78 prizes, 10 criteria, 12 rules) and 4 rules from the rules page. Coverage PASS (prize total $204,408 = Σ cash × winners; 52 of 52 prize blocks with a track and a prize; 5 unattached figures, 2 in prize blocks). Judge 0 missing, 0 misplaced on both pages. Cost $1.71 at list price. Run 3 on the same text found 80 prizes, this run 78; both pass prize_blocks, which counts blocks, not places. The live fetch then produced the same normalized-text hashes as these snapshots, so this is the canon a sync produces today. The prize count moving between runs is unresolved; the next comparison is run 3 vs this run per block.

**Canon run-to-run diff and determinism (user, 2026-11-06).** Run 3 and the re-run had identical prompt and input hashes (b17ce034…, 35df0594… for the overview), yet differed in two places. Hyphenate's "Cash prizes of 8000$, 5000$, 3000$ for the top 3 teams" came out as three prizes in run 3 and one "top 3 teams" prize in the re-run (80 vs 78). The rules page gave 3 vs 4 rules. Every coverage check passed both ways, so these are granularity differences, not dropped lines. The user asked to pin extraction to temperature 0, but Opus 5.5 rejects `temperature`, `top_p` and `top_k` with a 400. So canon is made deterministic another way: every extraction is stored by prompt hash + input hash (`data/canon_extractions.json`, shared by fixture and real runs). An input is extracted once and reused from then on; `--force` re-extracts. The store was seeded with run 3, whose three-prize reading follows the prompt's own rule ("One per place the track states") and whose cards the fit baseline used. Real canon now reproduces run 3 (80 prizes, coverage PASS, judge 0/0), and fit-eval on real canon hits all 162 cached rankings. A new prompt still gets a fresh extraction, so a prompt change is the place a reading can move; it shows up in the canon diff and the fit gate.

**Fit gate (user, 2026-11-06).** "recall@5 must stay ≥ 67% (baseline 72.3% minus ~1 SE at n = 94) or the change fails. A change counts as an improvement only if a paired McNemar test on the same 94 pairs gives p < 0.05." It's implemented in `hr fit-eval` on run B (with the stack): an exact two-sided McNemar on per-pair hits against `review/fit_baseline.json`, which was set from the T7 cache. Every full run prints recall@3 and @5 with n, the pairs lost and gained, and p, and exits 1 below 67%. **The baseline was re-set 2026-11-06 to the tiered-evidence run (recall@3 55/94, recall@5 67/94; see "Fit baseline before Slack requirements"); the 67% floor is unchanged.** If the pair set changed (a canon re-read renamed a track), no improvement can be claimed. First gated run: recall@3 55/94, recall@5 68/94, PASS.

### Idea-fit baseline (T7, D23, 2026-11-06)

`hr fit-eval --fixtures`: claude-sonnet-5-5, effort medium, top 5 per project, against the 40 sponsor tracks in run 3's canon (fixture snapshots). 162 rankings, 0 failed, every cited quote verified; $1.47 at list price. Agreement with Devpost outcomes, not accuracy.

| Metric | Run A (description) | Run B (+ Built With) |
|---|---|---|
| recall@3, all sponsor-track pairs | **37.2% (35/94)** headline | 58.5% (55/94) |
| recall@3, "Best Use of X" pairs (21 prizes) | 27.6% (16/58) | 60.3% (35/58) |
| any-hit per project | 40.7% (33/81) | 65.4% (53/81) |

**Stack rule result: Build asks for the stack.** B − A = 21.3 points over 94 pairs (bar 10); the "Best Use of X" gap is 32.8 points (bar 20), so both branches fire. The per-prize table is in `review/fit_eval.json` (gitignored). Prizes neither run finds: Notability (0/5), Bitdeer (0/2), and Nessie, Moss, Gemini, Solana, Vultr (0/1 each). The 12 event-level wins are listed, not scored. No fit threshold is set yet: the doc's rule is "threshold after the first run", and that call is the user's.

**recall@5 (design review D12, 2026-11-06).** `hr fit-eval` also prints recall@5, the whole ranked list Plan shows as likely + "Also possible". Re-scored from the T7 cache (0 API calls, same 162 rankings on `data/canon.fixtures.json`): A 41.5% (39/94), B 72.3% (68/94). **Baseline (user): recall@3 B = 58.5% (55/94)** is the number later runs are compared against. The fit cards from the re-run canon (`data/canon.json`) miss the cache for all 162 rankings, so a run on it is a new measurement, not this baseline.

### Offer ids (OV5, 2026-11-06)

Claim board offers are now `o-<channel>-<first post ts>` (e.g. `o-spons-cartesia-1792446957154859`) instead of `o1…o20`. `board.json` carries `v1_ids`, built once by matching the v1 board.json's offers on their first post (20/20 matched) and carried forward on later builds; the board moves saved done marks through it on first load. D14 compares every offer field exactly after translating ids back through that map, so the only allowed difference is the id itself (12/12 pass).

## Build order and exit gates

| Step | Builds | Exit gate | Est. |
|---|---|---|---|
| −1 Capture first (D5) | No code: capture the 29 stretch channels top-level with the v1 extension; `hr compare`, then `hr record-run`; save raw thread-pane DOM samples (OV7) | 29 captures recorded; keyed recall per channel reported | ~1 h [estimated] |
| 0 (D10) | .gitignore for `events/*/{captures,review,data,fixtures}/`, `events/*/config/organizers.json` and `events/current` first; a test that fails if any is tracked; then `events/<slug>/` layout, `--event`, Cal Hacks migrated. v1 board renders unchanged from the new paths | `bun test`, D14 fingerprint matches; user checks `git status --short` after the move | 0.5 d [estimated] |
| 1 Thread fixture (D5) | Thread capture, run uncapped on the locked 25 before anything else (D17); `hr compare` for threads | Thread recall ≥ 0.9 vs export (or "unmeasured" if access is lost, OV7); selectors backed by fixtures | 1–1.5 d [estimated] |
| **Page half (D18)** | | | |
| 2 Page sources | Page snapshot action with access flag (D12), outline h1–h6, normalized hash; Devpost snapshot for Cal Hacks, Hive if it still opens (D3) | Snapshots captured; iframe/PDF reported | 1 d [estimated] |
| 3 Canon entities + eval | Entity schema, page extraction + verify, coverage checks (D15), Opus judge, source-anchored ids (D7), offer ids (OV5); fit eval on the 94 sponsor-track pairs (D23) | D15 gates; D23 baseline reported | 2–3 d [estimated] |
| 4 Plan + Ship | Discovery and fetch (`hr sync`, done 2026-11-06). Plan (default tab: tracks with entry steps, credits, sessions, booths and reps with questions, people to pitch; POST /fit, D4/D6) and Ship from canon. Sections 3–5 use what exists before step 6 (event.json's sourced schedule, v1's reps and their first posts) and grow when Now and Meet land. /plan-design-review before, /design-review after | Plan and Ship at 1440, 390 and 360 (five tabs fit or scroll per D10); every Plan item's quote 100% verified; tracks recall@3 and @5 against the 58.5% baseline; credits, sessions, booths relevance by the Opus judge with n; time to the first section measured on the dogfood input (target < 8 s, D4); dogfooded on Hindsight (`fixtures/dogfood/`, gitignored) | 2.5–3.5 d [estimated] |
| **Slack live half (D18)** | | | |
| 5 Live sources + link | "Sync this event" (one click: channels, threads, sidebar, posting flags; DOM sample of a restricted channel), incremental capture, live thread selection (D17, D20), kind classifier, link pass | Link eval with n printed (OV9); posting flag backed by a fixture | 2–3 d [estimated] |
| 6 Merge + Now + Meet | `merge()`, authority (D8, D19), "N asked" (D9), Now and Meet views; /design-review after | Unit tests over every Merge rule; Cal Hacks deadline shows page 09:00 / Slack 09:30 | 2–3 d [estimated] |
| 7 Generalize | Second-event dry run: Sync once, discovery drafts the config (supersedes `hr init`, D1) | The second event's pages pass the D15 coverage checks with no code changes and no hand-written config beyond confirming the drafts (D18) | 0.5–1 d [estimated] |

Live-only behavior (incremental capture, the live thread budget, Now's on-now/next, roles at a new event) is unproven until a named event; next event: <TBD>, platform: <Slack/Discord> (D18).

Total: about 10–14 solo days [estimated, no basis beyond v1's pace]. Steps 1 and 2 can overlap once the thread fixture run has started.

## Decisions for review

- ~~**E1**~~ Resolved: D11.
- ~~**E2**~~ Resolved: D10.
- ~~**E3**~~ Resolved: D15 (Opus judge + model-free coverage checks, no hand check).
- ~~**E4**~~ Resolved: D17 (was: thread capture budget per sync (60 by default) and order (most replies first). Or capture every thread in priority channels only?
- ~~**E5**~~ Resolved: D12 (public pages unredacted, authenticated pages redacted, by snapshot flag).
- ~~**E6**~~ Resolved: authority D8; hacker questions D9.
- ~~**E7**~~ Not a choice: the brief never asked for the side panel; it stays in Not in scope.
- ~~**E8** Stacking rules default~~ Moot after D4: there's no pairwise answer to default.

## Risks

- **Cal Hacks' canon may have changed since the event.** The event site may be gone or rewritten, and Devpost pages persist but show the final state. If the site's schedule is gone, `config/event.json`'s 4 hand-sourced entries plus Slack are the fixture, and the schedule-from-page path is proven at generalize instead.
- **Thread capture is the slowest part of a sync.** 60 threads at about 3 s each is about 3 minutes. The budget and incremental capture keep it bounded, and the user sees progress.
- **Slack DOM drift.** All selectors stay in one file, fixture-tested, as in v1.
- **Override precision is the safety-critical number.** A wrong "deadline moved" is worse than a missed one, because the user trusts the board. Hence the gate at 0.95, both values always shown, and the source one click away.
- **Workspace access** may be revoked at any time. Capture Cal Hacks threads first, before anything else in step 1 (TODOS already says this for the 29 stretch channels).
  - **What the export already holds (checked 2026-11-06, `~/projects/hackrecon-data/calhacks`, the extracted `calhacks.zip`; the folder matches the zip except `__uploads/`, 247 attached files).** The content at risk is already safe:
    - **Thread replies in the locked 25:** 494 replies by `thread_ts` (520 with the 26 sent-to-channel copies v1 already captures). This is the recall baseline itself.
    - **The 29 stretch channels** (the 27 `spons-*` channels outside the locked 25, plus `partner-asus` and `partner-redbull`): all present, with 753 top-level messages (170 real posts, subtype null; the rest are joins and other system rows) and 91 thread replies.
    - **Users and profiles:** `users.json` has 2,900 users (52 admins or owners, 9 deleted, 15 bots). Of the people who post in the 54 channels, 663 of 665 have an entry (475 of 477 in the locked 25, all 188 in the stretch 29). Profile titles are thin: 41 of 565 distinct posters have one, so a rep's role keeps coming from their posts, not their profile.
  - **So what steps −1 and 1 protect while access lasts is the live extension test, not the content:** running the real extension on the real workspace and measuring it against the export (top-level keyed recall on the 29; thread recall ≥ 0.9 on the locked 25), plus the thread-pane DOM samples the selectors are tested on. Without access, thread recall is "unmeasured" (OV7) and v2 runs on the export's replies.
  - **Order (user, 2026-11-06):** Slack access is still open, so capture goes first: the user runs step −1 while thread capture (step 1) is built, then runs it uncapped on the locked 25. P2 starts after that.
  - **Step −1 deferred (user, 2026-11-06):** the stretch 29's content is in the export, so their live capture waits. `sponsors.json` lists them with `"stretch": true`, so `hr record-run` will accept the captures when they're made. Until then, top-level keyed recall on the 29 is unmeasured.
  - **Step 1 so far (2026-11-06):** the thread file format (`<channel_id>.threads.json`) and `hr compare` for threads are built and tested: replies scored by `ts` under their own parent, with the locked-25 total printed against the 90% gate. The export's `reply_count` includes sent-to-channel copies (cohost-anthropic's longest thread: 31 counted, 30 plain replies), so the capture records the rendered "N replies" as shown. `hr scrub-dom` strips session tokens from DOM samples, and a test fails while any sample still has one. The capture itself waits on thread-pane DOM samples (`extension/README.md`), since D5 requires the selectors to be backed by fixtures.
  - **No hand-saved samples; Sync this event built now (user, 2026-11-06):** "I'm not saving any samples by hand, now or later. HackRecon has to collect them itself." So "Sync this event" (`extension/src/sync.ts`) moved up from step 5 and carries step 1:
    - **Channels:** it reads the sidebar and picks `spons-`, `partner-` and `cohost-` channels by prefix (user), plus announcement channels (§Sync). That's 53 at Cal Hacks: the locked 25 and the stretch 29, minus 2-opportunities, which has no replies. It opens each with a sidebar click and captures it as before.
    - **Threads:** it opens every thread it found, longest first and uncapped (D17's one-time fixture run). It clicks "N replies", reads the pane from the parent down to the end, and clicks any "more replies" control, after which it reads down again from the top.
    - **Samples:** a few panes are saved as scrubbed HTML samples: the first thread, threads with 8 or more replies (6 at most), and panes that showed a "more replies" control, opened empty or didn't open.
    - **Pane finding:** the reply bar and sidebar selectors are verified on the spons-moss samples. The pane is found without its own markup: a subtree outside the message pane that holds the parent's `data-msg-ts` or reply permalinks with `thread_ts=<parent>`.
    - **Raw rows:** pane rows are kept as raw scrubbed HTML per scroll step (`.threads.raw.json`), so `hr rebuild-threads` reparses them after a selector fix without another sync.
    - **Ingest:** `hr sync-ingest` brings the bundle into `captures/sync-<stamp>/` (new captures never overwrite the Oct 27 ones).
    - **Verified so far:** headless Chromium drove the built `dist/sync.js` through a stand-in Slack built from the export (virtualized panes, a pane that opens at its end, a "Show N more replies" control): 7 channels, 48/48 threads opened, 132/132 replies. The offline rebuild matched the in-page parse. The first stand-in runs caught two bugs, both fixed: long panes opening at their end hid the parent, and replies revealed by "more" were skipped.
    - **First real sync (user, 2026-11-06 18:29–18:49 PT, 20 min 37 s from sync.json):**
      - **Coverage:** 53/53 channels opened. 243 threads, every pane found by `data-qa="threads_flexpane"`, all stopped `parent_seen`. No "more replies" control appeared. 0 save errors, 0 tokens in the 14 pane samples.
      - **Channel keyed recall:** 972/972 on the 24 locked channels it covers (2-opportunities has no prefix, so it isn't synced) and 167/167 on the stretch 29, which covers step −1's top-level capture.
      - **Thread recall against the export:** 486/494 = 98.4% on the locked 25, passing D5's 0.9 gate. 91/91 on the stretch 29. All 8 locked misses are replies under 2 deleted parents (spons-crs-credit-api, cohost-hyphenate). The channel capture skipped "This message was deleted." rows, so it never saw their reply bars. Fixed for the next sync (`deletedParents`); UNVERIFIED that Slack draws a reply bar on that row.
      - **Authors:** 6 thread replies had headers whose name Slack hadn't loaded yet (`c-missing_text`). The first parse gave them the author above. They are now blank and flagged, never someone else's name (`SEL.unknownSender`); `hr rebuild-threads` reparsed the saved rows.
      - **Channel author mismatches** (11/984) are two people renamed after the export. The Oct 27 capture shows "LaurenElize (Annapurna Labs)", and Slack now renders "LaurenElize". "prasiddhapoudyal36" is now "nick7178". The lost "(Annapurna Labs)" suffix was a rep signal: reps can't rely on display-name suffixes.
      - **Close button:** every end-of-pane sample has one close button, matching both `data-qa="close_flexpane"` and `aria-label="Close"`. Syncs now log the matched candidate per thread (`close` in sync.json).
    - **Channel selection comes from the event config (user, 2026-11-06):** every `sponsors.json` channel (event channels like 2-opportunities included) plus `event.json` `authority_channels`, in config order. Sidebar prefixes only discover channels the config doesn't list yet, and sync.json reports them, along with config channels missing from the sidebar. The build writes the list to `extension/dist/sync-config.json` (channel names only), and the popup hands it to the sync. A test checks that every locked channel is selected. The next sync captures 2-opportunities.
    - **Reps and organizers are keyed by Slack user ID only (user, 2026-11-06):** `rolesById` in `pipeline/roles.ts`. A role signal seen on any of a user's posts (an organizer tag or title, a sponsor name in the display name or title, the external badge) holds for all their posts, so a rename mid-event can't drop it. A post with no ID gets no role. `organizers.json` holds `{id, why}` only. On the current run's 1007 messages no role changed, so classifier inputs (and their cache) are unchanged.
    - **Same-person links (user, 2026-11-07).** ID keying counted one Fetch.ai rep twice: a guest account and a member account with the same display name and title. The Claim board's Reps went from 3 to 4, and D14 failed. The ID stays the key everywhere. A separate layer (`pipeline/people.ts`, `hr person-links`) links two IDs as one person only on strong evidence from one users.json snapshot, checked in order:
      1. the same profile email;
      2. the same avatar image: identical bytes, else a 16×16 box-averaged difference hash within 8 of 256 bits, custom images only;
      3. the same real name + title + company.
      - Never by name alone, and the display name is never read, so a rename can't create or break a link (tested).
      - Each link is written with its evidence to `config/person_links.json` (gitignored), hashed, never the email or the image.
      - **Scope:** accounts on the same sponsor's side, where the Reps tile counts people (16 accounts, 6 sponsors).
      - **What the snapshot supports:** 1 of 2,900 accounts shows an email, and users.json has no company field, so in this workspace only the avatar rule can fire. The avatar is fetched from Slack's image CDN at the URL users.json lists (no Slack API call), hashed and discarded.
      - **Result:** 1 link, U0CAKK42CQY = U0CBTBWAEM7 (Fetch.ai), avatars 3 bits apart. The closest pair of different people among the 11 hashed avatars is 104 bits apart.
      - Fetch.ai shows 3 candidates again, and D14 passes with no exceptions. Board.json's new `rep_accounts` (kept out of the fingerprinted `reps`) puts both accounts behind the one rep. The Reps drawer says "one candidate posts from 2 accounts". No role changed on the 1,007 messages.
    - **Rep signals (user, 2026-11-07).** A5's signals (a name or title naming the sponsor, Slack's external badge) missed Apify's staff. `pipeline/reps.ts` and `hr rep-signals` add three signals, strongest first. Everything is keyed by person, never by name:
      1. **Confirmed:** a profile email on a domain the sponsor lists in sponsors.json (`domains`), or a subdomain of it.
      2. **Confirmed:** an authority account (D19: an organizer id backed by admin or owner status, or a top-level post in an authority channel; anyone can reply in its threads, so a reply there carries only its author's authority) mentions the person's user ID on a line naming the sponsor. The mention's label is the person's own display name, so it's cut before sponsor names are read. A line naming two or more sponsors is skipped.
      3. **Likely staff:** all three hold. A classified credit, prize or workshop post at the top of the sponsor's own channel. An answer, in one of its threads, to a question from someone neither organizer nor sponsor-side. No post ever in a hacker-only channel (event.json `hacker_only_channels`, else channels named like team formation or introductions). If those channels weren't read, no one is likely staff.
      - Confirmed reps are sponsor-side in `rolesById`. Likely staff never is, so it gets no authority over links or offers and no classifier hint. It's shown labeled, with its evidence, after the reps.
      - **Display:**
        - Each rep shows the signals it matched on Plan's People and in the Claim board's Reps drawer.
        - The Reps tile shows "N likely staff" for a sponsor with no candidate.
        - The likely-staff counts are kept out of the fingerprinted `reps`, in board.json's `rep_signals` and `rep_likely`.
      - **Replays:** likely staff holds from when both its staff post and its answer are in, and a replay counts only evidence posted by then.
      - **Sources, recorded in `config/rep_signals.json` (gitignored):**
        - Replies come from the synced thread captures (610).
        - Hacker-only posters come from the export, author IDs only. Syncing those channels would send about 870 hacker posts, mostly intros, to the classifier.
        - Mentions come from the export until the next sync. The parser now keeps each mention's `data-member-id`, checked against the export on the DOM samples.
        - Emails come from users.json.
      - **Cal Hacks:**
        - Signal 1 can't fire: 1 of 2,900 accounts shows an email (the user's own), and no sponsor lists a domain.
        - Signal 2 finds no one: 52 authority ids, no authority channel flagged yet, and none of their posts names a sponsor beside a mention.
        - Signal 3 finds 15 people, 9 of them already sponsor-side. Six are new: Petros Hong (Apify: 7 staff posts, 8 answers), Arinze Obiezue (Anthropic), Grant Timmerman (Cartesia), Tarik Neradin (CRS Credit API), Behzad Haghgoo (Mana) and Aiperi (Wajo AI).
        - None of the six posts outside their sponsor's channel and #0-general, or asks anything elsewhere.
        - The hacker-only rule also turns away one real rep, Microsoft's recruiter, who posted in a hacker-only channel. The name rule already counts them.
        - Board.json's `reps`, `rep_accounts` and offers are unchanged, and D14 passes.

## Not in scope

- The live side-panel extension, IndexedDB and `chrome.alarms` (TODOS Approach B).
- Posting to Slack, DMing reps, and any LinkedIn fetch.
- Accounts, sync between devices, and a hosted board.
- Team features (shared stacks or checklists).
- Non-Devpost submission platforms (Devfolio, the organizer's own portal) beyond what the generic page snapshot extracts. Named adapters come after generalize, if needed.
- Prize "expected value" or any number not stated by a source.

## Eng Review (plan-eng-review, 2026-10-28)

Target: `docs/designs/hackrecon-v2.md` (this file), named by the user. Report file: this file.

### Scope record
feature answers: D1 = B) Defer `hr init` auto-drafting to TODOS (user, 2026-10-28); structure: D2 = B) Smaller arrangement (user, 2026-10-28); accepted scope: the brief's full feature set (five views, multi-source canon + live, merge rule, thread capture, per-event config, build order) with `hr init` deferred and step 5 reduced to a hand-written second-event config plus a no-code-change board build; modules arranged as pipeline/event.ts, pipeline/canon.ts, pipeline/live.ts, pipeline/merge.ts, entity types in pipeline/schema.ts, board/views.js, and one shared verify-and-retry helper lifted from pipeline/group.ts; pending remedies: F1–F5 (Scope Challenge C).

### Scope Challenge findings
1. F1 `[CRITICAL] (confidence: 9/10) docs/designs/hackrecon-v2.md §Sources, §Build order step 1` — "event site: schedule" is canon, but calhacks.io has no schedule: "Palace of Fine Arts! The schedule and more details will be sent closer to the event!" (probe 2026-10-28). The Devpost page links the real one as "Live Site: Hive Platform" (unverified, probably behind a login). The step-1 gate "Devpost and event site snapshots captured for Cal Hacks" can't produce schedule canon.
2. F2 `[INFORMATIONAL] (confidence: 8/10) §Views Build` — Devpost states no general stacking rule. The stated entry steps are per prize, e.g. Commit Fellowship: "opt into the Commit Fellowship Prize Category when you submit your project … submit this supplemental form", and "In your project description, indicate which track … you are submitting for". The stacker as written would show "rules don't say" for every pair.
3. F3 `[CRITICAL] (confidence: 8/10) TODOS.md:39-45` — "Capture the 29 stretch channels … do this before anything else post-demo" (workspace access may be revoked). The v2 doc's step 1 captures Cal Hacks threads but not the 29 stretch channels, and puts no capture ahead of the code work.
4. F4 factual correction (no question): the "Labels" constraint is scoped to `hr label` / `hr gate`; views show model output labeled with its model.
5. F5 factual correction (no question): unmeasured sizes and the effort total are now tagged [estimated]; calhacks.io is plain HTML, not client-rendered.

### Section 1: Architecture
Design-twice: the two shapes compared in D2 (split by step vs. split by knowledge); the knowledge split won because one module owns each rule and each path. Red flags: information leakage (model-named ids) fixed by D7; hand-synced list (`COMMANDS` vs USAGE in pipeline/hr.ts:119) is pre-existing and minor, listed under Suppressed findings.
Findings, most severe first:
- A1 `[CRITICAL] (confidence: 9/10)` §Views Build + pipeline/hr.ts board route: idea fit (D4) had no path to a model → D6 accepted (guarded POST /fit).
- A2 `[INFORMATIONAL] (confidence: 8/10)` §Entities id: model-named ids orphan marks on re-extraction → D7 accepted, amended with tolerant matching (D8 answer).
- A3 `[INFORMATIONAL] (confidence: 7/10)` §Premises 2: authority → D8 accepted; hacker questions → D9 accepted (drawer only + "N asked" marker).
- A5 `[INFORMATIONAL] (confidence: 7/10)` E2 path timing → D10 accepted (step 0 with .gitignore safeguards first).
- A6 `[INFORMATIONAL] (confidence: 6/10)` E1 → D11 accepted (extension only; `hr fetch` to TODOS).
- A7 `[INFORMATIONAL] (confidence: 6/10)` E5 → D12 accepted (redaction by snapshot access flag).
Failure per new integration: page layout change → verify fails → retries → reported, never shown unverified; Slack DOM drift → thread recall drops → `hr compare` flags it; false Slack override → precision gate (Eval) + both values shown; API down on /fit → Build shows tracks unranked with the reason.
Distribution: the extension is rebuilt locally (`bun run build:ext`) and loaded unpacked, as in v1; no store listing (Not in scope).
Dispositions: A1 accepted (D6), A2 accepted (D7 + amendment), A3 accepted (D8, D9), A5 accepted (D10), A6 accepted (D11), A7 accepted (D12).

### Section 2: Code quality
Findings: CQ1 `[CRITICAL] (confidence: 8/10)` §Merge steps 1–3: an older Slack post overrode a newer page edit → D13 accepted (one timeline, ambiguity flag). Edge cases carried into tests (no new policy): a canon page whose text is in an iframe or PDF yields no text and is reported as "no text captured", like a missing page; a thread reply whose parent wasn't captured keeps its `thread_ts` and is reported, not dropped.
Dispositions: CQ1 accepted (D13).
Shared-code rubric (D2's helper): existing caller `groupOffers` (pipeline/group.ts:229-280: model call → parse → `checkGroups` → retry with the error, up to 1 + OUTPUT_RETRIES); proposed callers canon.ts, live.ts, fit.ts (assumptions from D2, D4, D6). Contract `(request, check(parsed) → {ok} | {error}) → result | {error, usage, calls}`. Estimated −50 / +60 implementation lines [estimated]; the saving is three future copies not written. Covered by group.test.ts today; the helper gets its own contract tests (Test review).

### Section 3: Test review
Framework: `bun test` (package.json "test"), 16 test files, 194 passing at v1.
```
CODE PATHS (proposed unless marked)                          USER FLOWS
[+] pipeline/event.ts (D10)                                  [+] Re-sync mid-event
  ├── [GAP] path resolution per --event, default current       ├── [GAP] [→E2E] capture → hr sync → board: marks survive (D7)
  ├── [GAP] tracked-file guard: events/*/{captures,review,       ├── [GAP] page edit after Slack override → newer wins (D13)
  │         data,fixtures}/, events/*/config/organizers.json    └── [GAP] ambiguous window → both values, no winner (D13)
  └── [GAP] v1 board identical after move (regression)       [+] Build
[+] shared verify-and-retry helper (D2)                         ├── [GAP] type idea → ranked tracks, quote per track (D4/D6)
  ├── [★★★ TESTED] via groupOffers — group.test.ts (11)         ├── [GAP] API down → tracks unranked + reason (D6)
  └── [GAP] contract: check error fed back, retry cap,          ├── [GAP] POST /fit from wrong Origin / bad token → 403 (D6)
            refusal, API error                                   └── [GAP] select tracks → entry steps appear in Ship (D4)
[+] extension: thread capture (D5)                           [+] Now
  ├── [★★★ TESTED] accumulate ts dedupe — accumulate.test.ts    ├── [GAP] override shows page + Slack values (D8)
  ├── [GAP] open pane → scroll → record replies → close         ├── [GAP] ≥3 distinct hackers, unanswered → "N asked"; clears (D9)
  ├── [GAP] parent missing → reply kept + reported              └── [GAP] hacker post never in feed, never a value (D8/D9)
  └── [GAP] [→E2E] recall ≥ 0.9 vs export (494) — compare     [+] Meet / Ship / Claim
[+] extension: page snapshot (D3, D12)                          ├── [GAP] booth from quoted post; opener {first_name} local
  ├── [GAP] outline/tables/links captured; content hash         ├── [GAP] Ship item per submission rule + selected entry step
  ├── [GAP] access flag set in popup; missing → authenticated   └── [GAP] Claim unchanged vs v1 (regression)
  └── [GAP] iframe/PDF → "no text captured" reported
[+] pipeline/canon.ts
  ├── [GAP] quote exists verbatim (public) / in redacted text (authenticated, D12)
  ├── [GAP] numbers and dates in value appear in quote
  ├── [GAP] source-anchored id; tolerant re-match; ambiguous → orphan list (D7)
  └── [GAP] [→EVAL] extraction completeness vs Opus judge (E3)
[+] pipeline/live.ts
  ├── [GAP] kind hints cached by input hash
  └── [GAP] [→EVAL] link precision ≥ 0.95 on deadlines/times, recall ≥ 0.8
[+] pipeline/merge.ts (pure)
  ├── [GAP] authority: organizer any; sponsor-side own only; other → unauthorized (D8); name-only → "unverified poster" (D19)
  ├── [GAP] timeline: page window, Slack ts, latest wins, ambiguity (D13)
  └── [GAP] baseline kept; repeat collapses
[+] pipeline/fit.ts
  ├── [GAP] cited requirement verified in that track's sources
  ├── [GAP] cache hit by hash(idea + entities)
  └── [GAP] [→EVAL] fit ranking quality
[+] pipeline/roles.ts (existing, extended)
  └── [GAP] organizer by config display-name pattern / authority channel at a new event
COVERAGE: 2/41 paths tested (5%) | Code paths: 2/27 | User flows: 0/14   [counted from this diagram]
QUALITY: ★★★:2 | GAPS: 39 (3 E2E, 4 EVAL)
```
Every [GAP] row protects an approved behavior (D2–D13) and is required proof of that approval; each gets its test in the step that builds it. Value cards are in the Test Plan artifact.
Tests made obsolete: none (v1 tests move with their modules; paths change via event.ts).

Findings, most severe first:
- T1 `[CRITICAL] (confidence: 9/10)` §Eval Claim regression: no automated proof that v1's Claim board survives the move, the helper lift and threads → D14 accepted (fingerprint test).
- T2 `[INFORMATIONAL] (confidence: 7/10)` §Eval E3: the hand check conflicted with D21 → D15 accepted (Opus judge + model-free coverage checks).
- T3 `[INFORMATIONAL] (confidence: 8/10)` idea fit had no quality eval → D16 accepted (Devpost outcomes, Sonnet ranker), with a public-label precondition.
- Threshold for tolerant quote matching (D7): calibrated in step 2 on real re-extraction pairs (re-extract the Cal Hacks Devpost snapshot twice and from a re-capture); required proof of D7, no new policy.
Dispositions: T1 accepted (D14), T2 accepted (D15), T3 accepted (D16, precondition pending a probe).

### Section 4: Performance
Measured [export, locked 25]: 494 replies in 209 threads; the largest threads hold 30, 19, 12, 11 and 10 replies; median 2; the top 60 threads hold 286 replies (58%).
Other paths: entities and merge are small, pure, in-memory passes (dozens to hundreds of entities per event) [estimated]; the /fit cache grows by one entry per distinct idea; page snapshots are content-hashed, so an unchanged page costs no model call. No N+1 or unbounded query exists (no database).
Findings:
- P1 `[INFORMATIONAL] (confidence: 8/10)` §Sources "A per-run thread budget (default 60)": at the measured shape, one run at 60 captures 58% of fixture replies; the full Cal Hacks fixture needs 4 runs, or one uncapped run → D17.
Dispositions: P1 accepted (D17, with change-skip and kind-first ordering).

## Outside Voice (Claude Plan subagent, 2026-10-28; Codex not installed)
Read the plan body plus v1 code. 2 Critical, 5 High, 7 Medium, 7 Low, 1 strategic. Verified by the reviewer before disposition:
- roles.ts:59 `posterRole` marks organizer on `ORG_TAG` (display name) or `ORG_TITLE` (profile title): free-text fields any member sets [verified].
- board.ts:193 offer ids are positional (`o${i + 1}`), and board/index.html keys done state by them [verified].
- Devpost Cal Hacks headings: 2 h1, 8 h3, 4 h4, 11 h5, 48 h6 [measured 2026-10-28]; prize titles sit below h4.
- Devpost still reads "You must submit your hack by October 25th @ 9 AM PST" [measured 2026-10-28], so the outside voice's guess that the page shows 09:30 is refuted; the 09:00 page / 09:30 Slack fixture holds.
- `Rep.opener` exists in schema.ts but no module generates it [verified].

| # | Sev | Finding | Disposition |
|---|---|---|---|
| OV1 | Critical | Step-3 gate may be unmeetable: post-event snapshot; baseline position on the timeline unstated | Premise refuted (page still 09:00). Baseline position: already decided by D13 (the first snapshot is the baseline, not a change, so it sits before every Slack change). Residual, documented: a first snapshot that already reflects a later organizer edit can't be told apart from the original |
| OV2 | Critical | `Change` lacks entity_id, Slack post time; `from`/`status` set before merge | Accepted (D21): `Change {entity_id, field, to, kind}`, `SourceRef.posted_at`, merge computes `AppliedChange.from/status` |
| OV3 | High | Override authority spoofable via display name / title | D19 accepted: unspoofable signals only; restricted-posting channels proposed automatically, user confirms |
| OV4 | High | Incremental capture never re-shows older parent rows, so D17's skip rule can't see late replies | D20 accepted: 48 h lookback + permalink checks for older entity parents |
| OV5 | High | Unstable ids: prizes below h4; positional offer ids break done marks and D14 | Fixed as D7/D14 mechanism: outline h1–h6 with block order; offer id = first post's permalink ts (`o-<channel>-<ts>`); D14 fingerprint keyed by it; done marks migrate once from `o<n>` by matching v1's board.json |
| OV6 | High | No named live event; step 5 can pass with an empty board | D18 accepted: full brief, page half first, live-only behavior labeled; step 7 gated on D15 coverage checks |
| OV7 | High | "Capture first" gap | Fixed (mechanism of D5): step −1 also saves raw thread-pane DOM samples; if access is lost before step 1 ends, thread recall is reported "unmeasured" and downstream work uses the export's 494 replies |
| OV8 | Medium | Prize-sum gate ambiguous; number normalization unstated | D15 stands as the user wrote it (any nonzero gap fails; report lists unmatched figures). Normalization fixed: `$1k`, `$1,000`, `1000 USD` compare equal; spelled-out numbers aren't matched and are listed "unattached" |
| OV9 | Medium | 0.95 link precision meaningless on few cases | Fixed (reporting, no new policy): the eval prints n beside every rate; with n < 20 it lists each applied deadline/time change individually instead of a rate |
| OV10 | Medium | Entity list in classifier prompt invalidates the cache | Fixed: classifier gets entity kinds only; naming moves to the link pass, cached per message + candidate entities |
| OV11 | Medium | Meet opener has no owner or check | Fixed: owned by live.ts, verified against the rep's post (§Views Meet) |
| OV12 | Medium | Idea fit is heavy for one text box | User decisions D4, D6, D16 stand (custom answers); not re-asked |
| OV13 | Medium | Raw hash flags counters as canon changes | Fixed: hash normalized outline text; only changed extracted fields show in Now |
| OV14 | Medium | Uncapped fixture capture looks bot-like | Fixed within D17: paced at the measured ~3 s per thread, stops on any Slack error or rate-limit banner, reports where it stopped; rerun resumes |
| Low | Low | Premise 4 vs D15; E4 dangling; "DRAFT" header; role names; `events/current`; `last-modified`; view estimates | Fixed in the body; `events/current` is gitignored (local pointer); estimates already tagged [estimated] |

## Decision ledger

### R-F1: where schedule canon comes from
Finding: F1, CRITICAL, 9/10, §Sources / step 1, reviewer plan-eng-review (Claude)
Plan baseline: original proposal: "event site: schedule" is canon; step 1 gate "Devpost and event site snapshots captured for Cal Hacks".
Runtime evidence: calhacks.io serves 1,817 words, none of them a schedule [measured: curl 2026-10-28]; Hive "Live Site" not probed (unknown).
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R-F1 schedule canon source | "the event site" | any page config lists as `schedule_pages` (e.g. Hive), snapshotted by the extension in the user's own logged-in tab; none listed → schedule is Slack-only (`origin: "slack"`) | Slack-only schedule; no page path | unchanged |
| Cal Hacks step-1 gate | event site snapshot | Devpost snapshot + a Hive snapshot if the user can still open it; otherwise schedule fixture = Slack + `config/event.json`'s 4 sourced entries, and schedule-from-page is proven at step 5 | Devpost only | unchanged (unmeetable) |
| Other pending choices (F2, F3, E1–E8) | pending | pending | pending | pending |
Question D3:
D3 — Where does the schedule's canon come from, given calhacks.io has none?
Project/branch/task: hackrecon v2 design doc, branch v2, Sources step.
ELI10: The plan treats "the event site" as the official schedule, but calhacks.io only says the schedule will be sent closer to the event. Devpost links a "Live Site" on Hive, which is probably login-only. The extension reads whatever page you have open, logins included, so it can snapshot Hive the same way as Devpost. The question is whether schedule canon becomes "whatever schedule page the event config lists" or whether the schedule comes from Slack only.
Stakes if we pick wrong: Keep the plan as written, and step 1's exit gate can never pass for Cal Hacks. Go Slack-only, and the Now view can never show "page said X, Slack changed it to Y" for times and rooms.
Recommendation: A) Config-listed schedule pages, because it keeps the canon-vs-live rule for the schedule at events that publish one, costs one config field, and falls back to Slack honestly when none exists.
Completeness: A=9/10, B=6/10, C=3/10
Pros / cons:
A) Config-listed schedule pages (recommended)
  ✅ Works for login-gated live sites such as Hive, because the snapshot runs in the user's own tab
  ✅ No schedule page means Slack-only items labeled "from Slack", never an empty canon presented as complete
  ❌ The page path can't be proven on Cal Hacks unless Hive still opens; proof may slip to step 5 (human: ~0.5 day / CC: ~20 min)
B) Slack-only schedule
  ✅ The smallest build: no schedule extraction from pages at all
  ✅ Matches where Cal Hacks' schedule changes were actually announced (0-announcements)
  ❌ Loses the canon-vs-live comparison for times and rooms at every future event that does publish a schedule
C) Keep as written
  ✅ No doc change
  ❌ The step-1 gate is unmeetable for the only fixture event
Net: one config field and a fallback, versus giving up schedule canon everywhere.
Header: Schedule src
Options:
A) Config schedule pages (recommended)
Schedule canon = pages listed in event.json `schedule_pages`, snapshotted by the extension in the user's tab (logins work). None listed → schedule items are Slack-only, labeled "from Slack". Cal Hacks gate: Devpost + Hive snapshot if it still opens, else Slack + event.json's 4 sourced entries, with schedule-from-page proven at step 5. (human: ~0.5 day / CC: ~20 min)
B) Slack-only schedule
Drop schedule extraction from pages. Every schedule item comes from Slack (and event.json's sourced entries). Now never shows a page-vs-Slack pair for times or rooms.
C) Keep as written
Leave "event site: schedule" and the step-1 gate unchanged.

State: approved
Actual answer: A) Config schedule pages (recommended) — user, D3, 2026-10-28
Accepted scope: Schedule canon = pages listed in event.json `schedule_pages`, snapshotted by the extension in the user's tab (logins work). None listed → schedule items are Slack-only, labeled "from Slack". Cal Hacks gate: Devpost + Hive snapshot if it still opens, else Slack + event.json's 4 sourced entries, with schedule-from-page proven at step 5.
History: none

### R-F2: what the track stacker shows when stacking rules aren't stated
Finding: F2, INFORMATIONAL, 8/10, §Views Build, reviewer plan-eng-review (Claude)
Plan baseline: original proposal: pick tracks → "whether the set is allowed under the stated stacking rules"; unstated pairs say "Rules don't say. Ask in #help."; E8 (no default) pending.
Runtime evidence: Devpost Cal Hacks page states no general stacking rule; it states per-prize entry steps ("opt into the Commit Fellowship Prize Category … submit this supplemental form"; "indicate which track … you are submitting for") [measured: curl 2026-10-28].
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-F2 stacker's main output | "allowed together?" per pair | per selected track: stated requirements, criteria, stated prize, and stated entry steps (opt-ins, forms, "say which track"); one line on stacking: the stated rule, or "Rules don't say whether these stack" | "allowed together?" per pair, "rules don't say" per unstated pair |
| Entry steps in Ship | not in plan | each stated entry step for the selected tracks becomes a Ship checklist item with its quote | not added |
| E8 default when unstated | pending | resolved: no default (never "yes") | resolved: no default (never "yes") |
| Other pending choices (F3, E1–E7) | pending | pending | pending |
Question D4:
D4 — What should the track stacker show when the rules don't say whether prizes stack?
Project/branch/task: hackrecon v2 design doc, branch v2, Build view.
ELI10: The stacker was going to answer "can I enter these prizes together?" But Cal Hacks' Devpost never says, so it would print "rules don't say" for every pair. What the page does state is how to enter each prize: opt in when you submit, fill a supplemental form, name the track in your description. Missing one of those is how teams lose a prize they qualified for.
Stakes if we pick wrong: A stacker that says "rules don't say" everywhere is noise, and the entry steps that actually decide eligibility stay buried in the page.
Recommendation: A) Lead with stated entry steps, because those are on the page, they're the thing teams miss, and they feed Ship directly. Neither option ever assumes two prizes stack.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Lead with stated entry steps (recommended)
  ✅ Shows what Devpost actually states per prize: requirements, criteria, opt-ins, forms, "say which track"
  ✅ Each entry step becomes a quoted Ship checklist item, so the opt-in isn't forgotten at submit time
  ❌ The "can these stack?" answer shrinks to one line, which may feel less like a stacker (human: ~0.5 day / CC: ~15 min)
B) Keep pairwise "allowed?"
  ✅ Matches the brief's word "stacker" literally, with a yes/no/unknown per pair
  ✅ Becomes useful at events whose rules do state stacking limits
  ❌ At Cal Hacks every pair says "rules don't say", and entry steps aren't surfaced anywhere
Net: lead with what the page states and teams miss, versus a pairwise grid that's empty at the fixture.
Header: Stacker
Options:
A) Lead with entry steps (recommended)
Per selected track: stated requirements, criteria, stated prize, and stated entry steps (opt-ins, forms, "say which track"), each quoted. One line on stacking: the stated rule, or "Rules don't say whether these stack." Entry steps become Ship items. No default; never assume yes. (human: ~0.5 day / CC: ~15 min)
B) Keep pairwise allowed?
Keep the per-pair "allowed together?" grid, with "Rules don't say. Ask in #help." for unstated pairs. Entry steps aren't added to Ship. No default; never assume yes.

State: approved
Actual answer: Other (user, D4, 2026-10-28): "Keep the idea-fit half of the stacker: the user describes their project in a sentence, and Build ranks tracks by how well the idea matches each track's stated requirements and criteria, with the matching requirement quoted per track ("likely fits: uses an LLM agent → Microsoft challenge"). Fit is a suggestion with evidence, never a guarantee. Selecting tracks adds their entry steps to Ship."
Accepted scope: Build: the user types a one-sentence project idea; tracks are ranked by fit to each track's stated requirements and criteria, each with the matching requirement quoted; worded as a suggestion ("likely fits"), never a guarantee. Selecting tracks adds each track's stated entry steps (opt-ins, forms, "say which track"), quoted, to Ship. The pairwise "allowed together?" grid is removed; stated stacking limits, where a page has one, show as ordinary quoted rule entities. E8 is moot (no pairwise answer exists to default). New data flow (the idea text goes to a model) is reviewed in Section 1.
History: none

### R-F3: capture the at-risk Cal Hacks data before building
Finding: F3, CRITICAL, 8/10, TODOS.md:39-45, reviewer plan-eng-review (Claude)
Plan baseline: original proposal: step 0 (layout migration) first, then step 1 builds thread capture and captures Cal Hacks threads; the 29 stretch channels aren't mentioned.
Runtime evidence: TODOS.md: "Access to the workspace may be revoked at any time, so do this before anything else post-demo"; 26 capture files exist, i.e. the locked 25 (+1) top-level only [measured: ls captures/]. Workspace access today: unknown.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-F3 first work item | step 0 layout migration | step −1 "capture first": with the existing v1 extension, capture the 29 stretch channels top-level now (no code needed, about 1 hour), record with `hr record-run`; thread capture for the locked 25 runs as the first build of step 1, before any other step-1 work | unchanged; stretch channels stay a TODO |
| Order of thread capture within step 1 | unspecified | first, before incremental capture and page snapshots | unspecified |
| Other pending choices (E1–E7) | pending | pending | pending |
Question D5:
D5 — Capture the at-risk Cal Hacks Slack data before any v2 code work?
Project/branch/task: hackrecon v2 design doc, branch v2, build order.
ELI10: v2 is developed against Cal Hacks' Slack, but your access to that workspace can be revoked at any time. 29 sponsor channels were never captured, and no thread replies were. The v1 extension can capture the 29 channels today with no new code, in about an hour. Thread capture needs new code, so it should be the very first thing built in step 1. Otherwise v2's thread recall and reps work could lose its only fixture mid-build.
Stakes if we pick wrong: If access goes before capture, v2 loses the thread fixture (494 replies) and the reps for 29 sponsors, and the thread-recall gate can't be measured at all.
Recommendation: A) Capture first, because it's an hour with existing tools, and losing the fixture would cost far more than the reorder.
Completeness: A=10/10, B=5/10
Pros / cons:
A) Capture first (recommended)
  ✅ Locks in the 29 stretch channels today with the v1 extension, no code (human: ~1h / CC: n/a, it's clicks)
  ✅ Builds thread capture first in step 1, so the 494 replies are saved before anything else is built
  ❌ Delays the layout migration (step 0) by about an hour plus the thread-capture build
B) Keep the order
  ✅ The build order stays exactly as the brief lists it
  ✅ The capture work happens anyway, just later in step 1
  ❌ A revoked workspace before step 1 means no thread fixture and no reps for 29 sponsors, permanently
Net: an hour now versus betting the only fixture on workspace access lasting.
Header: Capture 1st
Options:
A) Capture first (recommended)
New step −1: capture the 29 stretch channels top-level with the existing extension now and record them with `hr record-run`. In step 1, thread capture for the locked 25 is built and run first, before incremental capture and page snapshots. (human: ~1h + thread build)
B) Keep the order
Step 0 then step 1 as written; the 29 stretch channels stay a TODO; thread capture has no fixed position in step 1.

State: approved
Actual answer: A) Capture first (recommended) — user, D5, 2026-10-28
Accepted scope: New step −1: capture the 29 stretch channels top-level with the existing extension now and record them with `hr record-run`. In step 1, thread capture for the locked 25 is built and run first, before incremental capture and page snapshots.
History: none

### R-A1: how the idea text reaches a model (idea fit, D4)
Finding: A1, CRITICAL, 9/10, §Views Build + pipeline/hr.ts board route (GET-only, CSP `default-src 'none'`), reviewer plan-eng-review (Claude)
Plan baseline: D4 approved idea fit; no mechanism specified.
Runtime evidence: `hr board` serves the page, data/board.json and fonts on 127.0.0.1, GET only [static read: pipeline/hr.ts]. The board makes no network calls beyond that.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-A1 idea-fit mechanism | none | `hr board` adds `POST /fit` on 127.0.0.1: checks the Origin header equals the board's own origin and a per-run token embedded in the page; sends the idea plus track/criterion entities (quotes only) to Opus; verifies each quoted requirement exists in that track's sources (shared verify helper); caches by hash of idea + entities | `hr fit "<idea>"` CLI writes `events/<slug>/data/fit.json`; the board shows the ranking after a reload |
| What leaves the machine | captured Slack text (redacted), page text | + the typed idea sentence | + the typed idea sentence |
| API down / no key | n/a | Build shows tracks unranked with "Couldn't rank: <reason>" | the CLI prints the error; Build shows no ranking |
| Other pending choices (A2–A6) | pending | pending | pending |
Question D6:
D6 — How should the idea you type in Build reach the model that ranks tracks?
Project/branch/task: hackrecon v2 design doc, branch v2, Build view (idea fit from D4).
ELI10: Idea fit needs a model to read your sentence next to each track's requirements. The board is a local page with no server logic, so something has to make that call. Option A adds one endpoint to the local board server. It only accepts requests from the board's own page carrying a secret token, so another website open in your browser can't use your API key. Option B makes it a terminal command whose result shows up when you reload the board.
Stakes if we pick wrong: An unguarded local endpoint would let any web page you visit spend your API credits. A CLI-only path makes idea fit a context switch nobody uses mid-hackathon.
Recommendation: A) Local endpoint with Origin and token checks, because idea fit only helps if it's one text box away, and the two checks close the localhost hole.
Completeness: A=9/10, B=7/10
Pros / cons:
A) Local endpoint, guarded (recommended)
  ✅ Type a sentence in Build and see ranked tracks in place; reruns of the same idea come from the cache
  ✅ The Origin check plus a per-run token stop other sites in your browser from calling it with your key
  ❌ The board server gains its first POST route and its first model call (human: ~1 day / CC: ~30 min)
B) CLI `hr fit`
  ✅ The board stays static and GET-only, with no new attack surface
  ✅ It reuses the CLI pattern every other model step already uses
  ❌ Means a terminal round trip and a reload for each idea, which is clumsy while brainstorming
Net: an in-page box with two guards versus keeping the board static at the cost of a clumsy loop.
Header: Idea fit
Options:
A) Local endpoint, guarded (recommended)
`hr board` adds POST /fit on 127.0.0.1, accepted only with the board's own Origin and a per-run page token. It sends the idea plus track and criterion quotes to Opus, verifies each cited requirement exists in that track's sources, and caches by input hash. On API failure Build shows tracks unranked with the reason. The idea sentence is added to what leaves the machine. (human: ~1 day / CC: ~30 min)
B) CLI hr fit
`hr fit "<idea>"` writes events/<slug>/data/fit.json with the same verification; the board shows the ranking after a reload. The board stays GET-only. The idea sentence is added to what leaves the machine.

State: approved
Actual answer: A) Local endpoint, guarded (recommended) — user, D6, 2026-10-28
Accepted scope: `hr board` adds POST /fit on 127.0.0.1, accepted only with the board's own Origin and a per-run page token. It sends the idea plus track and criterion quotes to the ranker model (Sonnet, `claude-sonnet-5-5`, per the user's D16 amendment), verifies each cited requirement exists in that track's sources, and caches by input hash. On API failure Build shows tracks unranked with the reason. The idea sentence is added to what leaves the machine.
History: D6 answer A (2026-10-28) named Opus as the ranker; the user's D16 answer set Sonnet for ranking.

### R-A2: entity ids that survive re-extraction
Finding: A2, INFORMATIONAL, 8/10, §Entities `id: string; // stable: kind + slug of canonical name + sponsor`, reviewer plan-eng-review (Claude)
Plan baseline: original proposal: id = kind + slug of the model-chosen canonical name + sponsor.
Runtime evidence: v1 offers use positional ids (`o${i + 1}`, pipeline/board.ts:193), and done state is keyed by id in localStorage (`hackrecon:done:<event>`); v1 is unaffected because it never re-extracts mid-event. Re-extraction behavior of v2: unknown (not built).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-A2 id scheme | kind + slug(model name) + sponsor | page entities: kind + canonical page URL + heading path of the quoted span; Slack-origin entities: kind + permalink of the first post; on re-extraction an entity whose anchor moved keeps its old id when its quote matches; any done/selected id with no entity left is listed in the drawer as "no longer on the page", never dropped silently | as written |
| v1 Claim offer ids | positional `o<n>` | unchanged (Claim keeps v1 grouping, rebuilt only by `hr group`) | unchanged |
| Other pending choices (A3–A6) | pending | pending | pending |
Question D7:
D7 — What should an entity's id be built from, so marks survive a re-run?
Project/branch/task: hackrecon v2 design doc, branch v2, Entities.
ELI10: Every track, rule and deadline gets an id, and your done checks and Build picks are saved against that id. The plan builds the id from the name the model chooses. If the model calls "Best Use of Apify" "Best Apify Actor" on the next run, that's a new id, and your check mark silently disappears. Option A builds the id from where the fact sits on the page (URL plus heading), keeps the old id when the same quote moves, and lists any orphaned marks instead of dropping them.
Stakes if we pick wrong: Mid-hackathon re-syncs could quietly clear checklist items you already finished, or bring back Ship items you dismissed.
Recommendation: A) Source-anchored ids, because the page position and quote are facts, while the model's wording isn't stable between runs.
Completeness: A=9/10, B=5/10
Pros / cons:
A) Source-anchored ids (recommended)
  ✅ Done marks and Build picks survive model rewording, because the id comes from the page position, not the name
  ✅ A mark whose entity is gone shows as "no longer on the page" instead of vanishing
  ❌ Needs a quote-match step on every re-run, plus tests for moved headings (human: ~0.5 day / CC: ~20 min)
B) Name-based ids
  ✅ Simple and readable ids, with nothing extra to build
  ✅ Fine as long as each event is extracted only once
  ❌ Any rewording by the model on a re-sync orphans marks silently, which breaks the live re-sync loop v2 exists for
Net: half a day of matching code versus silent loss of user state on every re-sync.
Header: Entity ids
Options:
A) Source-anchored ids (recommended)
Page entity id = kind + canonical URL + heading path of its quote; Slack-origin id = kind + first post's permalink. A re-extracted entity whose anchor moved keeps its id when its quote matches. Done or selected ids with no entity left are listed as "no longer on the page", never dropped. v1 Claim ids unchanged. (human: ~0.5 day / CC: ~20 min)
B) Name-based ids
Keep id = kind + slug of the model's canonical name + sponsor. v1 Claim ids unchanged.

State: approved
Actual answer: A) Source-anchored ids (recommended) — user, D7, 2026-10-28
Accepted scope: Page entity id = kind + canonical URL + heading path of its quote; Slack-origin id = kind + first post's permalink. A re-extracted entity whose anchor moved keeps its id when its quote matches, using tolerant matching (user amendment, D8 answer): quotes are normalized for whitespace, case and punctuation, and a moved or lightly edited quote is accepted above a similarity threshold. Below the threshold, or when two candidates match (ambiguous), the mark is listed as "no longer on the page" rather than guessed. A mark is never attached to the wrong entity. Done or selected ids with no entity left are listed, never dropped. v1 Claim ids unchanged. The threshold value is not yet set: it is calibrated in step 2 on real re-extraction pairs (see Test review).
History: D7 answer A (2026-10-28) accepted "keeps its id when its quote matches"; amended by the user's D8 answer to tolerant matching with an ambiguity rule.

### R-A3: who may override canon from Slack
Finding: A3, INFORMATIONAL, 7/10, §Premises 2 + §Merge step 3 + E6, reviewer plan-eng-review (Claude)
Plan baseline: original proposal (Premise 2): organizers override any event entity; a sponsor-side poster overrides only their own sponsor's Track, Prize, Offer or Booth; hackers never. The brief says only "Slack updates override with both shown".
Runtime evidence: `posterRole()` returns organizer | sponsor-side | other (pipeline/roles.ts:10,59); organizer ids come from the export-built config/organizers.json (roles.ts:34), which a new event won't have.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R-A3 override authority | Premise 2 (proposal) | organizer → any entity; sponsor-side → only its own sponsor's track, prize, offer, booth; anyone else → never (kept in history as `unauthorized`) | organizers only; sponsor-side posts never override | any Slack post overrides (brief literal) |
| Display of every override | page and Slack values both shown | unchanged | unchanged | unchanged |
| Unresolved role at a new event | "hacker" | "hacker" (cannot override) | "hacker" | n/a |
| R-A4 hacker questions in Now | pending | pending | pending | pending |
| Other pending choices (A5–A7) | pending | pending | pending | pending |
Question D8:
D8 — Whose Slack posts are allowed to override what the official pages say?
Project/branch/task: hackrecon v2 design doc, branch v2, Merge rule.
ELI10: Your brief says Slack updates override the page, with both values shown. But anyone can post in Slack, including a hacker guessing that "the deadline's probably 9:30". The plan only lets organizers change anything, and lets a sponsor's own people change only their sponsor's prize, offer or booth. Everyone else's posts are kept in the history but never become the shown value. Unknown posters at a new event count as "can't override".
Stakes if we pick wrong: Too loose, and one wrong hacker post moves a deadline on your screen. Too strict (organizers only), and a sponsor rep's "we extended our challenge deadline" never shows.
Recommendation: A) Organizers anything, sponsor-side only their own, because it lets the two roles that own these facts change them, while a hacker post can never move a value. (No count of sponsor-side changes at Cal Hacks has been measured yet.)
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Organizers + own-sponsor (recommended)
  ✅ Covers both kinds of change the plan expects: organizer schedule moves and a sponsor amending its own prize or offer
  ✅ Unknown or hacker posters can't change a value; their posts stay visible in history as "unauthorized"
  ❌ Needs sponsor matching between Slack channels and Devpost prize names (aliases in sponsors.json)
B) Organizers only
  ✅ The simplest rule, needing no sponsor matching at all
  ✅ Lowest chance of a false override
  ❌ A sponsor rep's own deadline extension or prize change would never show as the current value
C) Any Slack post
  ✅ The literal reading of the brief, with no role logic
  ✅ Nothing a real organizer posts is missed because of a role miss
  ❌ One hacker guess moves a deadline on screen, which breaks the override precision gate
Net: the role rule trades a sponsor-matching table for never letting a guess move a value.
Header: Authority
Options:
A) Organizers + own sponsor (recommended)
Organizers override any entity; a sponsor-side poster overrides only their own sponsor's track, prize, offer or booth; anyone else never (kept in history as "unauthorized"). Unresolved roles at a new event count as "can't override". Both values are always shown.
B) Organizers only
Only organizer posts override; sponsor-side and everyone else are history only. Both values are always shown.
C) Any Slack post
Every Slack post that changes a field overrides it, whoever posted it. Both values are always shown.

State: approved
Actual answer: A — user, D8, 2026-10-28, verbatim: "Option A, with tolerant matching: normalize quotes (whitespace, case, punctuation) and accept a moved or lightly edited quote above a similarity threshold. Below the threshold or ambiguous (two candidates), list the mark as “no longer on the page” rather than guessing. Never attach a mark to the wrong entity." The tolerant-matching sentences concern quote matching on re-extraction and are applied to R-A2 (D7) as a user amendment.
Accepted scope: Organizers override any entity; a sponsor-side poster overrides only their own sponsor's track, prize, offer or booth; anyone else never (kept in history as "unauthorized"). Unresolved roles at a new event count as "can't override". Both values are always shown.
History: none

### R-A4: hacker questions in the Now view
Finding: A3 (second choice), INFORMATIONAL, 7/10, §Premises 2 "It can raise a question" + E6, reviewer plan-eng-review (Claude)
Plan baseline: original proposal: a hacker's post "can raise a question … but can't change a value"; E6 asks whether it shows in Now as "unconfirmed". D8 approved: hackers never override.
Runtime evidence: D24 (demo-scope.md:1917) hides author names and shows post text as evidence; no v1 surface shows hacker posts that aren't offers.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-A4 hacker posts about a canon field | "raise a question" (undefined display) | kept in the entity's history as `unauthorized`/`question`, visible in its drawer only; never in the Now feed | shown in the Now feed as "Unconfirmed: a hacker asked …" with the redacted excerpt (D24), next to the entity |
| R-A3 authority | approved D8 | unchanged | unchanged |
| Other pending choices (A5–A7) | pending | pending | pending |
Question D9:
D9 — Should hackers' questions about a deadline or rule show up in the Now feed?
Project/branch/task: hackrecon v2 design doc, branch v2, Now view.
ELI10: Hackers often ask in Slack, "is the deadline 9 or 9:30?" D8 already settled that such posts can never change a value. The question here is only whether they appear in the live Now feed as "unconfirmed", or stay tucked in that deadline's history drawer. Shown, they can flag confusion early. But they're noisy, and they put other hackers' words on your screen.
Stakes if we pick wrong: Shown, Now fills with guesses next to real changes. Hidden, an early sign that a rule is confusing is one click deeper.
Recommendation: A) History drawer only, because Now should list changes you can act on, and the official answer arrives as an organizer post anyway.
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Drawer only (recommended)
  ✅ Now shows only real changes from people allowed to make them, so it stays readable mid-hackathon
  ✅ Hacker text appears only one click into an entity's history, with names hidden (D24)
  ❌ An early signal that a rule is confusing is less visible
B) Show in Now as unconfirmed
  ✅ Surfaces confusion early, e.g. many people asking about the same deadline
  ✅ Shows that a question is open before an organizer answers it
  ❌ Puts other hackers' guesses in the main feed next to real changes, adding noise and more of their words on screen
Net: a clean feed of authorized changes versus an early but noisy confusion signal.
Header: Questions
Options:
A) Drawer only (recommended)
Hacker posts about a canon field are kept in that entity's history (status "question" or "unauthorized") and appear only in its drawer, author names hidden. They never appear in the Now feed.
B) Show in Now
Hacker questions about a canon field appear in the Now feed as "Unconfirmed: a hacker asked …" with the redacted excerpt next to the entity, author names hidden. They never change a value.

State: approved
Actual answer: A plus an aggregate signal — user, D9, 2026-10-28, verbatim: "ption A, plus an aggregate signal: when ≥3 distinct hackers ask about the same canon field and no organizer has answered, show a small muted “3 asked” marker on that entity (no hacker text, no names). It clears when an authorized post answers. Questions never appear in the Now feed and never change a value."
Accepted scope: Hacker posts about a canon field are kept in that entity's history (status "question" or "unauthorized") and appear only in its drawer, author names hidden; never in the Now feed; never change a value. Plus: when ≥ 3 distinct hackers have asked about the same canon field and no authorized post has answered it, the entity shows a small muted "N asked" marker (mono, muted, per DESIGN.md metadata rule) with no hacker text and no names. The marker clears when an authorized post (D8) answers that field.
History: none

### R-A5: when per-event paths arrive (E2)
Finding: A5, INFORMATIONAL, 7/10, §Per-event config "*Open (E2)*" and §Build order step 0, reviewer plan-eng-review (Claude)
Plan baseline: original proposal: step 0 introduces `events/<slug>/` and `--event` before sources; the brief orders "generalize" last. D2 approved `pipeline/event.ts` as the owner of every path; D5 approved step −1 (capture first).
Runtime evidence: 14 path constants + 8 `config/sponsors.json` defaults across 9 modules [measured: grep pipeline/*.ts, 2026-10-28].
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-A5 timing of the per-event layout | step 0 (proposal) | step 0, right after step −1: create pipeline/event.ts, move every path behind it, add `--event` (default `events/current`), move Cal Hacks config with `git mv` and its gitignored data with a move; v1 board must render identically | at step 5 (generalize), as the brief orders; steps 1–4 add new paths under the current flat layout |
| R-A5 regression proof | n/a | `bun test` green and `hr board --build-only` output identical to before the move apart from `basis.written_at` | same check, at step 5 |
| Other pending choices (A6–A7) | pending | pending | pending |
Question D10:
D10 — Move to per-event folders first (step 0), or at the end as your build order says?
Project/branch/task: hackrecon v2 design doc, branch v2, build order.
ELI10: Today 9 files each hard-code where data lives (`data/`, `review/`, `config/`). Every v2 step adds more files of its own. Moving everything under `events/<slug>/` first means each new file is written per event from day one. Moving it last, as your build order says, means migrating v1's paths plus every new v2 path at the end.
Stakes if we pick wrong: Doing it last turns a half-day move into a migration across more paths (v1's 22 plus every v2 addition [estimated]), right before the dry run that's supposed to prove it works.
Recommendation: A) Step 0, because the move is smallest now, and D2 already made event.ts the single owner of paths.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Step 0, before sources (recommended)
  ✅ Every new v2 file is per event from the start; the generalize step only adds a second event
  ✅ The proof is cheap: tests green and the v1 board's JSON identical after the move (apart from its timestamp)
  ❌ Puts half a day of plumbing before visible v2 features (human: ~0.5 day / CC: ~20 min)
B) At generalize (brief order)
  ✅ Follows your build order to the letter, with features appearing sooner
  ✅ The layout can be designed knowing every path v2 ended up needing
  ❌ The migration grows with every step, and a missed path surfaces only at the second-event dry run
Net: half a day now versus a bigger migration at the end.
Header: Paths
Options:
A) Step 0 (recommended)
Right after step −1: create pipeline/event.ts, move every path behind it, add `--event` (default events/current), git mv Cal Hacks config, move its gitignored data. Proof: bun test green and `hr board --build-only` output identical apart from `basis.written_at`. (human: ~0.5 day / CC: ~20 min)
B) At generalize
Steps 1–4 add paths under today's flat layout; event.ts and the move happen at step 5 with the same proof.

State: approved
Actual answer: A plus gitignore safeguards — user, D10, 2026-10-28, verbatim: "Option A. Update .gitignore to cover the per-event layout (e.g. events/*/captures/, events/*/review/, events/*/data/, events/*/config/organizers.json, events/*/fixtures/) before moving any files, and add a test that fails if any of those paths is tracked by git. After the move, show me git status --short so I can confirm nothing sensitive is staged."
Accepted scope: Step 0, right after step −1. Order: (1) update .gitignore to cover `events/*/captures/`, `events/*/review/`, `events/*/data/`, `events/*/config/organizers.json`, `events/*/fixtures/` before moving any file; (2) add a test that fails if any path matching those patterns is tracked by git (`git ls-files`); (3) create pipeline/event.ts, move every path behind it, add `--event` (default events/current), git mv the tracked Cal Hacks config (event.json, sponsors.json), move its gitignored data; (4) proof: bun test green and `hr board --build-only` output identical apart from `basis.written_at`; (5) show the user `git status --short` after the move so they confirm nothing sensitive is staged.
History: none

### R-A6: second fetch path for public pages (E1)
Finding: A6, INFORMATIONAL, 6/10, §Sources "*Open (E1)*", reviewer plan-eng-review (Claude)
Plan baseline: original proposal: extension-only page capture ("Capture this page"); `hr fetch <url>` considered and not recommended.
Runtime evidence: Devpost and calhacks.io serve their text as plain HTML, so a plain HTTP fetch would work for them [measured: curl 2026-10-28]; a login-gated live site (Hive) would not (D3 relies on the extension for it).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-A6 page capture paths | extension only (proposal) | extension only; `hr fetch` added to TODOS with the trigger "re-capturing canon by click is the bottleneck at a live event" | extension + `hr fetch <url>` for public pages, same snapshot schema and content hash, one request per URL per run, a descriptive User-Agent, honors robots.txt |
| Other pending choices (A7) | pending | pending | pending |
Question D11:
D11 — Add a terminal command that fetches public pages, besides the extension button?
Project/branch/task: hackrecon v2 design doc, branch v2, Sources.
ELI10: Canon pages (Devpost, the event site) get snapshotted by clicking "Capture this page" in the extension. Devpost and calhacks.io serve plain HTML, so a terminal command could also fetch them during each sync without a click. But that's a second way to make the same snapshot, with its own rules for fetching politely, and login-gated pages still need the extension.
Stakes if we pick wrong: Extension-only means you might forget to re-capture Devpost when it changes mid-event. Two paths means two snapshot producers that can drift apart.
Recommendation: A) Extension only for v2, because one snapshot producer is simpler to test, and a live event will show whether the click is really the bottleneck.
Completeness: A=8/10, B=9/10
Pros / cons:
A) Extension only (recommended)
  ✅ One snapshot producer, one schema test, and the same "read what your browser shows" rule everywhere
  ✅ Works for login-gated pages too, which a terminal fetch can't
  ❌ Re-capturing canon needs a click per page, so a mid-event Devpost edit is caught only when you re-capture
B) Extension + hr fetch
  ✅ `hr sync` can refresh public canon pages with no click, catching Devpost edits automatically
  ✅ Reuses the same snapshot schema and content hash, so merge doesn't change
  ❌ A second producer with politeness rules (robots.txt, User-Agent, one request per URL per run) to build and test (human: ~1 day / CC: ~30 min)
Net: one producer and a click, versus automatic public refresh with a second code path.
Header: hr fetch
Options:
A) Extension only (recommended)
Page snapshots come only from the extension's "Capture this page". `hr fetch` goes to TODOS with the trigger "re-capturing canon by click is the bottleneck at a live event".
B) Extension + hr fetch
Add `hr fetch <url>` for public pages, writing the same snapshot schema and content hash; one request per URL per run, a descriptive User-Agent, honors robots.txt. Login-gated pages stay extension-only. (human: ~1 day / CC: ~30 min)

State: approved
Actual answer: A) Extension only (recommended) — user, D11, 2026-10-28
Accepted scope: Page snapshots come only from the extension's "Capture this page". `hr fetch` goes to TODOS with the trigger "re-capturing canon by click is the bottleneck at a live event".
History: reversed by the user, 2026-11-06: "Reverse D11: public pages are fetched automatically, not captured by hand." Public pages are fetched by `hr sync` (one request per URL per sync, honest User-Agent, robots.txt respected); the extension reads only pages that need the user's login. See §1 Sources.

### R-A7: redaction of public page text (E5)
Finding: A7, INFORMATIONAL, 6/10, §Constraints "Public page text is sent unredacted … (decision E5)", reviewer plan-eng-review (Claude)
Plan baseline: original proposal: page text goes to the API unredacted; Slack text keeps v1 redaction.
Runtime evidence: the v1 redactor builds its name list from Slack author names and skips sponsor words (pipeline/redact.ts:39-46). Devpost pages can name people (e.g. judges); the Cal Hacks page names only a mascot ("Judges … DDoSKi & his not-so judgy buddies") [measured: curl 2026-10-28]. How the redactor would treat page text is untested.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-A7 page text to the API | unredacted (proposal) | unredacted; quotes shown on the board are the page's own words; no Slack author names are added to page prompts | through the Slack redactor (names of Slack authors found on the page become `[person]`) |
| Slack text to the API | redacted (v1) | unchanged | unchanged |
| Other pending choices | none after this | none | none |
Question D12:
D12 — Should public page text (Devpost, the event site) be redacted before it goes to the model?
Project/branch/task: hackrecon v2 design doc, branch v2, privacy constraint.
ELI10: Slack text has people's names removed before it goes to the API, because hackers never agreed to that. Devpost and event pages are published by the organizer for everyone to read. Running them through the same redactor would turn any name that also appears in Slack into "[person]" inside rules and prize text. The quotes the board shows would then no longer match the page word for word.
Stakes if we pick wrong: Redact, and quote checks against the page start failing or showing "[person]" in official rules. Don't redact, and public names on Devpost reach the API, the same way they reach anyone who opens the page.
Recommendation: A) Unredacted, because the organizer published this text for anyone to read, and the quote checks need the page's exact words.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Unredacted (recommended)
  ✅ Quotes stay word for word with the page, so the "quote exists in source" check is exact
  ✅ Only text the organizer chose to publish goes out; Slack stays redacted as in v1
  ❌ Names printed on public pages (e.g. judges, where listed) reach the API
B) Through the Slack redactor
  ✅ One uniform rule: every name the tool knows is redacted, wherever it appears
  ✅ Names of people who also post in Slack never reach the API, from any source
  ❌ Quote checks must map "[person]" back to the page, and official rule text can show "[person]" where a judge was named
Net: exact quotes from public text versus one uniform redaction rule that bends official wording.
Header: Page text
Options:
A) Unredacted (recommended)
Page snapshots go to the API as published; board quotes are the page's own words. Slack text stays redacted as in v1, and no Slack author names are added to page prompts.
B) Through the redactor
Page text runs through the v1 Slack redactor before the API; names of Slack authors found on the page become "[person]", and quote checks map them back.

State: approved
Actual answer: A for public pages only — user, D12, 2026-10-28, verbatim: "Option A for public, unauthenticated pages only (anyone can open them without logging in). Pages captured from a logged-in session (e.g. Hive) are treated like Slack: redacted before the API, with quote checks against the redacted text. The snapshot records whether the page was public or authenticated, and that flag decides redaction — never the domain."
Accepted scope: Every page snapshot records `access: "public" | "authenticated"`. Public (opens without logging in): sent to the API as published, quotes checked against the page's own words. Authenticated (captured from a logged-in session, e.g. Hive): redacted with the v1 redactor before the API, quotes checked against the redacted text. The flag alone decides redaction, never the domain. Necessary mechanism (no new policy): the user sets the flag in the capture popup at capture time; a snapshot with no flag is treated as authenticated (redacted).
History: none

### R-CQ1: merge order when a page edit and a Slack post disagree
Finding: CQ1, CRITICAL, 8/10, §Merge steps 1–3 ("Start from page canon … latest snapshot … Apply Slack changes in `ts` order"), reviewer plan-eng-review (Claude)
Plan baseline: original proposal: latest page snapshot first, then every authorized Slack change applied on top in ts order; step 5 collapses a Slack change that a newer snapshot repeats.
Runtime evidence: none (merge not built). Page edit times are unknown: a snapshot only proves the page said X at `captured_at`, so the edit happened between the previous snapshot and this one.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-CQ1 ordering | page first, all Slack on top | one timeline: each page change is placed in the window (previous snapshot, this snapshot]; authorized Slack changes by ts; the latest wins; a Slack post inside a page change's window is ambiguous, so both values show with "Page and Slack disagree; page changed between <t1> and <t2>" and no winner is picked | page always loses to any authorized Slack post (as written) |
| Display of both values | always (D8) | unchanged | unchanged |
| Other pending choices (Section 2+) | pending | pending | pending |
Question D13:
D13 — When a newer page edit disagrees with an older Slack post, which one wins?
Project/branch/task: hackrecon v2 design doc, branch v2, merge rule.
ELI10: The plan starts from the page, then lays every authorized Slack change on top. That's right when Slack is newer. But if Slack said 09:30 at 8 PM and the organizer edited Devpost to 10:00 at 9 PM, the board would still show 09:30. We never know exactly when a page was edited, only that it changed between two of our snapshots. So a Slack post inside that window is honestly ambiguous.
Stakes if we pick wrong: The board shows a stale deadline as current, sourced to a real organizer post, which is the most trusted-looking kind of wrong.
Recommendation: A) One timeline with an ambiguity flag, because it never picks a winner it can't justify, and both values are shown anyway (D8).
Completeness: A=9/10, B=5/10
Pros / cons:
A) One timeline + ambiguity flag (recommended)
  ✅ A newer page edit beats an older Slack post, and a newer Slack post beats an older page
  ✅ When timing can't decide, it says so, with both values and the page's change window, instead of guessing
  ❌ More merge cases to test: windows, ties, several snapshots (human: ~0.5 day / CC: ~20 min)
B) Slack always wins (as written)
  ✅ The simplest rule: page first, Slack on top
  ✅ Matches the brief's wording "Slack updates override"
  ❌ A later official page correction is hidden under an older Slack post, and the board shows it as current
Net: a few more merge cases versus a silent stale value that looks authoritative.
Header: Merge order
Options:
A) Timeline + ambiguity (recommended)
Page changes sit in their (previous snapshot, this snapshot] window; authorized Slack changes by ts; latest wins. A Slack post inside a page change's window is ambiguous: show both values with "Page and Slack disagree; page changed between <t1> and <t2>", no winner. Both values always shown. (human: ~0.5 day / CC: ~20 min)
B) Slack always wins
Keep: latest snapshot first, then all authorized Slack changes on top in ts order. Both values always shown.

State: approved
Actual answer: A) Timeline + ambiguity (recommended) — user, D13, 2026-10-28
Accepted scope: Page changes sit in their (previous snapshot, this snapshot] window; authorized Slack changes by ts; latest wins. A Slack post inside a page change's window is ambiguous: show both values with "Page and Slack disagree; page changed between <t1> and <t2>", no winner. Both values always shown. The first snapshot of a page is the baseline canon, not a change, so authorized Slack changes apply on top of it (the Cal Hacks 09:00 → 09:30 fixture is unaffected).
History: none

### R-T1: v1 regression contract across v2
Finding: T1, CRITICAL (regression rule), 9/10, §Eval "Claim regression | 20 offers, 3 priced | … Same offers, values and excerpts, or a listed reason", reviewer plan-eng-review (Claude)
Plan baseline: original proposal (not yet approved): Claim keeps the same offers, values and excerpts, "or a listed reason". D10 approved the step-0 proof (board output identical apart from basis.written_at). D2 approved lifting group.ts's retry loop.
Runtime evidence: data/board.json today: 20 offers, 3 priced, 977 posts, 23 rep rows [measured]; group.test.ts 11 tests, board.test.ts 6 tests.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-T1 what must not change | "same offers … or a listed reason" | a golden snapshot of v1's data/board.json (offers, values, excerpts, frames, reps, event_deadlines) checked in as a test fixture with workspace text removed (ids, counts, times, hashes of excerpts only); `bun test` compares every build to it; allowed differences are listed in the test by field, each with the decision that allows it (e.g. thread replies adding offers after step 1) | the plan's wording: compare by hand at each step, any difference explained in the step's notes |
| group.ts after the helper lift (D2) | n/a | group.test.ts unchanged and green | same |
| Other pending choices (T2, T3, P1) | pending | pending | pending |
Question D14:
D14 — How do we prove v2 doesn't break v1's Claim board?
Project/branch/task: hackrecon v2 design doc, branch v2, regression coverage.
ELI10: v2 moves files (step 0), lifts the grouping retry loop into a shared helper (D2), and adds thread replies that can add new offers. Any of these could quietly change the 20 offers v1 shows. Option A records today's board as a fingerprint test: ids, counts, times and hashes of the excerpts, but none of the Slack text. Every build is checked against it, and each expected difference is written into the test with the decision that allows it. Option B is a by-hand comparison at each step.
Stakes if we pick wrong: A by-hand check gets skipped on a busy day, and v1's working board silently loses an offer or a price.
Recommendation: A) Fingerprint test with listed allowed differences, because it runs on every `bun test`, and the "or a listed reason" from the plan becomes a reviewed line in code.
Completeness: A=10/10, B=5/10
Pros / cons:
A) Fingerprint test (recommended)
  ✅ Catches any change to v1's offers, prices, excerpts, frames or reps on every test run
  ✅ The fixture holds hashes and counts only, so no workspace text is checked into git
  ❌ Each intended change (e.g. new offers from threads) must be added to the allow-list (human: ~2h / CC: ~15 min)
B) By-hand comparison
  ✅ No fixture to maintain
  ✅ Flexible when many fields change at once
  ❌ Relies on remembering to compare; silent regressions slip through between steps
Net: a small allow-list to maintain versus trusting a manual check.
Header: Regression
Options:
A) Fingerprint test (recommended)
Check in a fingerprint of v1's board.json (ids, counts, times, excerpt hashes; no workspace text). `bun test` compares every build; allowed differences are listed per field with the decision that allows them. group.test.ts stays unchanged and green after the D2 helper lift. (human: ~2h / CC: ~15 min)
B) By-hand comparison
Compare the Claim board by hand at the end of each step and note any difference with its reason. group.test.ts stays unchanged and green after the D2 helper lift.

State: approved
Actual answer: A) Fingerprint test (recommended) — user, D14, 2026-10-28
Accepted scope: Check in a fingerprint of v1's board.json (ids, counts, times, excerpt hashes; no workspace text). `bun test` compares every build; allowed differences are listed per field with the decision that allows them. group.test.ts stays unchanged and green after the D2 helper lift. Necessary mechanism: when the gitignored board data is absent (clean checkout), the comparison is skipped with a visible message, never passed silently.
History: none

### R-T2: who checks canon extraction (E3)
Finding: T2, INFORMATIONAL, 7/10, §Eval "Opus judge … **and** a user hand check (E3)"; binding decision D21 (demo-scope.md: "LLM judge replaces human labels … No person labels"), reviewer plan-eng-review (Claude)
Plan baseline: original proposal: Opus judge plus a ~20-minute user hand check per event; brief: "entities + Opus-judged eval"; D21 (v1) removed human labeling.
Runtime evidence: canon verify is deterministic (quote exists in source, numbers and dates inside the quote), so a wrong value can't pass silently; completeness (a missed track or rule) is what a judge checks. Cal Hacks Devpost: 5 judging criteria, prize list with $159,822 total [measured: curl 2026-10-28].
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-T2 canon eval | Opus judge + user hand check | Opus judge only (fresh context, sees the snapshot and the extracted list, asked "what's missing or wrong"), plus deterministic verify; report says "agreement with Opus" | Opus judge + a ~20-minute user hand check per event that must find 0 wrong values |
| Gate | judge finds no missing track/rule; hand check 0 wrong | judge finds no missing track, prize, criterion or rule; verify 100% | same + hand check 0 wrong |
| Other pending choices (T3, P1) | pending | pending | pending |
Question D15:
D15 — Is the Opus judge enough to check canon extraction, or do you also hand-check it?
Project/branch/task: hackrecon v2 design doc, branch v2, entities eval.
ELI10: When the model reads Devpost into tracks, prizes and rules, code already checks that every value comes with a quote that exists on the page, and that every number or date appears in its quote. So a made-up number can't get through. What's left is something missed, like a prize that never got extracted, or a real quote attached to the wrong field. Your brief says "Opus-judged eval", and in v1 you replaced human labeling with the Opus judge (D21). My plan also added a 20-minute hand check per event.
Stakes if we pick wrong: Judge-only could miss an omission both models share. Adding the hand check reintroduces a human step you removed in v1.
Recommendation: A) Opus judge only, because it matches your brief and D21, the deterministic checks already block made-up numbers, and the judge is asked about omissions and misplaced values.
Completeness: A=8/10, B=9/10
Pros / cons:
A) Opus judge only (recommended)
  ✅ Matches the brief ("Opus-judged eval") and D21: no person labels anything
  ✅ Code already blocks made-up numbers and dates, so the judge focuses on omissions and misplaced quotes
  ❌ An omission that both the extractor and the judge miss goes unnoticed
B) Judge + hand check
  ✅ A human look catches shared blind spots, like a prize the page lists in an unusual place
  ✅ Canon sets are small (one page, dozens of entities), so the check is short
  ❌ Adds about 20 minutes of your time per event, a human step you removed in v1
Net: your v1 rule of no human labeling versus a short manual safety net for omissions.
Header: Canon check
Options:
A) Opus judge only (recommended)
Canon eval = deterministic verify (100% quotes found, numbers in quotes) + an Opus judge in a fresh context listing what's missing or misplaced. Gate: no missing track, prize, criterion or rule. Reported as agreement with Opus.
B) Judge + hand check
The same, plus a ~20-minute user hand check per event that must find 0 wrong values.

State: approved
Actual answer: A plus deterministic coverage checks — user, D15, 2026-10-28, verbatim: "Option A, plus deterministic coverage checks that don’t depend on any model: (1) sum of extracted prize amounts must reconcile with the page’s stated total ($159,822 for Cal Hacks; report the gap with the unmatched dollar figures from the page); (2) count of prize headings / prize blocks in the page HTML must equal the extracted prize count; (3) every $-amount and date on the page must be either attached to an entity or listed as “unattached” in the report. Any mismatch fails the gate"
Accepted scope: Canon eval = deterministic verify (100% quotes found, numbers in quotes) + an Opus judge in a fresh context listing what's missing or misplaced, reported as agreement with Opus; gate: no missing track, prize, criterion or rule. Plus three model-free coverage checks, any mismatch fails the gate: (1) the sum of extracted prize amounts reconciles with the page's stated total ($159,822 for Cal Hacks), and the report shows the gap with the page's unmatched dollar figures; (2) the count of prize headings / prize blocks in the page snapshot equals the extracted prize count; (3) every $-amount and date on the page is attached to an entity or listed as "unattached" in the report. No user hand check.
Note (reviewer, not a change): Devpost totals can count prizes differently from their text (per-member amounts, "up to $4000 total" caps, non-cash prizes), so check (1) can fail on a correct extraction; the report's unmatched figures are what the user reads to decide.
History: none


### R-T3: how idea fit is evaluated
Finding: T3, INFORMATIONAL, 8/10, §Views Build (D4) + R-A1 (D6): a new model path with no eval in §Eval, reviewer plan-eng-review (Claude)
Plan baseline: D4/D6 approved idea fit with a verified quote per track; no quality eval exists.
Runtime evidence: the public Devpost project gallery for Cal Hacks 13.0 lists real submitted projects with descriptions [measured: curl cal-hacks-13-0.devpost.com/project-gallery, 2026-10-28]; their actual prize entries are not known from that page.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-T3 fit eval | none | ideas = one-sentence descriptions of 10 real projects from the public gallery [estimated size]; for each, an Opus judge in a fresh context (blind to the ranker) marks each track fits / doesn't / can't tell from the stated requirements; report top-3 agreement with Opus and every cited quote verified (100%); gate: 100% quotes verified, top-3 agreement reported, no threshold until a baseline exists | deterministic only: every cited requirement quote is verified (100%); no quality measure |
| Other pending choices (P1) | pending | pending | pending |
Question D16:
D16 — How should idea-fit ranking be evaluated?
Project/branch/task: hackrecon v2 design doc, branch v2, Build view eval (D4, D6).
ELI10: Idea fit is a new model step, and nothing in the plan measures whether its ranking is any good. Code can check that each "matches: <requirement>" quote really exists, but not whether the ranking is sensible. Option A takes 10 real project descriptions from Cal Hacks' public Devpost gallery. A separate Opus judge, who never sees the ranking, marks which tracks each fits, and we report how often the top 3 agree. Option B only checks the quotes.
Stakes if we pick wrong: Without a quality measure, a prompt change could make rankings worse, and nothing would show it.
Recommendation: A) Gallery ideas + blind judge, because it reuses your Opus-judge pattern on public data and gives a number to compare prompt changes against.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Gallery ideas + blind judge (recommended)
  ✅ Real project descriptions from a public page, so no invented test ideas and no Slack text
  ✅ Gives a top-3 agreement number to compare prompt changes against, reported as agreement with Opus
  ❌ About 10 judge calls per eval run, plus no pass threshold until a first baseline is measured (human: ~0.5 day / CC: ~20 min)
B) Quote checks only
  ✅ Free to run, deterministic, no model cost
  ✅ Still guarantees every cited requirement is real
  ❌ Can't tell a good ranking from a bad one; prompt regressions go unseen
Net: a small paid eval that tracks quality versus free checks that only prove the quotes are real.
Header: Fit eval
Options:
A) Gallery ideas + blind judge (recommended)
Eval set: one-sentence descriptions of 10 real projects from the public Devpost gallery. A blind Opus judge marks each track fits / doesn't / can't tell. Report top-3 agreement with Opus; gate: 100% cited quotes verified; no agreement threshold until a baseline exists. (human: ~0.5 day / CC: ~20 min)
B) Quote checks only
Gate: 100% of cited requirement quotes verified in that track's sources. No ranking-quality measure.

State: approved
Actual answer: Other (user, D16, 2026-10-28), verbatim: "Option C: evaluate idea fit against real outcomes from the public Devpost gallery, not a model judge. Take ~50 projects (sample the winners plus a random set): input = the project’s one-line description; labels = tracks it won (strong) and tracks it was submitted to (weak, teams over-submit). Metrics: recall@3 on won tracks (did we rank the track it actually won in our top 3?) and precision against submitted tracks. Same quote-verification gate. Uses only public pages; use Sonnet for ranking so 50 runs costs cents. Report the baseline; set a threshold after the first run."
Accepted scope: Eval set: about 50 projects from the public Devpost gallery (the winners plus a random sample). Input: each project's one-line description only (no creator names). Labels: tracks it won (strong) and tracks it was submitted to (weak). Metrics: recall@3 on won tracks, and precision against submitted tracks. Gate: 100% of cited requirement quotes verified (unchanged). The ranker uses Sonnet (`claude-sonnet-5-5`), which amends D6's model choice. Report the baseline; the threshold is set after the first run. Cost is measured on the first run (the user expects cents; not yet measured).
Precondition (reviewer probe, 2026-10-28): a Cal Hacks project page shows "Submitted to: Cal Hacks 13.0" at the hackathon level only; per-prize submissions were not visible, and whether winners' prize names are public is unverified (`?winners=true` returned the same first project). Step 2 starts with a bounded probe of the gallery and of winner pages. If won-track or submitted-track labels aren't public, this decision returns to the user before the eval is built; no fallback is chosen here. Observation only: project pages list "Built With" tags (e.g. bitdeer, factory, intuit) that name sponsor tools.
History: none

### R-P1: thread capture budget and order (E4)
Finding: P1, INFORMATIONAL, 8/10, §Sources "A per-run thread budget (default 60) … Order: threads with the most replies first", reviewer plan-eng-review (Claude)
Plan baseline: original proposal: default budget 60 threads per sync, most replies first, unvisited threads carry over.
Runtime evidence: [measured: export, locked 25] 494 replies in 209 threads; top 60 threads hold 286 replies (58%). Per-thread time ≈ 3 s [estimated: pane open + scroll + 1.5 s wait], so all 209 ≈ 10–11 min [estimated].
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-P1 live sync budget | 60, most replies first, carry over | unchanged: 60 per sync, most replies first, carry over; the popup shows "N of M threads captured" | every thread in the channel each sync, no budget |
| R-P1 one-time fixture capture (D5) | same budget (4 runs) | uncapped: all 209 threads in one user-started run, with progress and Stop | uncapped (same as live) |
| Other pending choices | none | none | none |
Question D17:
D17 — How many threads should one capture run open?
Project/branch/task: hackrecon v2 design doc, branch v2, thread capture (D5).
ELI10: The locked 25 channels have 494 replies spread over 209 threads. Most threads are tiny: half have 2 replies or fewer. The plan caps each sync at 60 threads, biggest first, which gets 58% of the replies in about 3 minutes, with the rest carried to the next sync. That's right for quick re-syncs mid-hackathon. But for the one-time Cal Hacks fixture capture (D5), it would take 4 runs before thread recall can even be measured.
Stakes if we pick wrong: A cap on the fixture delays the recall gate by 3 extra runs while workspace access is at risk. No cap on live syncs makes each re-sync take about 10 minutes.
Recommendation: A) Cap live syncs at 60, but run the one-time fixture capture uncapped, because the fixture is the at-risk data (D5) and live syncs need to stay quick.
Completeness: A=9/10, B=7/10
Pros / cons:
A) 60 live, uncapped fixture (recommended)
  ✅ The whole Cal Hacks thread fixture lands in one run of about 10–11 minutes [estimated], so recall can be measured right away
  ✅ Live re-syncs stay around 3 minutes, biggest threads first, with carry-over and an "N of M threads" count
  ❌ Two modes to build and test, a budgeted one and an uncapped one (human: ~1h / CC: ~10 min)
B) Every thread, every time
  ✅ One mode, always complete after each sync
  ✅ No carry-over state to track between runs
  ❌ Every live re-sync takes about 10 minutes for this channel set [estimated], and longer at bigger events
Net: two run modes versus slow re-syncs or a delayed fixture.
Header: Threads
Options:
A) 60 live, fixture uncapped (recommended)
Live syncs: 60 threads per run, most replies first, unvisited carry over, popup shows "N of M threads captured". The one-time fixture capture (D5) is uncapped: all threads in one user-started run, with progress and Stop. (human: ~1h / CC: ~10 min)
B) Every thread, every time
No budget: every sync opens every thread with replies in the captured channels, with progress and Stop.

State: approved
Actual answer: A with smarter live selection — user, D17, 2026-10-28, verbatim: "Option A (fixture uncapped, live capped at 60), with smarter live selection: (1) skip threads whose visible reply count and “last reply” time haven’t changed since the last sync, since Slack shows both on the parent row, so unchanged threads cost nothing; (2) among changed threads, prioritize parents that are offers, tracks, deadlines or rep posts, then by new-reply count. The cap only applies after that filter."
Accepted scope: The one-time fixture capture (D5) is uncapped: all threads in one user-started run, with progress and Stop. Live syncs: (1) skip any thread whose parent row's visible reply count and "last reply" time are unchanged since the last sync; (2) order the changed threads by parent kind first (offers, tracks, deadlines, rep posts, from the cached classification of the parent) and then by new-reply count; (3) apply the 60-thread cap after that filter; unvisited changed threads carry over; the popup shows "N of M changed threads captured". Necessary proof (no new policy): the parent-row reply-count and last-reply selectors go in selectors.ts backed by DOM fixtures (unverified today); if the last-reply time isn't in the DOM, the reply count alone decides "changed", and the run report says so.
History: none

### R-OV1: v2 scope: full brief or canon-first (outside voice)
Finding: OV6 + strategic, HIGH, 7/10, §Build order step 5; §Problem; outside voice ("Ship the canon half as v2 and plan the live layer once a dated live event is named"), reviewer Claude Plan subagent (cross-model tension: same model family, fresh context)
Plan baseline: the user's brief: five views, multi-source merge, thread capture, per-event config; build order sources → entities + eval → merge → views → generalize. D1–D17 approved within it.
Runtime evidence: the Cal Hacks fixture exercises merge offline (Devpost 09:00 [measured 2026-10-28] vs organizer Slack 09:30). No next event is named in the repo or TODOS.md; TODOS.md still ties direction to an MLH reply.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-OV1 v2 scope | full brief | full brief unchanged; live-only behaviors (incremental capture, thread budget, Now's on-now/next, roles at a new event) labeled "unproven until a live run" in the report; step 5 gate = second event's pages pass the D15 coverage checks (not just "builds") | v2 = canon half (page snapshots, entities, coverage checks, Build, Ship, Claim, Meet from existing data, thread capture); merge, Now and incremental live capture move to v2.1, planned once a dated event is named |
| Other pending choices (OV3/D19, OV4/D20) | pending | pending | pending (moot under B until v2.1) |
Question D18:
D18 — Build the whole brief now, or the page half first?
Project/branch/task: hackrecon v2 design doc, branch v2, outside-voice tension on scope.
ELI10: An independent reviewer says the page half of v2 (Devpost into tracks, rules and a checklist) can be fully built and tested today. The Slack live half (overrides, the Now feed, re-syncing during an event) can only really be proven at a live hackathon, and none is named yet. Your brief asks for both. The Cal Hacks data does test the merge offline: Devpost still says 9 AM, Slack said 9:30. What can't be tested offline is re-syncing during an event.
Stakes if we pick wrong: Full scope may ship live features that first break at the next event. Page-first delays Now and overrides, which are half of what you asked for.
Recommendation: A) Keep the full brief, label live-only behavior "unproven until a live run", and gate step 5 on real coverage checks, because the merge is testable offline on Cal Hacks and the brief explicitly asks for Now.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Full brief, labeled (recommended)
  ✅ Matches your brief: all five views and the page + Slack merge ship in v2
  ✅ The Cal Hacks fixture (page 09:00, Slack 09:30) tests merge and Now without a live event
  ❌ Re-syncing mid-event, thread budget and new-event roles stay unproven until a real hackathon
B) Page half first
  ✅ Everything in v2 is fully testable today, against Cal Hacks and any upcoming Devpost page
  ✅ Shorter: the merge, authority and Now work (steps 3 and part of 4) moves out
  ❌ Now and Slack overrides, half the brief, wait for v2.1 and a named event
Net: shipping the whole brief with labeled unknowns versus shipping only what can be proven today.
Header: v2 scope
Options:
A) Full brief, labeled (recommended)
Keep the full scope. The report labels incremental capture, the live thread budget, Now's on-now/next and roles at a new event "unproven until a live run". Step 5's gate becomes: the second event's pages pass the D15 coverage checks.
B) Page half first
v2 = page snapshots, entities, coverage checks, Build, Ship, Claim, Meet and thread capture. Merge, Now and live incremental capture move to v2.1, planned once a dated event is named.

State: approved
Actual answer: A with a build order — user, D18, 2026-10-28, verbatim: "Option A. Build order inside v2: page half first (snapshots, canon entities, coverage checks, Build, Ship), then the Slack live half (merge, Now, live capture). Add to the report: “Live-only behavior is unproven until a named event; next event: <TBD>, platform: <Slack/Discord>.” If the next event uses Discord, add a Discord capture path to TODOS as the v2.1 blocker"
Accepted scope: Full brief stays in v2. Build order inside v2: page half first (snapshots, canon entities, coverage checks, Build, Ship), then the Slack live half (merge, Now, live capture). The report carries: "Live-only behavior is unproven until a named event; next event: <TBD>, platform: <Slack/Discord>." Step 7 (generalize) gate: the second event's pages pass the D15 coverage checks. If the next event uses Discord, a Discord capture path is added to TODOS.md as the v2.1 blocker (conditional; not added now, since the platform is unknown).
Interpretation (reviewer, flagged to user): the one-time thread fixture capture stays at step 1, before the page half, because D5 put it first while workspace access lasts; "live capture" in the Slack half means incremental capture and D17's live thread selection. Meet moves to the Slack half because it reads reps from Slack.
History: none

### R-OV3: who counts as an organizer for overrides
Finding: OV3, HIGH, 9/10, §Merge authority (D8); pipeline/roles.ts:59 `posterRole` (ORG_TAG on display name, ORG_TITLE on profile title, sponsor name in display name), reviewer Claude Plan subagent, verified by plan-eng-review
Plan baseline: D8 approved: organizers may override any entity, sponsor-side only their own sponsor, others never. The detection of "organizer" was carried over from v1, where it only hinted the classifier.
Runtime evidence: config/organizers.json has 55 ids [measured]. 52 carry Slack's workspace-admin flag from the export; 3 qualify by name tag or title alone (2 "cal hacks tag", 1 "title"). All 4 sourced schedule posts in event.json were posted in #0-announcements by ids in that list [measured].
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-OV3 who may override deadlines, times and rules | any poster matching name/title patterns, or listed ids | only (a) ids in organizers.json backed by a non-free-text signal (workspace admin/owner from the export, or ids the user lists), or (b) any post in configured `authority_channels` (e.g. #0-announcements); name/title-only matches are shown as "unverified poster", never applied | v1 heuristics unchanged (name tag, title, listed ids) |
| Sponsor-side overrides of own sponsor fields | name contains sponsor | Slack's external-org badge, or ids the user lists per sponsor; name match alone shown as "unverified poster" | name contains sponsor (v1) |
| At a new event (no export) | patterns | `authority_channels` from config plus user-listed ids; the run report lists every name-only match for the user to add | patterns |
| Other pending choices (OV4/D20) | pending | pending | pending |
Question D19:
D19 — Who counts as an organizer when a Slack post overrides a page value?
Project/branch/task: hackrecon v2 design doc, branch v2, merge authority (D8).
ELI10: In v1, someone counted as an organizer if their Slack display name said "Cal Hacks" or their title said "director". Anyone can type that into their own profile. In v1 it only nudged the classifier. In v2 an organizer's post can change the deadline shown to you. Option A only trusts signals people can't set themselves: Slack admin status, ids you list, or posts in announcement-only channels. A name match then shows as "unverified poster" instead. At Cal Hacks this drops 3 of 55 organizer ids, and all 4 real deadline posts still count.
Stakes if we pick wrong: Under B, a hacker who renames themselves "Alex [CAL HACKS]" can move your submission deadline on the board.
Recommendation: A) Trust only signals people can't set themselves, because a wrong deadline is the most expensive mistake the board can make and the Cal Hacks fixture still passes.
Completeness: A=9/10, B=5/10
Pros / cons:
A) Unspoofable signals only (recommended)
  ✅ A self-renamed hacker can't move a deadline; name matches still appear, labeled "unverified poster"
  ✅ Cal Hacks fixture unaffected: all 4 deadline posts are in #0-announcements by admin ids [measured]
  ❌ At a new event without an export, you list authority channels and ids in config, and real organizers missing from both show as unverified until added (human: ~1h / CC: ~10 min)
B) Keep v1 heuristics
  ✅ Zero setup at a new event: name tags and titles work out of the box
  ✅ Catches organizers who aren't admins and post outside announcement channels
  ❌ Anyone can set their own display name or title and override a deadline
Net: a little config at each event versus letting a profile edit change the deadline you see.
Header: Authority
Options:
A) Unspoofable only (recommended)
Overrides of deadlines, times and rules come only from ids backed by admin/owner status or listed by you, or from posts in configured authority_channels. Sponsor-side needs the external-org badge or a listed id. Name/title-only matches show as "unverified poster" and are listed in the run report. (human: ~1h / CC: ~10 min)
B) Keep v1 heuristics
Name tag, profile title and listed ids all grant override authority, as in v1.

State: approved
Actual answer: A with auto-detected authority channels — user, D19, 2026-10-28, verbatim: "Option A. At a new event, detect authority channels automatically where possible: channels where posting is restricted (Slack shows that only certain members can post) become authority_channels by default, and the user confirms the list once. Posts there can override canon; name-tag-only matches show as “unverified poster” as specified."
Accepted scope: Overrides of deadlines, times and rules come only from ids backed by admin/owner status or listed by the user, or from posts in authority_channels. Sponsor-side needs the external-org badge or a listed id. Name/title-only matches show as "unverified poster" and are listed in the run report. At a new event, channels where Slack restricts posting become authority_channels by default, and the user confirms the list once.
Necessary proof (no new policy): the restricted-posting notice and the external-org badge are read by selectors in selectors.ts backed by DOM fixtures (unverified today); if the notice isn't in the DOM, no channel is proposed and the report says so, so the user lists them.
History: none

### R-OV4: re-scanning older parents for late thread replies
Finding: OV4, HIGH, 9/10, §Sources "resumes from its newest stored ts and stops when it reaches it (caught_up)" vs D17 "skip threads whose parent row shows the same reply count and last reply time", reviewer Claude Plan subagent
Plan baseline: incremental capture (original proposal) + D17 (approved): the skip rule reads parent rows that incremental capture never scrolls back to.
Runtime evidence: [measured: export, locked 25] 494 replies arrive after their parent by: median 1.1 h, p90 11.4 h, p95 20.5 h, p99 35.0 h, max 58.0 h; 15 replies came more than 24 h later, 2 more than 48 h later. 28 replies are by admin/owner ids.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R-OV4 parent rows re-read each live sync | none older than the newest stored ts | after `caught_up`, keep scrolling back over parents posted in the last 48 h (configurable `thread_lookback_hours`), read their reply count and last-reply time, then apply D17's skip/priority/cap | no re-scan; the run report says "replies to posts older than the last sync are not captured" |
| Coverage at measured shape | late replies missed | 492 of 494 replies (99.6%) arrive within 48 h | replies after the next sync are missed |
| Other pending choices | none | none | none |
Question D20:
D20 — Should each live sync scroll back to catch new replies on older posts?
Project/branch/task: hackrecon v2 design doc, branch v2, live capture (D17).
ELI10: Live syncs only read new posts, stopping where the last sync stopped. But the "skip unchanged threads" rule from D17 needs to see older posts' reply counts, which those syncs never scroll back to. So an organizer answering in yesterday's thread would be missed. At Cal Hacks, half of replies came within about an hour, but 15 came more than a day later and 2 more than two days later. Option A scrolls back over the last 48 hours of posts each sync, which covers 492 of 494 Cal Hacks replies.
Stakes if we pick wrong: Without the re-scan, the typical late clarification ("yes, 9:30 applies to all tracks") never reaches the board during the event.
Recommendation: A) Scroll back 48 hours each sync, because it covers 99.6% of measured replies and makes D17's skip rule actually work.
Completeness: A=9/10, B=5/10
Pros / cons:
A) 48-hour lookback (recommended)
  ✅ Catches late answers in older threads: 492 of 494 Cal Hacks replies arrived within 48 hours [measured]
  ✅ D17's skip rule works as you specified, since parent rows are re-read every sync
  ❌ Each sync scrolls further per channel, slower than "seconds per channel", time not yet measured (human: ~0.5 day / CC: ~15 min)
B) No re-scan, stated
  ✅ Fastest live syncs: only new posts are read
  ✅ Simplest: no lookback scroll, no extra parent bookkeeping
  ❌ Replies to anything older than the last sync are never captured live, and D17's skip rule has little to act on
Net: slower syncs that catch late answers versus fast syncs that miss them.
Header: Lookback
Options:
A) 48-hour lookback (recommended)
After catching up, each live sync scrolls back over parents posted in the last 48 h (config `thread_lookback_hours`), reads reply count and last-reply time, then applies D17's skip, priority and cap. (human: ~0.5 day / CC: ~15 min)
B) No re-scan, stated
Live syncs read new posts only; the run report says replies to older posts aren't captured.

State: approved
Actual answer: A plus permalink checks — user, D20, 2026-10-28, verbatim: "Option A, plus: for entity parents older than the lookback window (offers, tracks, deadlines, rep posts), open their permalink directly each sync to read reply count and last-reply time, and apply D17’s skip rule. Scroll covers the recent 48h; permalinks cover the important old ones."
Accepted scope: After catching up, each live sync scrolls back over parents posted in the last 48 h (config `thread_lookback_hours`) and reads reply count and last-reply time. Parents older than the window whose posts are entity sources (offers, tracks, deadlines, rep posts) are opened by permalink each sync to read the same two values. D17's skip rule, kind-first priority and 60-thread cap then apply to both sets.
Necessary mechanism (no new policy): permalink opens are paced like thread opens (OV14) and stop on any Slack error or rate-limit banner; the run report gives how many permalinks were checked and the sync's total time (not yet measured; the number of entity parents is counted at step 5).
History: none

### R-OV-M: outside-voice mechanism fixes applied before approval
Finding: OV2, OV5, OV7, OV9, OV10, OV11, OV13, OV14 (outside voice), reviewer Claude Plan subagent; applied to the plan body by plan-eng-review as mechanisms of approved behavior, pending the user's confirmation here
Plan baseline: the plan body before the outside voice; each fix reverts if not confirmed.
Runtime evidence: board.ts:193 positional offer ids [verified]; Devpost prize titles in h5/h6 [measured]; `Rep.opener` has no generator [verified].
Comparison grid:
| Group | Fixes | If unticked |
|---|---|---|
| 1 Ids and types | OV2 `Change {entity_id, field, to, kind}` + `posted_at`, merge computes `from`/`status`; OV5 outline h1–h6, offer id from first post (`o-<channel>-<ts>`), done marks migrated once | revert; listed unresolved |
| 2 Capture safety | OV7 save thread-pane DOM samples at step −1, "unmeasured" fallback; OV14 pace ~3 s per thread, stop on Slack error/rate-limit banner | revert; listed unresolved |
| 3 Cost and noise | OV10 classifier sees entity kinds only, naming in the link pass; OV13 hash normalized outline, only changed fields are canon changes | revert; listed unresolved |
| 4 Honest outputs | OV9 n beside every rate, n < 20 listed individually; OV11 opener owned by live.ts, dropped if any number/name/date isn't in the rep's post | revert; listed unresolved |
Question D21 (multi-select): Which outside-voice fixes should stay in the plan?
State: approved
Actual answer: all four groups — user, D21, 2026-10-28: "1) Ids and types, 2) Capture safety, 3) Cost and noise, 4) Honest outputs"
Accepted scope: OV2, OV5, OV7, OV9, OV10, OV11, OV13, OV14 as written in the plan body and the Outside Voice table.
History: none

Approval readiness: PASS — checked R-F1 (D3), R-F2 (D4), R-F3 (D5), R-A1 (D6, amended by D16), R-A2 (D7), R-A3 (D8), R-A4 (D9), R-A5 (D10), R-A6 (D11), R-A7 (D12), R-CQ1 (D13), R-T1 (D14), R-T2 (D15), R-T3 (D16), R-P1 (D17), R-OV1 (D18), R-OV3 (D19), R-OV4 (D20), R-OV-M (D21); scope/structure D1, D2 (Scope Challenge). Every accepted remedy cites the user's actual answer. D16 precondition resolved by D23 (R-T3b).

### R-T3b: idea-fit eval labels after the D16 probe
Finding: D16 precondition result, HIGH, 9/10, R-T3 "If won-track or submitted-track labels aren't public, this decision returns to the user", reviewer plan-eng-review (Claude), probe run at the user's request 2026-10-28
Plan baseline: D16 approved: ~50 Cal Hacks projects; labels won tracks (strong) + submitted tracks (weak); recall@3 on won, precision vs submitted; Sonnet ranker; threshold after first run.
Runtime evidence [measured, curl 2026-10-28]: 5 Cal Hacks 13.0 project pages show "Submitted to: Cal Hacks 13.0" only, no winner badge; the 13.0 page says "Winners announced soon". Cal Hacks 11.0 winning page (angelshot) shows "Winner · Vapi: Show us your Voice AI"; 4 non-winning 11.0 pages show "Submitted to: Cal Hacks 11.0" only. 11.0 gallery: 62 projects with a winner badge (pages 1–3). Submitted-track labels are not public at either event.
Comparison grid:
| Choice | Current (D16) | A | B |
|---|---|---|---|
| Labels | won (strong) + submitted (weak) | won tracks only | won tracks only |
| Event | Cal Hacks 13.0 | Cal Hacks 11.0 now (62 winners; its own Devpost page snapshotted as canon), rerun on 13.0 when its winners post | Cal Hacks 13.0 only, built after its winners are announced (date unknown) |
| Metrics | recall@3 won; precision vs submitted | recall@3 on won tracks, n printed; precision dropped (no public label) | same as A |
| Unchanged | Sonnet ranker, 100% quote gate, threshold after first run, description-only input | unchanged | unchanged |
Question D23:
D23 — Devpost doesn't publish which prizes a project entered. How should idea fit be scored?
Project/branch/task: hackrecon v2 design doc, branch v2, idea-fit eval (D16 precondition).
ELI10: Your D16 eval needed two labels per project: tracks it won and tracks it entered. Devpost publicly shows only what a project won, and only after winners are announced. It never shows entries. Cal Hacks 13.0 winners aren't posted yet. Cal Hacks 11.0 has 62 public winners with prize names. So the precision-against-entries metric can't be computed from public pages, but recall@3 on won tracks can.
Stakes if we pick wrong: Waiting for 13.0 blocks the eval for an unknown time. Using 11.0 tunes the ranker on last year's tracks.
Recommendation: A) Score won tracks on Cal Hacks 11.0 now and rerun on 13.0 when its winners post, because 62 public labels exist today and the extra Devpost page also exercises step 7's generalization.
Completeness: A=8/10, B=7/10
Pros / cons:
A) 11.0 now, 13.0 later (recommended)
  ✅ 62 public winner labels are available today, so the baseline lands in step 3 as planned
  ✅ Extracting 11.0's Devpost page is a second real canon page, a free generalization test
  ❌ Precision is dropped, and 11.0's tracks differ from 13.0's, so the first number isn't this year's (human: ~0.5 day / CC: ~20 min)
B) Wait for 13.0 winners
  ✅ The labels match the tracks the board actually shows this year
  ✅ No extra page to snapshot or extract
  ❌ The eval can't run until Devpost posts 13.0 winners, an unknown date; precision is dropped too
Net: a baseline today on last year's tracks versus this year's tracks on an unknown date.
Header: Fit labels
Options:
A) 11.0 now, 13.0 later (recommended)
Labels: won tracks only. Eval set: Cal Hacks 11.0's 62 winning projects, its Devpost page snapshotted as canon. Metric: recall@3 on won tracks with n; precision dropped. Rerun on 13.0 when its winners post. (human: ~0.5 day / CC: ~20 min)
B) Wait for 13.0 winners
Labels: won tracks only, Cal Hacks 13.0, built after Devpost posts its winners. Metric: recall@3 on won tracks with n; precision dropped.

State: approved
Actual answer: B) Wait for 13.0 winners — user, D23, 2026-10-28
Accepted scope: Labels are won tracks only, from Cal Hacks 13.0 project pages; the submitted-track precision metric is dropped (not public). Metric: recall@3 on won tracks with n printed. Ranker (Sonnet), 100% quote gate, description-only input and threshold-after-first-run are unchanged from D16.
Precondition met (re-probe 2026-11-04, measured): the 13.0 gallery now shows 90 winning projects (pages 1–4: 24, 24, 24, 18); a winning page lists each prize won, e.g. anima-labs: "Winner · [Creao AI] Best AI-First Disruptor", "Winner · [MLH] Commit Fellowship". Projects can win several prizes, so recall@3 counts a hit if any won track is in the top 3, and the report also gives per-track hits. The eval set is all 90 winners (D16 said ~50 including a random set; non-winners carry no public label, so they're left out).
User refinement (2026-11-06), verbatim: "D16 refinements: (1) label only sponsor-track prizes as fit targets; exclude event-level prizes (MLH Commit Fellowship, grand prize/overall/most-creative and similar) and list them separately in the report; (2) primary metric = recall@3 over (project, won sponsor track) pairs, with per-project “any hit” as secondary; n beside every rate."
Refined scope: fit targets are sponsor-track prizes only. Event-level prizes are excluded from scoring and listed separately in the report. Primary metric: recall@3 over (project, won sponsor track) pairs. Secondary: per-project "any hit" (at least one won sponsor track in the top 3). n beside every rate.
Classification rule (necessary mechanism): a prize is event-level if it carries no sponsor tag (the "Cal Hacks …" prizes) or is listed in event.json `event_level_prizes` (seeded with "[MLH] Commit Fellowship"); every other bracket-tagged prize is a sponsor track. The rule matches the tag, not the name, so "[Figma] Most Creative" stays a sponsor track. MLH's "[MLH] Best Use of <tool>" prizes count as sponsor tracks (user, 2026-11-06).
Measured on the 90 winners (2026-11-06): 106 wins, 52 distinct prizes. Sponsor tracks: 94 (project, track) pairs over 40 distinct prizes, from 81 projects (6 of the pairs are [MLH] prizes: 5 "Best Use of <tool>" plus "Best Domain Name from GoDaddy Registry"). Event-level: 12 wins over 12 prizes (11 "Cal Hacks …" plus [MLH] Commit Fellowship). 9 projects won only event-level prizes, so they leave the eval set.
User refinement (2026-11-06), verbatim: "Keep “[MLH] Best Use of <tool>“ as sponsor tracks but tag them tool_gated; report recall@3 for idea-gated and tool-gated pairs separately (n beside each), with the headline metric on idea-gated pairs."
Superseded by the ablation below (user, 2026-11-06): the idea/tool split no longer splits the headline.
User refinement (2026-11-06), verbatim: "Replace the idea/tool split with an ablation over all 94 sponsor-track pairs: run A = one-line description only, run B = description + the project’s public “Built With” list from its Devpost page. Report recall@3 for both (n beside each), plus per-prize for “Best Use of X” prizes. Keep tool_gated_prizes only as a reporting tag, not an exclusion. Headline = run A; the A→B gap decides whether Build asks for the stack."
Ablation scope: both runs score all 94 sponsor-track (project, won track) pairs from 81 projects. Run A input: the one-line description only. Run B input: the description plus the project's public "Built With" list from its Devpost page. Report recall@3 for A and for B, n beside each, and the A→B gap. Also report per-prize recall@3 (A and B, n per prize) for every "Best Use of X" prize. `tool_gated_prizes` (seeded "[MLH] Best Use of *") is a reporting tag only: tagged pairs stay in both runs and are marked in the per-prize table. Headline = run A. The per-project any-hit secondary is reported for both runs (n=81).
The A→B gap decides whether Build asks the user for their stack.
User default rule (2026-11-06), verbatim: "Build asks for the stack if run B beats run A by ≥10 points overall, or by ≥20 points on the “Best Use of X” prizes. Those are 58 of 94 pairs, so they’re most of where the prizes actually are."
Rule as applied: "points" are percentage points of recall@3. Build asks for the stack if B − A ≥ 10 over all 94 pairs, or B − A ≥ 20 pooled over the 58 "Best Use of X" pairs (not per prize). Otherwise Build asks only for the one-line idea. The report prints both gaps with n and which branch fired. Scale, for reading the result (not a change): at n=94, 10 points is about 9–10 pairs; at n=58, 20 points is about 12 pairs.
Measured for run B (2026-11-06): all 81 projects list a non-empty "Built With" (median 18 tags, max 25). There are 58 "Best Use of X" pairs over 21 prizes, and in 50 of the 58 the tool's name appears in the project's Built With list (first word of the tool, prefix match). So B's gain on those prizes will largely be tag matching, which the per-prize table shows.
History: D16 (2026-10-28) set won + submitted labels; the probe showed submitted labels aren't public.

## NOT in scope
- `hr init` auto-drafting (D1): deferred to TODOS.md; generalization is proven by hand first.
- `hr fetch` CLI page fetch (D11): deferred to TODOS.md; trigger is click-capture becoming the bottleneck at a live event.
- Pairwise "can these tracks stack?" grid (D4): Devpost states no general stacking rule; Build shows idea fit and per-prize entry steps instead.
- Approach B live extension (side panel, IndexedDB, `chrome.alarms`): stays in TODOS.md; v2 builds only incremental capture and the thread lookback.
- Discord capture (D18): added to TODOS.md only if the next event uses Discord.
- Hand-checking canon (D15): replaced by Opus judge + model-free coverage checks.

## What already exists
- `pipeline/group.ts` `checkGroups` + the retry loop (group.ts:171, 229–280): lifted into the shared verify-and-retry helper (D2); group.test.ts stays unchanged and green (D14).
- `pipeline/roles.ts` `posterRole`: kept as a classifier hint; override authority moves to D19's unspoofable signals.
- `pipeline/redact.ts`: reused for authenticated page text (D12) and Meet openers.
- `pipeline/accumulate.ts` ts-keyed dedupe and `hr compare` keyed recall: reused for thread capture and recall (step 1).
- `pipeline/board.ts` + `board/index.html`: Claim stays; offer ids move from positional to source-anchored (OV5, D21).
- v1 `Rep.opener` field (schema.ts:83): had no generator; live.ts now owns it (OV11).
- config/organizers.json (55 ids, 52 admin/owner-backed) [measured]: the D19 organizer source at Cal Hacks.

## Failure modes
| Path | Realistic failure | Test / handling | User sees |
|---|---|---|---|
| Thread capture | Slack thread-pane selectors drift | DOM fixtures + recall vs export (step 1) | recall drop in `hr compare` |
| Page snapshot | Canon text in iframe/PDF | reported "no text captured" | named in run report |
| canon.ts | prize missed or quote on the wrong field | D15 judge + coverage checks fail the gate | gate failure with unmatched figures |
| Re-extraction | reworded track loses its id | tolerant match; ambiguous → "no longer on the page" (D7) | mark listed, never misattached |
| live.ts link | wrong entity linked | link eval, n printed (OV9) | eval report |
| merge.ts | Slack inside a page change window | "Page and Slack disagree", no winner (D13) | both values |
| Authority | renamed hacker posts a deadline | D19: "unverified poster", never applied | labeled in history |
| POST /fit | foreign origin spends API key | Origin + token → 403 (D6) | n/a |
| /fit API down | model error | tracks unranked + reason (D6) | clear reason |
| Live sync | Slack rate-limit banner mid-run | stop + report where (OV14) | "stopped at …" |
| Restricted-posting detection | notice not in DOM | no channels proposed, report says so (D19) | prompt to list them |
| Step 0 move | sensitive file staged | tracked-path test + `git status --short` shown (D10) | test failure |
Critical gaps (no test, no handling, silent): 0.

## Worktree parallelization strategy
| Step | Modules touched | Depends on |
|---|---|---|
| 0 layout | pipeline/ (event.ts, all path users), .gitignore, tests | −1 |
| 1 thread fixture | extension/ | 0 |
| 2 page sources | extension/ (snapshot action) | 0 |
| 3 canon + eval | pipeline/ (canon.ts, schema.ts, helper), evals | 2 |
| 4 Build + Ship | board/, pipeline/fit.ts, board server | 3 |
| 5 live sources + link | extension/, pipeline/live.ts | 1, 3 |
| 6 merge + Now + Meet | pipeline/merge.ts, board/ | 4, 5 |
| 7 generalize | events/ config only | 6 |
Lane A: 1 → 5 (extension/). Lane B: 2 → 3 → 4 (extension/ snapshot then pipeline/, board/).
Execution order: step 0 alone. Then launch A step 1 and B step 2; both touch extension/ in different files (thread pane vs page snapshot), so coordinate `selectors.ts`. Merge, then B continues 3 → 4 while A does 5 once 3's schema lands. Then 6, then 7.
Conflict flags: extension/src/selectors.ts (steps 1, 2, 5); pipeline/schema.ts (3, 5); board/ (4, 6).

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Effort ratios: scaffolding/tests ~50x, features ~30x, architecture ~5x.

- [ ] **T1 (P1, human: ~1h / CC: ~5min)** — capture — Capture the 29 stretch channels and save thread-pane DOM samples (step −1)
  - Surfaced by: Scope Challenge F3 (D5); OV7 (D21)
  - Files: none (extension run), runs record
  - Verify: `bun run hr compare` per channel; `bun run hr record-run`
- [ ] **T2 (P1, human: ~4h / CC: ~15min)** — pipeline/event.ts — .gitignore first, tracked-path test, per-event layout, `--event` (step 0)
  - Surfaced by: Architecture R-A5 (D10)
  - Files: .gitignore, pipeline/event.ts, pipeline/*.ts path users, pipeline/event.test.ts
  - Verify: `bun test`; user reviews `git status --short`
- [ ] **T3 (P1, human: ~2h / CC: ~15min)** — tests — v1 board fingerprint test with per-field allow-list
  - Surfaced by: Test review T1 (D14)
  - Files: pipeline/board.fingerprint.test.ts, fixture (hashes only)
  - Verify: `bun test`; skip message when data absent
- [ ] **T4 (P1, human: ~1.5d / CC: ~1h)** — extension — Thread capture, uncapped fixture run, paced, stop on error (step 1)
  - Surfaced by: F3 (D5), P1 (D17), OV14 (D21)
  - Files: extension/src/, pipeline/compare.ts
  - Verify: thread recall ≥ 0.9 vs export's 494 replies
- [ ] **T5 (P1, human: ~1d / CC: ~30min)** — extension — Page snapshot with access flag, h1–h6 outline, normalized hash (step 2)
  - Surfaced by: R-F1 (D3), R-A7 (D12), OV5/OV13 (D21)
  - Files: extension/src/, pipeline/schema.ts
  - Verify: Devpost snapshot captured; iframe/PDF reported
- [ ] **T6 (P1, human: ~3d / CC: ~1.5h)** — pipeline/canon.ts — Extraction + verify, source-anchored ids with tolerant match, coverage checks, Opus judge (step 3)
  - Surfaced by: R-A2 (D7), T2 (D15), OV5 (D21)
  - Files: pipeline/canon.ts, pipeline/schema.ts, shared helper from group.ts
  - Verify: D15 gates; tolerant-match threshold calibrated on re-extraction pairs
- [ ] **T7 (P2, human: ~0.5d / CC: ~20min)** — evals — Fit ablation on 94 sponsor-track pairs: run A description only, run B + Built With; event-level prizes listed separately
  - Surfaced by: T3 (D16), R-T3b (D23)
  - Files: evals/fit
  - Verify: recall@3 for A (headline) and B, n=94 each, with the A→B gap and the stack rule's outcome (≥10 overall or ≥20 on the 58 Best Use of X pairs); per-prize table for 21 "Best Use of X" prizes (58 pairs); any-hit for A and B (n=81); 100% quotes verified
- [ ] **T8 (P1, human: ~2d / CC: ~1h)** — board — Build (idea fit, POST /fit guarded, Sonnet) and Ship (step 4)
  - Surfaced by: R-F2 (D4), R-A1 (D6, D16)
  - Files: pipeline/fit.ts, pipeline/board.ts, board/views.js
  - Verify: 403 on bad Origin/token; fit quotes 100% verified; 1440 and 390
- [ ] **T9 (P1, human: ~2d / CC: ~1h)** — pipeline/live.ts — Incremental capture, 48 h lookback + permalink checks, kind-first thread selection, kind classifier, link pass, openers (step 5)
  - Surfaced by: P1 (D17), OV4 (D20), OV10/OV11 (D21)
  - Files: extension/src/, pipeline/live.ts
  - Verify: link eval with n; sync time reported
- [ ] **T10 (P1, human: ~3d / CC: ~1.5h)** — pipeline/merge.ts — Merge timeline, D19 authority, "N asked", Now and Meet (step 6)
  - Surfaced by: R-A3 (D8), R-A4 (D9), R-CQ1 (D13), OV2/OV3 (D19, D21)
  - Files: pipeline/merge.ts, pipeline/roles.ts, board/views.js
  - Verify: unit tests per merge rule; Cal Hacks shows page 09:00 / Slack 09:30
- [ ] **T11 (P2, human: ~1d / CC: ~30min)** — events — Second event by hand; D15 coverage checks on its pages (step 7)
  - Surfaced by: D1, OV6 (D18)
  - Files: events/<slug>/config/
  - Verify: coverage checks pass with no code changes

## Unresolved decisions
None in this review. D16's label precondition was resolved by D23 (won tracks only, 90 public 13.0 winners). Facts to fill: next event and platform (D18).

**D15 wording, resolved by the user 2026-11-06** (the picks were "C) Both, one gating" and "C) Reword + places"):
- **D15 (1), new text:** "Σ (stated cash × stated winners) over each track's quoted '$X in cash' and 'N winners' lines must equal the page's stated prize total; a dropped line fails." This gates. Alongside it, the literal sum of prize amounts is printed as an n/a info line (`prize_amounts`): on Cal Hacks, "prize amounts stated on 37 of 80 prizes, $58890 (page total $204408; the gate is prize_total)".
- **D15 (2), new text:** "Every prize block on the page has exactly one track and at least one prize; the number of tracks equals the number of prize blocks. Within a block, the number of prizes equals the number of stated places (or 1 when none is stated)." `statedPlaces()` in coverage.ts counts places deterministically. A line with an ordinal is a place list: each ordinal is a place ("3rd, 4th & 5th Place" is 3), plus each segment that names a place without one ("Special Recognition: …"). Elsewhere, "top N" after N amounts is N places, and any other "top N" is one award. "Every entrant" prizes don't count. Measured: run 3 passes all 52 blocks. The 78-prize re-run fails exactly one, Hyphenate ("4 stated places, 2 prizes extracted"), which is the case this clause was meant to catch. Before the user picked, the review question said "run 3 passes it"; that was unverified at the time and is now measured.
- D15 (3) is implemented as written (attached or listed); a listed figure doesn't fail.

## Completion summary
- Step 0: Scope Challenge — scope reduced per recommendation (`hr init` deferred, D1; smaller module arrangement, D2)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY`), 1 unverified premise (Hive schedule page)
- Architecture Review: 7 issues found (R-A1–R-A7)
- Code Quality Review: 1 issue found (CQ1)
- Test Review: diagram produced, 39 gaps identified (3 findings: T1–T3)
- Performance Review: 1 issue found (P1)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 2 items proposed to user (`hr init` D1, `hr fetch` D11), both added; 3 existing items updated to point at v2 steps
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review (D16 precondition resolved by D23)
- Outside voice: Claude Plan subagent (native fallback; Codex not installed), completed in 156 s, 22 findings; resolved via D18–D21 and dispositions. Note: D18–D20 used two-option briefs rather than the skill's four-option outside-voice menu.
- Parallelization: 2 lanes, 2 parallel / 6 sequential
- Lake Score: 2/16 = answers picking a 10/10 option / answers scored for Completeness

### Step 4 progress (2026-11-06)

- **P2 / P10, Tracks section and dogfood.** `pipeline/plan.ts` builds Plan's Tracks section with the same ranker, quote check and cache as fit-eval, so the gate's numbers describe what Plan shows. `hr plan --from fixtures/dogfood/hindsight.json` on real canon:
  - **Results:** likely fits for [Anthropic] Claude for Public Benefit, [Apify] Best Use of Apify and [Factory] Best Use of the Factory Droid SDK; also possible: [Figma] Best Design and [Apify] Best Actor. All 4 tracks Hindsight targeted appear. They were targeted, not won (no track prizes), so this isn't a win label. (Entered, per the user on 2026-11-06: Claude for Public Benefit, Factory Droid SDK and Best Use of Apify; not Best Actor, and Figma wasn't submitted.)
  - **Time to the section:** 4,955 ms uncached (n = 1, Sonnet, $0.02), 1 ms cached. Under the 8 s target on one sample; more samples come with the board endpoint.
  - **The three open items, done as the user specified (2026-11-06), in one change. It FAILS the fit gate. Not committed; awaiting the user.**
    - **What changed:**
      - Canon extracts each prize block's full text, sentence by sentence, as repeating requirement and description fields, a criterion per judging sentence, and a new `entry_step` kind (opt_in, supplemental_form, description_mention, submission_field, each with its verbatim sentence). Plan shows entry steps as each track's checkboxes; Ship's checklist reads the same list, keyed by entity id.
      - The ranker may quote only a track's requirement or criterion lines. `checkFit` fails a quote that is the track's name or holds only its words.
      - The reason rule is "combine only stated facts with the quoted line, as a condition". A lint rejects "can/could/may enter", "qualif*", "eligib*" and "guarantee*". Both failures go back to the model.
    - **Re-extraction (`hr canon --force`, $1.77):**
      - Result: 52 tracks, 79 prizes, 10 criteria, 12 + 4 rules, 4 entry steps.
      - Gates: prize_total PASS. prize_blocks FAIL: [Mana] Best Use of Mana states 1 place and got 0 prizes.
      - Completeness, model-free: all 83 text lines inside prize blocks are carried by some quote, so nothing on the page was dropped.
      - The page is the limit. Only 7 of 52 tracks have any requirement or criterion sentence. The rest carry only "$X in cash", "N winners" and an award line, e.g. Anthropic: "$5000 in Claude credits and 1 year of Claude Max 20x + Office Hours".
      - The 4 entry steps: Vultr sign-up, GoDaddy registration, Apify's "Best Actor award for building an actor", and Bright Data's "In your project description, indicate which track … you are submitting for".
    - **Fit eval on that canon (n = 94 pairs):**
      - recall@3: A 9/94, B 11/94.
      - recall@5: A 9/94, B 11/94.
      - Gate on run B: recall@3 55/94 → 11/94 (lost 47, gained 3, exact McNemar p = 3.7e-11). recall@5 68/94 → 11/94 (lost 60, gained 3, p = 9.0e-15). **FAIL: 11.7% < 67%.**
      - Cause: the ranker can choose only among the 7 quotable tracks.
    - **State:**
      - The product code is in the working tree, uncommitted. data/canon.json holds the new extraction.
      - Reverting needs no API call: run 3's extraction is still in data/canon_extractions.json under the old prompt hash.
      - Decision for the user: where requirement sentences come from (Slack sponsor posts in step 1, sponsor pages the prize blocks link), or how tracks with none appear in Plan.

  - **Tiered evidence (user 2026-11-06), on v2.** The strict version is kept on `exp/strict-quotes` (9dc4efa), not merged.
    - **Tiers**, computed in `trackCards` from canon, never by the model:
      - (1) **stated**: a requirement or criterion sentence. Quote + reason.
      - (2) **title**: no such sentence, but the block says more than an amount. The title is the evidence, Plan labels it "requirements not stated", and Booths asks the rep "What does ‘<track>’ reward?".
      - (3) **cash_only**: the block restates only amounts or winner counts. Title as evidence, ranked last, never "likely".
    - `checkFit` enforces each tier's quote rule, the never-likely rule and the last place, so the eval scores the order Plan shows.
    - Kept from the strict version: the reason rule (stated facts + the quoted line or title, as a condition), the eligibility lint, entry steps, and the name-only check on stated tracks.
    - Step 1 upgrades tiers with no extra code: a Slack sponsor post merged as a requirement or criterion makes the track stated (tested).
    - **Mana fix:**
      - `checkCanon` now runs the gating coverage checks on its own answer and sends failures back. The first run fixed Mana and then split Meta's no-place block into 3 prizes.
      - So the prompt now says "a track that names no places gets exactly one prize … whatever its winner count and however many lines its award has", with Meta's and Mana's shapes as examples.
      - Result (prompt 631eb71c8c39d023, 3 calls, $2.54): prize_total PASS, prize_blocks PASS (52/52 blocks, 80 prizes), 4 entry steps.
    - **Tiers on Cal Hacks:**
      - 7 stated, 30 title, 3 cash_only. The cash_only three are Visa, Mana and [Apify] Best Use of Apify, whose block lists only place amounts.
      - That's 40 sponsor tracks; the other 12 are event-level and aren't ranked.
    - **Fit eval, same 94 pairs ($2.06, 162 rankings):**
      - recall@3: A 33/94, B 53/94.
      - recall@5: A 39/94, B 68/94.
      - Gate on B: recall@3 55 → 53 (lost 6, gained 4, exact McNemar p = 0.754). recall@5 68 → 68 (lost 4, gained 4, p = 1.000). **PASS, not an improvement.**
      - The cash_only rule accounts for most losses (Apify Best Use ×3, Mana ×2, Visa ×1 across @3 and @5). Gains: GoDaddy, Apify Best Actor, Notability, Bright Data, Spacetime, Vultr.

  - **Title products, label cap and tier floor (user 2026-11-06). Committed `fa1210b` after a complete gate run (below); the first run was cut short.**
    - **`titleProducts`** works in code from the title and sponsors.json aliases. A product is the X of "Use of (the) X" when X holds the sponsor's name or is a proper name and not a gerund phrase, or the sponsor's name or an alias outside "sponsored by …".
      - Examples: Claude for Public Benefit → Claude, Gemini API, Factory Droid SDK, x402 + Coinbase.
      - Visa's "Reimagining Shopping sponsored by Visa", Apify's Best Actor and Figma's four titles name none.
    - **Label cap (post-ranking, in `capLikely`):** a title-tier "likely" stays only when a product its title names is in the user's idea or stack (whole word, or its core without API/SDK/AI/Model/Studio/Builder/Agent/Platform/Cloud). Otherwise it shows "possible", marked capped. Ranking and the eval are untouched.
    - **Tier floor:** a title naming a product is at least title-only. Tiers go from 7 / 30 / 3 to 7 / 32 / 1; Mana and Apify Best Use move up, Visa stays cash_only.
    - **Fit eval (162 rankings, $1.86): incomplete.**
      - The API account hit its usage limit: "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."
      - 16 rankings failed (8 projects × A and B: touchspace, trip-assist-ai, unstep, vigil-aewt3u, vision-os-4ckmq3, vouch-7i3bft, warden-p3uifn, yardsale), and their pairs counted as misses.
      - As reported, the gate reads recall@3 50/94 and recall@5 60/94 (FAIL < 67%). That isn't a valid result.
      - Diagnostic on the 86 completed pairs: recall@3 50 → 50 (lost 2, gained 2, p = 1.0), recall@5 61 → 60 (lost 7, gained 6, p = 1.0).
      - Passing needs 63/94; the 8 failed projects held 7 baseline @5 hits.
    - **Complete run** (2026-11-06T21:56Z, after the limit was lifted; re-confirmed from cache with 162 rankings, 0 not cached, 0 failed):
      - recall@3: A 33/94, B 55/94.
      - recall@5: A 38/94, B 67/94.
      - Gate on B: recall@3 55 → 55 (lost 3, gained 3, exact McNemar p = 1.000). recall@5 68 → 67 (lost 7, gained 6, p = 1.000). **PASS, not an improvement.**
      - Recorded as the new baseline (below).
    - **Hindsight dogfood on the committed Plan** (4,381 ms uncached, n = 1, $0.01):
      - Likely: [Apify] Best Actor (stated, quoting "Project must be using Apify in a meaningful way.", with its "Building an actor" entry step), plus three title-only tracks, [Anthropic] Claude for Public Benefit, [Factory] Factory Droid SDK and [Apify] Best Use of Apify. Each of those three kept "likely" because its title's product (Claude, Factory Droid SDK, Apify) is in the stack.
      - Also possible: [Figma] Best Design, ranked "possible" by the model. Its title names no product, so the cap would have lowered a "likely" anyway.
      - Booths asks Anthropic, Factory, Apify and Figma "What does ‘<track>’ reward?". All 4 targeted tracks appear; targeted, not won.

  - **Project-aware Booths questions (user 2026-11-06), in code from the plan item, no model call.**
    - **Templates:**
      - Stated tracks: "We use <stack product> <use>; does that count as ‘<quoted requirement>’?"
      - Title-only tracks: "…; what does ‘<track title>’ reward beyond that?"
    - **Where each part comes from:**
      - <stack product> is the user's stack entry naming a title product, the sponsor or an alias. It's the entry itself when that's little more than the product ("Claude API"), else the product as spelled there ("Figma" from "UI designed in Figma").
      - <use> is the description's own "to/for …" clause about the product, or else "for <the description's first sentence>", which says only that the product is used in this project.
    - **Hindsight's description states no use for any tool**, so all five questions use the fallback, e.g. "We use Claude API for a transfer planner for community-college transfer students; what does ‘Claude for Public Benefit’ reward beyond that?".
    - **Edge cases:**
      - A title-only track whose products the user doesn't name keeps the plain "What does ‘<track>’ reward?".
      - A stated track without one gets no question.
      - cash_only tracks get none.
    - Each question carries its grounds: the stack entry, the description phrase, and the page's quote or "states no requirements".

  - **P1, the Plan tab in the board (2026-11-06).** Plan is the default tab; Claim is the v1 board, unchanged apart from the drawer focus fix below.
    - **Server (`hr board`):**
      - `GET /plan/meta` gives the track count, the timezone, the hacking start and the times Next for you can show (from canon, built by `planMeta`). The times are the event config's live schedule items (Slack-sourced, so they carry the 9:30 extension); canon's rule deadlines are used only when there's no schedule.
      - `POST /plan` is the board's one write route (D6). It needs the board's own Origin plus this run's token, which the server writes into the served page's `hr-token` meta tag; otherwise it returns 403.
      - Bodies over 16 kB are refused. `parsePlanBody` caps the description at 2,000 characters, 20 items, 80-character names and 160-character uses.
      - It runs `planTracks` (same ranker, cache and label cap as `hr plan`), adds each track's drawer detail (`trackDetail`: requirements, criteria, other block text, prizes, verbatim) and the code-built Booths questions.
    - **Input:**
      - A description field plus one row per stack item: a name ("a tool, API or service") and the optional use ("what it does in your project").
      - Pasting "Apify: pull catalogs, Vercel" into a name field splits it into rows at the first ": ", as the CLI does. Enter moves name → use → next item.
      - After submit it collapses to "first sentence · stack names" with Edit. It's saved in localStorage per event and re-run on load (from the fit cache).
    - **Tracks** (one tile, rows are buttons, D3/D7): name, reason, the entry-step checkboxes on likely rows, then mono metadata: fit word, "requirements not stated" on title-tier tracks, and a devpost ↗ link. The "Also possible" line comes before the possible rows (D12). A row opens the drawer: why it fits (quote, or the title-as-evidence note), entry steps with their quotes, requirements, judging criteria, other text, prizes and the Devpost link. Step ticks are stored by entry_step id, so Ship can read the same ones.
    - **Booths** sit in the plain band (D8), one heading per sponsor, each question with Copy and its source. Sessions, People and Credits aren't built and are left out, not shown empty. Until they exist, Booths spans the band and Tracks spans 12 columns (the spec's 8 | 4 needs Credits).
    - **Next for you:** the next schedule item after the hacking start. Cal Hacks' config has no start, so an item shows only within 24 h of it. `?now=` checks it: Oct 25 08:00 shows "Sun 9:30 AM · Devpost submission deadline extended · in 1 h 30 min"; Oct 20 and today hide it.
    - **States (D4):** before typing, "52 tracks on Devpost; your plan appears once you describe your project"; "Matching…" with aria-busy; on failure, "Couldn't rank tracks just now; trying again on the next change". An empty description gives "Describe your project first." A polite live region announces the result.
    - **Hindsight in the browser** (headless gstack browser, 1440 / 390 / 360, no console errors, no horizontal scroll at 360): the same 4 likely + 1 possible as `hr plan`, in 5 s uncached. A step ticked in the drawer ticks the row too and survives a reload. Closing the drawer puts focus back on what opened it; this also fixed Claim's drawer, which left focus on the page.
    - **Hindsight's used-for values:** drafted from the Hindsight repo (db92f7d) and its Devpost write-up, each from a named call site, and saved after the user confirmed all three (2026-11-06). The fixture's stack is now a list of {name, used_for}, since a used-for can contain commas.
  - **Gaps (user 2026-11-06).** For each likely track, the stated requirements and entry steps are checked against the project, and unmet ones are flagged with facts from both sides, each with its source. Never a verdict on eligibility.
    - **Inputs** (`pipeline/gaps.ts`):
      - Requirements: the likely tracks' canon requirement sentences and entry-step quotes, each once per track. Title-tier tracks state none, so they have nothing to check.
      - Project facts: the description's sentences, each stack line ("Apify: scrape …"), and, when a repo is linked, its lines naming a likely track's products (`pipeline/repo.ts`). Repo lines are found in code: README first, then code. Lockfiles, tests, env files, secret-looking lines and symlinks are skipped, with at most 4 lines per file and 24 per product. Each keeps its path:line and a link at the commit.
    - **One Sonnet call** (medium effort, cached in data/gaps_cache.json) proposes gaps by id. `checkGaps` rejects:
      - an unknown id;
      - a project quote that isn't in its fact;
      - a gap citing no project fact, since a requirement the project doesn't mention isn't a gap;
      - a sentence using the eligibility lint's words or any verdict/advice word (counts, meets, fails, should, …).
      The requirement's quote comes from canon, not from the model.
    - **Repo:** public `https://github.com/<owner>/<repo>` links only, cloned shallow into `~/.cache/hackrecon/repos`. Nothing in the clone is run.
      - The first version cloned into the event's data/ folder, and `bun test` then picked up Hindsight's three TypeScript test files. All three failed while loading (their dependencies aren't installed), so none of their code ran.
      - Fixed twice over: clones now live outside the project, and bunfig.toml ignores `**/data/**`, `**/node_modules/**` and `events/**` for tests.
    - **Hindsight** (`hr plan --from fixtures/dogfood/hindsight.json`, repo db92f7d, 115 repo lines; 2,670 ms, $0.02):
      - One gap on [Apify] Best Actor: "Best Actor asks for building an actor; the repository's apps/actor README says its own Actor is not used and Radar runs Apify's existing Cheerio Scraper."
      - It cites the page's "We have a Best Actor award for building an actor for this event.", `apps/actor/README.md:7` "Not used: Radar runs Apify's Cheerio Scraper (DECISIONS.md D-002)." and `README.md:142` "Apify's existing Cheerio Scraper Actor fetches curated calendars and listings."
      - Without the repo the same check finds none: the description and stack don't say how Apify is run. The "none found" line says that doesn't mean the requirements are met.
      - **What this shows (corrected 2026-11-06):** Hindsight entered [Apify] Best Use of Apify, not Best Actor. The team didn't build an Actor and didn't enter the Actor track. So the gap check agrees with the team's own choice; it did not cost them a track. The demo claim is that the check finds, from the code alone, the reason a team would skip Best Actor. It is not that it saved a submission.
    - **Ranking moved with the used-fors:** the new stack lines changed the ranker's request (a new cache key). Likely is unchanged; the possible Figma track is now [Figma] Best Use Case instead of Best Design.
    - **Board:**
      - The input has an optional "Repo link" field.
      - After the tracks show, the gap check runs on the server's own ranking, never a track list from the page. (Built as `POST /plan/gaps`; since P2 it is a step of `POST /plan/stream`.)
      - A row shows "Gap: …". The drawer's Gaps section lists the sentence, the page's quote and each project quote with its source (repo lines link to GitHub at the commit).
      - Checked in the headless browser at 1440 and 360.

  - **Plan output fixes and Ship's recheck engine (user 2026-11-06).**
    - **Glued words ("actorfor", "universityguide"):** the printer never dropped a space. Its output has both spaces and no unusual characters. Its lines ran to 286 characters, and the terminal soft-wrapped them, where a break can lose its space when shown or copied. `hr plan` and `hr ship` now wrap at word boundaries themselves (`pipeline/wrap.ts`), with a test that every word and space survives.
    - **CLI:** each track's gaps print under its row, as on the board. A likely track with stated requirements and no gap says "Gaps: none found" with the not-a-verdict line.
    - **Booths from gaps:** the gap check now also returns `instead`, a verb phrase after "We", linted like the sentence. A track with a gap asks "We <instead>; what does ‘<requirement>’ need from us?", grounded in the gap's quotes. A sponsor's questions are one block (one Copy), and a shared opening is said once.
      - Hindsight's Apify block: "We run Apify's prebuilt Cheerio Scraper from the Store instead of an Actor of our own; what does ‘We have a Best Actor award for building an actor for this event’ need from us? We use Apify to scrape campus calendars, club feeds, hackathon listings and university guide pages; what does ‘Best Use of Apify’ reward beyond that?"
    - **Ship recheck on Hindsight, engine check** (`hr ship --enter "Best Actor, Claude for Public Benefit, Factory Droid SDK, Best Use of Apify"`). These four likely tracks were a stand-in set chosen to exercise the engine. They are not what Hindsight entered:
      - Hindsight @ db92f7d, checked Fri Nov 6, 3:23 PM PST.
      - 2 requirements and entry steps, 115 repo lines, 1 open gap (Best Actor) with 3 repo quotes. The other three tracks state no requirements.
      - The second run reused the result ("the commit hasn't changed since").
    - **Hindsight's real entered set (user 2026-11-06, now `entered` in the fixture):** Claude for Public Benefit, Factory Droid SDK and Best Use of Apify. Figma was selected but not submitted. `hr ship` with that set: none of the three states a requirement or entry step, so there is nothing to check, and Ship says so rather than "none found". The Best Actor gap never applied, because the team didn't enter that track.
    - **Cached gaps** now re-point their repo links at the commit just read, so a cache hit on a new commit doesn't link to the old one.
    - **TODOS:** repo lines are picked by product name, so requirements naming none (voice, deployment, open source) can't find counter-evidence yet.

### Fit baseline before Slack requirements (2026-11-06)

`review/fit_baseline.json` is now the complete tiered run above (run 2026-11-06T21:56Z, set with `hr fit-eval --set-baseline` from cache), replacing the T7 baseline. This is the measurement step 1 compares against: Slack sponsor posts merged as requirements or criteria move tracks from title-only to stated, and the next gate run is paired against these 94 pairs.

- **Setup:** canon prompt 631eb71c8c39d023 (Devpost overview + rules), 40 sponsor tracks, tiers 7 stated / 32 title-only / 1 cash-only. Ranker claude-sonnet-5-5 at effort medium.
- **Run B by tier:** title-only 80 pairs, 45 at @3 and 55 at @5. Stated 13 pairs, 10 and 11. Cash-only 1 pair, 0 and 1.
- **The gate floor stays at the user's 67%.** It was set as the old baseline (72.3%) minus about 1 SE. The new baseline's recall@5 is 71.3%, 1 point lower.
- **Columns:** A is the description only, B adds Built With. n is the won pairs per track. The eval's own printed table is the "Best Use of X" subset at @3.

| Track | Tier | n | A @3 | B @3 | A @5 | B @5 |
|---|---|---|---|---|---|---|
| [Spacetime] Best Use of Spacetime | title | 9 | 2 | 8 | 2 | 8 |
| [Fetch.ai] Best Use of Fetch.ai | title | 7 | 3 | 6 | 3 | 6 |
| [Apify] Best Use of Apify | title | 5 | 0 | 1 | 0 | 2 |
| [CRS] Best Use of CRS API | title | 5 | 2 | 4 | 2 | 4 |
| [Hyphenate] The Hyphenated Enterprise: Autonomous Systems for Finance | title | 5 | 4 | 4 | 4 | 5 |
| [Notability] Best Use of Notability | title | 5 | 0 | 0 | 0 | 2 |
| [Apify] 1st Customer Award | title | 4 | 0 | 0 | 0 | 0 |
| [Fetch.ai] Best Use of ASI:One | title | 4 | 1 | 3 | 1 | 3 |
| [Mana] Best Use of Mana | title | 4 | 0 | 2 | 0 | 2 |
| [Anthropic] Claude for Public Benefit | title | 3 | 3 | 3 | 3 | 3 |
| [Atlassian] Best Agent / Best Security Solution for Agents | stated | 3 | 3 | 3 | 3 | 3 |
| [Bright Data] Best Agent/App Using Public Web Data sponsored by Bright Data | title | 3 | 1 | 3 | 1 | 3 |
| [Convex] Best use of Convex | stated | 3 | 1 | 3 | 1 | 3 |
| [Meta] Meta/Facebook: Bringing People Closer Together with AI | stated | 3 | 1 | 1 | 2 | 1 |
| [Bitdeer AI] Best Use of Bitdeer AI Model Studio | title | 2 | 0 | 0 | 0 | 1 |
| [Coinbase] Best Use of x402 by Coinbase | title | 2 | 2 | 2 | 2 | 2 |
| [Elastic] Best use of the Elastic Agent Builder on a Serverless Instance | title | 2 | 0 | 2 | 0 | 2 |
| [Microsoft] Built for the Real World (1st), Customer Impact Award (2nd) | title | 2 | 1 | 0 | 2 | 0 |
| [Moss] Long Horizon Agent | title | 2 | 1 | 0 | 2 | 1 |
| [Apify] Best Actor sponsored by Apify | stated | 1 | 0 | 1 | 1 | 1 |
| [Armadin] Best Security Hack | title | 1 | 1 | 1 | 1 | 1 |
| [Capital One] Best Use of Nessie | title | 1 | 0 | 0 | 0 | 1 |
| [Cartesia] Best Use of Cartesia | title | 1 | 1 | 1 | 1 | 1 |
| [Creao AI] Best AI-First Disruptor | title | 1 | 0 | 1 | 0 | 1 |
| [Creao AI] Best One-Person Company | title | 1 | 0 | 0 | 0 | 0 |
| [Creao AI] Best Team Empowerment | title | 1 | 0 | 0 | 0 | 1 |
| [Factory] Best Use of the Factory Droid SDK | title | 1 | 1 | 1 | 1 | 1 |
| [Figma] Best Design | title | 1 | 0 | 0 | 0 | 0 |
| [Figma] Best Stage Log | title | 1 | 0 | 0 | 0 | 0 |
| [Figma] Best Use Case | title | 1 | 1 | 1 | 1 | 1 |
| [Figma] Most Creative | title | 1 | 1 | 1 | 1 | 1 |
| [MLH] Best Domain Name from GoDaddy Registry | stated | 1 | 0 | 0 | 0 | 1 |
| [MLH] Best Use of Gemini API | title | 1 | 1 | 0 | 1 | 1 |
| [MLH] Best Use of Snowflake API | title | 1 | 1 | 1 | 1 | 1 |
| [MLH] Best Use of Solana | title | 1 | 0 | 0 | 0 | 0 |
| [MLH] Best Use of Tiger Data | stated | 1 | 0 | 1 | 0 | 1 |
| [MLH] Best Use of Vultr | title | 1 | 0 | 0 | 0 | 1 |
| [Moss] Best Use of Moss | title | 1 | 0 | 0 | 0 | 0 |
| [SpaceXSI] Make it Legendary with SpaceXSI | stated | 1 | 1 | 1 | 1 | 1 |
| [Visa] Best use of Reimagining Shopping sponsored by Visa | cash_only | 1 | 0 | 0 | 1 | 1 |
| **All (40 tracks)** | | **94** | **33** | **55** | **38** | **67** |

## Design Review (plan-design-review, 2026-11-06): Plan + Ship

Target: §4 Views, Plan (new default tab) and Ship. Mode: Operate. No mockups: the gstack designer has no OpenAI key (`$D setup`), so every pass ran on text against DESIGN.md and the built Claim board. No outside voice (Codex not installed). Dogfood input (user): Hindsight, a transfer planner for community-college transfer students; stack Vercel, FastAPI, Claude API, Apify, Factory Droid SDK, Figma; targeted Anthropic, Factory Droid SDK, Figma and Apify; won no track prizes (https://devpost.com/software/hindsight-68sruh).

| Pass | Before | After | What moved it |
|---|---|---|---|
| 1 Information architecture | 4 | 9 | D2 layout + Next for you; D3 row at rest vs drawer |
| 2 States | 2 | 9 | D4 state table (no instructions to the user) + streaming; D5 live updates and the urgent bypass |
| 3 Journey | 5 | 9 | Storyboard; D6 Judging, still-claimable, Follow up |
| 4 AI-slop risk | 6 | 9 | D7 rows are buttons, only two tiles; D8 one borderless band. Hard rejection #7 (stacked cards) cleared |
| 5 Design system | 7 | 9 | D9 tabs and checkbox in DESIGN.md |
| 6 Responsive + a11y | 5 | 9 | D10 one breakpoint set, tabs fit or scroll, Ship pinned near the deadline; D11 announcements |
| 7 Unresolved | n/a | 2 resolved | D12 likely + Also possible (recall@5 added); D13 Ship layout + last hour |

Overall 4.8 → 9.0 (mean of passes 1–6). Each pass stops at 9, not 10, because none is checked against pixels yet; /design-review after step 4 closes that.

Litmus (Pass 4): product unmistakable on the first screen, YES (event name, your project, Next for you). One anchor, YES (Tracks). Scannable by headings, YES. One job per section, YES. Cards necessary, YES after D7 (two). Motion, none beyond done fades. Premium without shadows, YES (DESIGN.md has none on tiles).

Global UI rule, patterns this plan uses: **mono fonts**, for metadata and codes only, as DESIGN.md already does, because codes are retyped on phones. **One bordered container type**: two tiles, since Tracks and Credits are the anchors (D7). **The "New" marker**, a mono status word, not a pill, because live updates need it (user rule). The gradient field carries no text (D8). No tags or pills, eyebrows, section numbering, ALL CAPS, dividers or Instrument Serif.

**NOT in scope (design):** a dark theme (DESIGN.md: light for venue halls); mockups (no key; /design-review renders the real page instead); Now and Meet layouts (step 6); the 13px "small" type step (DESIGN.md's open question, unchanged).

**What already exists, reused:** tile, drawer (440 px right sheet, 88vh bottom sheet), code chip, ghost Claim button, mono metadata, the done fade at 42%, the 12-col grid, breakpoints, the focus ring, and Meet's copy-only opener pattern for questions and pitches.

**Implementation tasks (step 4):**
- [ ] **P1** Plan layout and rows (D2, D3, D7, D8, D12) in `board/`. Verify: /design-review at 1440, 390, 360. *Built 2026-11-06 and checked with /browse at those widths (Step 4 progress); the /design-review pass is still to run.*
- [ ] **P1b** Prefill from a repo link (user 2026-11-06, moved from TODOS). A pasted public GitHub link drafts the description, the stack and each item's used-for, each draft shown with its source: the file and line, or the README / Devpost line. The user confirms each draft one by one. Only confirmed drafts are saved; an unconfirmed field stays empty.
  - **Sources:** README, the dependency files (package.json, pyproject.toml) for the stack, and the call sites of each stack product for its used-for. The Devpost Built With list when a Devpost link is given too.
  - **Rules:**
    - Repo text is untrusted data, read through `pipeline/repo.ts` (outside the tree, no symlinks, nothing run).
    - A draft states only what its source line shows.
    - Where the code contradicts a claim (Hindsight lists Apify but runs the Store's Cheerio Scraper; `apps/actor` is a placeholder), the draft says what the code does.
  - **Verify (user 2026-11-06, replacing the Hindsight-only check):**
    - **Smoke test:** Hindsight's link reproduces the three used-fors the user confirmed by hand, with their files.
    - **Eval:** Cal Hacks 13.0's 90 winners with a public GitHub repo (`hr prefill-eval`; links read from their public Devpost pages into `fixtures/fit/repos13.json`). (a) Recall of each project's Devpost Built With from the repo-drafted stack. Strict: same name once case and punctuation are dropped. Loose: also one name's words inside the other's. No alias table. (b) Fit recall@3 and @5 with the drafted stack in place of Built With (run C), paired against the baseline's run B (58.5% and 71.3% on all 94 pairs) on the same pairs, with McNemar.
    - **Tests:** a draft with no source line, a quote not in its line, or a used-for citing only a dependency line is refused. Nothing is saved before confirmation (board test, with the UI).
    - State the cost of any run over $1 first.
  - **Built so far (2026-11-06):**
    - **Engine:** `pipeline/prefill.ts`, `hr prefill --repo`, and `hr prefill-eval`.
    - **Facts picked in code:** README lines, a file-type and config summary, each declared dependency's line, and where each is imported (up to 6 files, with the file's opening comment).
    - **Model:** one Sonnet call drafts; every citation is checked like the gap check.
    - **Repos:** now partial clones with no working tree (blobs over 300 kB stay on GitHub), read from git's objects. Nothing from a repo is a file on disk.
    - **Reachability:** of the 90 winners, 86 link a GitHub repo and 79 are readable. The other 7 are gone or private. 4 of the readable ones were `http://` links, now read over https.
  - **Smoke test (Hindsight):** partial.
    - Apify: "scan campus sources and read university guide pages". Matches the confirmed use.
    - Claude API: "parse transcripts and class schedules, and answer student questions with sources". Misses the fit reasons and the university guide.
    - Droid: "scan campus sources on a schedule and rank what it finds". Misses repairing a broken extractor.
    - Reading 6 import sites per dependency instead of 2 fixed the Claude draft.
  - **Eval run (2026-11-06; 79 repos; $3.52 Sonnet, plus the $0.11 pilot):**
    - **(a) Built With recall:** strict 50.8% (599/1180 tags), loose 62.3% (735/1180), per-project mean 63.0%. 70 of the projects have a Built With list. The draft averages 16.4 items.
    - **Most-missed tags:**
      - Naming, which a rule without aliases counts as a miss: anthropic 19 (vs "Claude API"), node.js 17, claude 8, javascript 8.
      - Sponsor products, which matter for fit: elasticsearch 7, mcp 7, vultr 5, fetch.ai 4, agentverse 4, figma 5, mana 6.
      - Dev tools and categories: vitest 7, pytest 6.
    - **(b) Fit run C vs run B, on the 81 won pairs those projects have (of 94):**
      - recall@3: 60.5% (B) → 58.0% (C); 5 lost, 3 gained; McNemar p = 0.73.
      - recall@5: 74.1% (B) → 70.4% (C); 6 lost, 3 gained; McNemar p = 0.51.
      - No significant difference either way. C's recall@5 of 70.4% is above the 67% gate floor.
  - **Sponsor-product pass (user 2026-11-06):**
    - **What it does:** for each sponsor product on the event page, `config/products.json` lists the names people use, the npm, PyPI and crates.io packages (each checked to exist on its registry), the API hosts, and distinctive code terms. The repo is searched in code with no model call. A product found that the draft lacks is added with its file:line and no used-for. The same table maps Built With tags in scoring ("anthropic" → Claude API).
    - **What counts as evidence:** dependency lines, real import statements matched per language, API hosts in code or config, and terms in code files only.
      - README and docs don't count. Neither do mock, seed, fixture and data folders, tool settings (.claude/, .github/), or lockfiles.
      - Generic words are left out (claude, gemini, azure, jira, timescale, convex, snowflake, llama, droid, moss), so those products are found by package and host only.
      - Mana has no package, host or distinctive term, so nothing can be found for it.
    - **Bugs fixed before the run, found by reading every added product's first line:**
      - A scoped package (`@factory/droid-sdk`) left an empty Python import pattern, which matched every `from . import`. That was 23 bogus Droid hits.
      - Docstrings like "from Cartesia" matched as imports.
      - A booth list in mock data matched seven sponsors.
    - **Result on the cached drafts (79 repos; $0.47 for 38 new fit rankings):** 66 products added to 38 projects.
    - **(a) Built With recall:**
      - Model draft: strict 50.8%, loose 62.3%, loose + alias table 65.5% (773/1180).
      - With the pass: strict 53.1%, loose 64.5%, loose + alias table 68.3% (806/1180).
    - **(b) Fit vs run B on the same 81 pairs, C − B with a 95% interval (Agresti–Min paired):**
      - Model draft (C): @3 −2.5 points (−9.5 to +4.7); @5 −3.7 (−11.0 to +3.8).
      - With the pass (C+): @3 58.0%, −2.5 (−8.6 to +3.8); @5 71.6%, −2.5 (−9.5 to +4.7).
      - The pass recovers one @5 pair. Every interval contains 0. At n = 81 the data can't rule out a loss of up to about 10 points against the team's own Built With list, or a small gain.
  - **Board, confirm each draft (user 2026-11-06):**
    - Under the repo link, "Draft from this repo" calls `POST /plan/prefill` (same Origin and token guard; the draft is cached per request, so a repeat costs nothing). It lists one row per draft: the description, then each stack item.
    - Each row shows the draft, then its source lines: the path:line links to GitHub at the commit, and the quote follows.
    - A stack item the sponsor pass found says "Found in the code; no line says what it does."
    - "Use" fills that one draft into the form. The description replaces the text. A stack item fills the row with its name, keeping a use the user typed, or takes a blank row or a new one. "Skip" drops it.
    - Nothing is stored until "Make my plan", as for anything typed.
    - The logic is `board/prefill.js`, inlined by `hr board` because the CSP allows inline scripts only. Its test (`pipeline/prefill-board.test.ts`, linkedom) checks:
      - nothing reaches the input before Use, and each click hands over exactly one draft;
      - links that aren't GitHub show as text, and draft text is escaped;
      - the module never touches storage, and the page saves the input only on submit.
    - Checked in the headless browser on Hindsight at 1440 and 390: 17 drafts, focus moves to the list, storage is empty before and after Use, and only the used item is saved on submit. No console errors, no horizontal scroll.
- [ ] **P2** Parallel streaming sections with cache-first results (D4), and time-to-first-section logging. Verify: measured on Hindsight, target < 8 s.
  - **Built 2026-11-07, for the sections that exist (tracks, booths, gaps):**
    - `POST /plan/stream` (same Origin + token guard) replaces `POST /plan` and `POST /plan/gaps`. It sends NDJSON, one line per section as it's ready (`pipeline/planstream.ts`).
    - **Order:** tracks, then booths built from them, then gaps, then booths rebuilt from the gaps, then `done` with the time to the first section.
    - **Overlap:** the repo is cloned (`checkoutRepoAsync`) while the tracks are ranked, not after them. Each step reads its cache first (fit and gap caches, by input hash).
    - **Board:** reads the stream line by line. Each section has its own `aria-busy` and paints on arrival. A new input aborts the previous request. A stream that ends early marks its unsent sections failed, never "Matching…" forever. The polite announcement fires once, on `done` (D11).
    - **Logging:** every request appends `{first, total_ms, sections: {from, ms}}` to `data/plan_timings.jsonl`. The description and stack are not logged. `hr plan` runs the same stream in-process; `--fresh` skips both caches to time an input as if new.
    - **Measured on Hindsight (`fixtures/dogfood/hindsight.json`, repo linked):**
      - Uncached (`--fresh`, n = 5): first section (tracks) at 4,072–4,474 ms, median 4,126 ms. All sections at 6,556–7,381 ms.
      - Cached: tracks at 8 ms, all sections at 112 ms.
      - In the headless browser at 1440, uncached (a one-item stack, so a new cache key): "Matching…" at 96 ms, tracks and booths at 4,418 ms, booths rebuilt from the gap at 7,107 ms. No console errors.
      - **Under the 8 s target on every sample.** n = 5 on one input and one machine; it says nothing about slower inputs or a cold clone.
    - **Not built: Credits, Sessions and People.** No step-4 task specifies how they match the input, so there's nothing to stream for them yet. Each joins `planStream` as its own task, emitting into the same queue in settle order; the stream already takes them unordered.
- [ ] **P3–P5** Credits, Sessions and People (user 2026-11-07). These are deterministic joins with no model calls, streamed by `planStream` after gaps as the sections `credits`, `sessions` and `people`, in that order, then `done`. They are code-built, so they need no cache and cost nothing.
  - **The sponsors they join on (shared):** sponsors in the user's stack, plus the sponsors of the likely tracks.
    - A stack item names a sponsor when the sponsor's name, a `sponsors.json` alias or a `products.json` product name appears in it as a whole word (fit.ts `productMentioned`), e.g. "Claude API" → Anthropic.
    - Each sponsor carries why it's there: "in your stack: Claude API" or "likely track: [Apify] Best Use of Apify".
    - Possible tracks don't add sponsors.
  - **Now:** the server's clock. `hr plan --at <ISO>` replays an instant.
  - **P3 Credits:** Claim's offers (`data/board.json`, built by `hr board` from the grouped offers) whose sponsor is in the set, first posted at or before now, and still open: no stated limit, or a limit after now.
    - **Order:** soonest limit first, then offers with no stated limit, by first post.
    - **Quote:** the offer's excerpt, checked verbatim (whitespace-normalized) against the text of one of its posts. An offer whose quote fails is dropped.
    - **Row:** the value (value_short, else the title), the quote, then mono metadata: why · "closes Sat 6:00 PM" · the claim step · the code · source ↗.
    - **None:** "No offer posted so far matches your stack".
  - **P4 Sessions:** classifier items of kind `workshop` (workshops, talks, office hours) with a start time, whose sponsor is in the set, starting after now and before the submission deadline.
    - **Submission deadline:** event.json's unsuperseded schedule entry naming the submission (Cal Hacks: "Devpost submission deadline extended", Sun 9:30 AM). With none, sessions are upcoming only and the section says no deadline is known.
    - **Order and quote:** by start time. One per sponsor and start time. The quote is the post's first line, verbatim, and it is the row's name.
    - **Row:** the quote, then mono metadata: start time · sponsor · why · source ↗.
    - **None:** "No upcoming session from these sponsors before the submission deadline".
  - **P5 People:** reps for each likely track's sponsor, keyed by Slack user ID with person links (people.ts).
    - **Who counts:** sponsor-side posters (`rolesById`) in that sponsor's channels, posted at or before now. Bots and copies of thread replies also sent to the channel are excluded, as on the Claim board.
    - **Each rep shows:** the display name from their latest post, the number of accounts when more than one, the first post's time, its first line (verbatim) and its link, and the post count.
    - **Order:** sponsors in likely-track order; reps by first post.
    - **Layout:** People renders inside "Booths and reps", under that sponsor's questions. This replaces D2's separate People column: a rep and the question to ask them belong together, and a third column would repeat the questions. The band is now Sessions | Booths and reps, 1 : 2.
    - **Names:** Plan shows reps' display names. It is the user's own view; the Claim board's demo mode still hides them.
    - **None:** "No rep of a targeted track has posted yet".
  - **Layout (D2, D7):** Credits is the second tile, Tracks 8 | Credits 4. Tablet: Tracks 12, Credits 12, band 12. Phone order: input, Tracks, band, Credits.
  - **Verify:** unit tests on each join (sponsor set, open and expired offers, a failed quote, the deadline cut, person links); Hindsight's output for each section, at a stated instant.
  - **Built 2026-11-07** (`pipeline/planjoin.ts`; `planStream`'s `joins`; `hr plan --at`; the board's Credits tile, Sessions column and reps under Booths):
    - **Tests:** joins (planjoin.test.ts) and the stream: P3–P5 come after gaps, one failing leaves the others standing, a failed ranking settles all six.
    - **Board, checked in the headless browser:** at 1440 the layout is Tracks 8 | Credits 4, then Sessions | Booths and reps. At 390 the order is Tracks, the band, Credits, with no horizontal scroll. A credit row opens its drawer (why, the post, claim, links). No console errors.
    - **Hindsight (`fixtures/dogfood/hindsight.json`), at Sat Oct 24 12:00 PM PT (`--at`, the first day of hacking; an instant chosen for the report):**
      - **Joined sponsors:** Anthropic (stack: Claude API; likely track), Apify (stack; two likely tracks), Factory (stack: Factory Droid SDK; likely track), Figma (stack only; its track is possible).
      - **Credits (3):** Anthropic "$50 Claude API credits", Apify "$200 Apify credits" (code APIFY_CAL_HACKS) and Figma "Free Figma Edu Access", none with a stated limit. Left out by the rules: Factory's "$20 free credits" (closed Fri 7:00 PM), and Apify's "extend coupon 3 months" (posted Sun). No quote failed.
      - **Sessions (1), before "Devpost submission deadline extended" (Sun 9:30 AM):** Sat 1:00 PM, Anthropic, "Hey! A reminder that our Claude workshop, Building Multi-Agent Teams & Systems, is today from 1-2pm in the Theater…". Left out: Apify's workshop (11:00 AM, already started) and an Anthropic post from 1:08 PM (not yet posted at noon).
      - **People:**
        - Anthropic: Tyler Lacroix [Anthropic Researcher], 1 post, first "Yes all hackers will get $50 of Claude API credits".
        - Factory: David GU [Factory], 4 posts by noon, first "Hi!".
        - Apify: none. Apify's posters in #spons-apify have no sponsor tag, title or external badge in the capture, so A5's role signals don't mark them sponsor-side. The coupon post's author says "DM me", so this is a miss in the role signals, not an absence (TODOS).
    - **At today's clock (Nov 7, after the event):** the same 3 credits (none states a limit), no sessions, and the same reps.
- [ ] **P6** State table (D4) and live updates with the urgent bypass (D5). Verify: tests on a synthetic sync diff (a deadline moved earlier, a session in 45 min, a new offer).
- [ ] **P7** Judging, still claimable and Follow up after the deadline (D6). Verify: replay frames before and after 9:30 and after results.
- [ ] **P8** Tabs and checkbox per DESIGN.md (D9, D10); shared Plan/Ship step state. Verify: keyboard-only pass; a screen reader announces per D11.
- [ ] **P9** Ship layout, the drafts item, the merge line, last-hour mode (D13), and the Recheck gaps item: commit and time checked, open gaps above the checklist with their quotes (engine built: `POST /ship/gaps`). Verify: frames at 61 and 59 min before the deadline; a recheck on an unchanged commit makes no model call.
- [ ] **P10** Eval: recall@3/@5 (done in fiteval.ts); credits, sessions, booths relevance by the Opus judge with n; Hindsight dogfood saved to `fixtures/dogfood/hindsight.json` (gitignored).

TODOS: none deferred from this review. Every approved fix is a step 4 task above.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | Claude Plan subagent (native fallback, Codex not installed), in `/plan-eng-review` | Independent 2nd opinion | 1 | completed (native; not outside coverage) | 22 findings (2 critical, 5 high, 7 medium, 7 low, 1 strategic); resolved via D18–D21 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (all mapped to approved tasks) | 48 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN) | Plan + Ship: 4.8 → 9.0/10; 12 decisions (D2–D13), 0 unresolved; no mockups (no OpenAI key) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex-plan-review phase: Codex not installed; native Claude Plan subagent completed in 156 s with 22 findings (in-host, outside_status unavailable). No external-provider coverage.
- **VERDICT:** No review CLEAR yet. Eng review complete with 23 decisions (D1–D23) approved and every finding mapped to T1–T11; status is ISSUES OPEN because findings are counted even when resolved. Design review of Plan + Ship CLEAR (PLAN) on 2026-11-06 with 12 decisions; /design-review runs after step 4 is built.

NO UNRESOLVED DECISIONS
