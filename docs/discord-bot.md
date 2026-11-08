# Discord and Telegram: Donna's setup

Donna is HackRecon's agent: Donna reads the event, sends you alerts and answers your questions. The repo and the `hr`
command keep the name hackrecon.

Donna reads an event's Discord two ways, both read-only:

- **Your open tabs (the extension).** Every Discord channel you have open in a tab is read as Discord renders it. For
  announcement and sponsor channels you don't have open, the sidebar's unread badge sends a "new post in #channel"
  alert. The extension never navigates, clicks, scrolls or types, and uses no token and no Discord API.
- **The HackRecon bot (official API).** A bot you create, in a private server you own. When an event's announcement
  channel can be followed, you click Follow once and pick your server; Discord copies each announcement there, and
  the bot reads those copies with its own bot token. Announcements then get full text and Plan matching with no tab
  open.

Both feed the same pipeline: `classify --new` under the cost guard, then the alert rules, which send to your
Telegram chat; you can also ask questions there (section 4).

## 1. Your private server

1. In Discord, click **+** (Add a Server) at the bottom of the server list, then **Create My Own**, then **For me and
   my friends**. Name it `HackRecon` and click **Create**.
2. Create a text channel named `event-feed` (or keep `#general`). Followed announcements will land there.

The bot reads only crossposts (the copies Discord makes from followed channels). Anything you type in your server
yourself is skipped.

## 2. The bot

1. Open the [Developer Portal](https://discord.com/developers/applications), click **New Application**, name it
   `HackRecon`, and create it.
2. **Installation** page: set **Install Link** to **None**. (Discord won't let a private bot keep its default install
   link.)
3. **Bot** page:
   - Click **Reset Token**, copy the token, and add it to `.env` at the repo root:
     `DISCORD_BOT_TOKEN=...`. `.env` is gitignored. Don't paste the token anywhere else; if it leaks, reset it here.
   - Turn **Public Bot** off, so only you can add it to a server.
   - Under **Privileged Gateway Intents**, turn **Message Content Intent** on. Leave Presence and Server Members off.
     Without Message Content, Discord sends the bot each crosspost with no text; `hr discord-ingest` says so when that
     happens.
4. **OAuth2** page, **URL Generator**: tick the scope **bot** only. Under **Bot Permissions**, tick exactly:
   - **View Channels**
   - **Read Message History**

   That's permissions integer **66560**. The generated URL looks like
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=66560`.
5. Open the URL, pick your `HackRecon` server, and click **Continue**. The screen must list exactly two permissions,
   **View Channels** (some screens say Read Messages/View Channels) and **Read Message History**, and nothing else.
   If it shows any other, go back and untick it. Click **Authorize**.

What the bot can do: see your server's channels and read their message history. What it can't: send messages,
react, edit, delete, manage anything, or see any server you didn't add it to. HackRecon's code enforces the same
limits: GET requests only, to three routes (your servers, a server's channels, a channel's messages), with a test
that fails if anything else appears (`pipeline/discordbot.test.ts`).

## 3. Follow the event's announcements

Once your registration is approved and you're in the event's server:

1. Open its announcement channel (the megaphone icon next to the name).
2. Click **Follow** at the top of the channel, pick your `HackRecon` server and `#event-feed`, and click **Follow**.
   You need Manage Webhooks in your server; as its owner you have it.

Only channels of Discord's Announcement type have Follow. Discord also sends a post to followers only when the event's
staff publish it. An announcement they don't publish shows up only in the event's server, so keep that channel open
in a tab as well, and the extension reads it there.

Tracks, judging and room-change alerts fire only for posts Donna knows came from the event's staff: the
crossposts the bot reads in your own server, and channels you list by id under `discord_authority_channels` in the
event's `config/event.json`. Ids, not names, so another server's `#announcements` never counts. A channel you can't
post in is not proof on its own (some servers lock every channel until you verify), so `hr discord-ingest` only
suggests a read-only, announcement-named channel, with the entry to add if only staff post there:

```json
"discord_authority_channels": ["<server id>/<channel id>"]
```

## 4. Telegram: Donna (your alerts and your questions)

Donna sends alerts to a Telegram bot chat that only you use, and answers what you type there. No carrier
registration is involved: it's Telegram's own Bot API.

1. In Telegram, open a chat with **@BotFather** (the one with the blue check) and send `/newbot`.
2. Give it the display name `Donna`, then a username that ends in `bot` and isn't easy to guess
   (e.g. `donna_<something>_bot`). BotFather replies with the token.
3. BotFather calls it the HTTP API token. Add it to `.env` at the repo root (the same file as `ANTHROPIC_API_KEY`):
   `TELEGRAM_BOT_TOKEN=123456789:AA...`. If it ever leaks, send BotFather `/revoke`.
4. Send BotFather `/setjoingroups`, pick your bot, choose **Disable**, so nobody can add it to a group.
5. Open your bot (the `t.me/<username>` link BotFather gave) and tap **Start**.
6. Run `bun run hr telegram-chat-id`. It prints your chat ID; add it to `.env`: `TELEGRAM_CHAT_ID=...`.

Anyone can find a bot and message it; Donna only reads and answers your own chat (`TELEGRAM_CHAT_ID`) and drops
everything else unread. It calls four Bot API methods and nothing else (`pipeline/telegram.test.ts`).

Answers: each question is one `claude-haiku-5-5` call over your Plan, the schedule, alerts so far, and organizer and
classified posts. Two spend limits, and the chat tells you when one is reached: the cost guard's $1 per watch
session, and $3 a day per event (set `chat_daily_usd` in the event's `config/event.json`; the day's total is kept in
`data/chat_spend.json`, so restarting watch doesn't reset it). It also answers at most 20 an hour. Whether a post
counts as from the organizers is decided in code from where it came from (the followed feed, or a channel you listed
by id), never from what the post says. `bun run hr ask "..."` gives the same answer in the terminal.

The channel is pluggable (`HACKRECON_CHANNEL` in `.env`, default `telegram`): `sms` uses Twilio one-way (the four
`TWILIO_*`/`HACKRECON_SMS_TO` keys, and US carrier registration); iMessage and WhatsApp aren't built yet.

## 5. Run it

```
bun run hr plan --idea "..." --stack "Modal: GPU inference, Claude API"   # saves data/plan.json for the "why"
bun run hr watch --every 2m --dry-run    # alerts go to data/outbox.jsonl only; replies aren't read
bun run hr watch --every 2m              # sends them, and answers your messages
```

Each tick: `discord-ingest` (your tabs' files from `~/Downloads/hackrecon/discord/`, and the bot's new crossposts),
`classify --new` on new posts (a run over $1 is refused and the posts wait; watch never passes `--yes`), then
`alerts`. Important alerts go out at once, at most one per 10 minutes and four an hour; the rest come in a digest
every two hours. Between ticks, watch reads your messages and answers them. `bun run hr alerts --list` shows every
alert found; `data/chat.jsonl` keeps your questions and the answers.
