# Discord: the HackRecon bot, your server, and SMS

HackRecon reads an event's Discord two ways, both read-only:

- **Your open tabs (the extension).** Every Discord channel you have open in a tab is read as Discord renders it. For
  announcement and sponsor channels you don't have open, the sidebar's unread badge sends a "new post in #channel"
  alert. The extension never navigates, clicks, scrolls or types, and uses no token and no Discord API.
- **The HackRecon bot (official API).** A bot you create, in a private server you own. When an event's announcement
  channel can be followed, you click Follow once and pick your server; Discord copies each announcement there, and
  the bot reads those copies with its own bot token. Announcements then get full text and Plan matching with no tab
  open.

Both feed the same pipeline: `classify --new` under the cost guard, then the SMS rules.

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
5. Open the URL, pick your `HackRecon` server, and click **Authorize**.

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

Tracks, judging and room-change alerts fire only for posts HackRecon knows came from the event's staff: the followed
crossposts, and channels you list under `authority_channels` in the event's `config/event.json`. A channel you can't
post in is not proof on its own (some servers lock every channel until you verify), so `hr discord-ingest` only
suggests a read-only, announcement-named channel; add it to the list yourself if only staff post there:

```json
"authority_channels": ["announcements"]
```

## 4. Twilio

1. In the [Twilio Console](https://console.twilio.com), copy the **Account SID** and **Auth Token**, and get a phone
   number that can send SMS.
2. Add to `.env`:

   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM=+1...        # your Twilio number
   HACKRECON_SMS_TO=+1...   # your phone
   ```

A trial account only texts numbers you've verified in the console, and adds a trial notice to each text. Sending
from a US number also needs Twilio's US messaging registration for that number; the console shows its status.

## 5. Run it

```
bun run hr plan --idea "..." --stack "Modal: GPU inference, Claude API"   # saves data/plan.json for the "why"
bun run hr watch --every 2m --dry-run    # texts go to data/sms_outbox.jsonl only
bun run hr watch --every 2m              # sends them
```

Each tick: `discord-ingest` (your tabs' files from `~/Downloads/hackrecon/discord/`, and the bot's new crossposts),
`classify --new` on new posts (a run over $1 is refused and the posts wait; watch never passes `--yes`), then
`alerts`. Important texts go out at once, at most one per 10 minutes and four an hour; the rest come in a digest
every two hours. `bun run hr alerts --list` shows every alert found.
