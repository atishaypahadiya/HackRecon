# Donna

Donna is a hackathon agent for one hacker. Donna knows the event as it happens, knows who is worth talking to, and
reaches the hacker wherever they are, without ever acting on their behalf. The repo and the `hr` CLI keep the name
hackrecon; everything the hacker sees says Donna.

This file is the direction. The design docs (`docs/designs/`) hold the decisions and their evidence. Each section
below says what is **decided** (with where it was decided) and what is **proposed**, which still needs the owner's
call.

## One brain

Every door talks to the same brain. No door has logic of its own.

**Event knowledge** (built)
- The event's own pages: Devpost and the event site, fetched; login-gated pages snapshotted in the hacker's own tab.
  Tracks, prizes, rules and the schedule come from these (canon).
- What's said: Slack through read-only API methods, and Discord through open tabs plus followed announcements read
  by the Donna bot.
- What it means: each new post is classified into offers, deadlines and workshops under the cost guard. It's
  matched against the hacker's Plan (idea, stack, the tracks it fits) and, at submission time, their repo.

**People graph** (built in part)
- Sponsor reps by company. A rep counts only on evidence:
  - an email on the sponsor's domain
  - an organizer naming them beside the sponsor
  - staff behavior (staff posts, answers to hackers, never in hacker-only channels)
- The same person across workspaces is linked only on strong evidence (a custom avatar).
- Organizers and hackers stay out of the graph: it's for people a hacker would reach out to.
- Organizer authority comes only from signals hackers can't set: restricted channels, followed feeds, or channel IDs
  the hacker lists. A post's text never grants it.

**Consent gate** (decided in rule; the single code path is proposed)
- Donna drafts; the hacker sends. Donna messages only the hacker, never anyone else.
- Proposed: one gate function every outbound path passes through. It refuses any recipient other than the hacker's
  own channel, and a test pins that.

## Three doors

1. **Dashboard.** Built: the local board (`hr board`). It has Plan, Ship, Credits, Sessions and People, plus drafts
   to confirm one by one. Proposed: a hosted dashboard behind a login, so it works away from the laptop. The login
   provider is undecided.
2. **Chat.** Built: Telegram, two-way.
   - Alerts arrive there.
   - Anything the hacker types is a question, answered from the Plan and the event's data, with the source channel
     named.
   - Answers say "I don't know" rather than guess.
3. **Messaging.** Built: SMS through Twilio, alerts only (one-way). Planned: iMessage and WhatsApp. A new channel
   plugs in as one adapter (`pipeline/channels.ts`); the brain doesn't change.

## Consent rules (decided)

- **No self-bots.** On Slack, only read-only methods from an allowlist; nothing that posts, reacts or marks read. On
  Discord, the extension only reads what open tabs show: it never navigates, clicks, scrolls or types, and it uses
  no user token. The Donna bot uses its own token, GET requests only, in the hacker's own server.
- **No LinkedIn scraping.** LinkedIn appears only as search links; nothing is fetched.
- **The hacker sends every message to another person.** Donna writes openers and drafts and never sends them.
- **Credentials stay put.** Tokens are read from `.env` or kept in extension memory. They never reach disk, logs,
  captures or errors, and never go to a server of ours.
- **Workspace data is never committed.** Only synthetic fixtures are tracked.
- **Names are hidden in demos.** Demo mode shows hackers as "a hacker" and hides author names.
- **Spending is capped and announced.** Any run estimated over $1 is refused without `--yes`. Chat answers stop at
  $1 per watch session and $3 per event day, and Donna says so in the chat.
- **Open:** consent at scale. If Donna serves many hackers at one event (for example through MLH), what may Donna hold
  about people who never used Donna? This is undecided, and it gates any multi-user version.

## Profile sources

**The hacker** (decided)
- The Plan they write: idea, stack, what each piece is used for.
- Their repo link: the stack it shows, read for Ship's gap checks and the Built With prefill.
- Their Devpost project, when submitted.

**People** (decided)
- What the event's own spaces show: Slack profile fields the hacker can already see (name, title, avatar, email
  domain) and their posts in event channels.
- Nothing from outside the event's spaces, and nothing fetched from LinkedIn.

**Proposed:** let the hacker add a source by hand (a GitHub profile, a personal site) and use it only for their own
profile, never for other people's.

## Message rhythm (decided, as built)

- **Important, sent at once:** room or time changes, organizer deadlines, tracks and judging posted, and workshops
  or offers that match the Plan. At most one message per 10 minutes and four an hour, up to 3 items each.
- **Everything else** waits for a digest every 2 hours, up to 6 items.
- **Fresh only:** a post alerts while it's under 6 hours old, never twice.
- **Answers:** at most 20 an hour. A question older than 15 minutes when Donna reads it is skipped, since the answer
  may have changed.
- **Proposed:** quiet hours during sleep blocks, holding everything but room or time changes and deadlines. The hours
  are the hacker's to set; none is set today.

## Build order

**Done**
1. Capture: Slack DOM, then read-only API sync on a timer, verified against the export.
2. Canon: event pages fetched and checked; incremental classification under the cost guard.
3. Board: Plan, Ship, Credits, Sessions and People; rep signals and person links.
4. Discord: open tabs, unread badges, and the Donna bot reading followed announcements.
5. Alerts and chat: Telegram two-way, with Donna answering from the Plan.

**Next (proposed order)**
1. Iterate, Nov 14: check the Discord reader on the real server, follow the announcement channel into the Donna
   server, and run `hr watch` through the event.
2. Quiet pulls: ask Slack which channels moved and read only those (TODOS).
3. The dashboard behind a login.
4. iMessage, then WhatsApp, as channel adapters.
5. The multi-user question (consent at scale, the MLH conversation) before anything that serves more than one hacker.
