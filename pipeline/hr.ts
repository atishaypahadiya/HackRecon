#!/usr/bin/env bun
// hr: HackRecon pipeline CLI. Subcommands land here as tasks ship (compare first).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { decideIngest, type IngestDecision } from "./ingest.ts";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { captureFiles, loadCapture, threadCaptureFiles, type LoadedCapture } from "./captures.ts";
import { CostGuard, CostRefused, describeCalls, guardClient, plannedCall } from "./costguard.ts";
import {
  classifyOne,
  MAX_TOKENS,
  MODEL,
  OUTPUT_SCHEMA,
  promptHash,
  readEvent,
  readJsonFile,
  systemPrompt,
  toItems,
  writeJsonFile,
  type Cache,
  classifyPlan,
  type ClassifyError,
  type ClassifyInput,
  type ClassifyRun,
} from "./classify.ts";
import { compareChannel, compareThreads, threadTotals, AUTHOR_MIN, RECALL_MIN, TIME_MAX_S, type ChannelReport, type ThreadReport } from "./compare.ts";
import { isTopLevel, loadExport, readChannel, rowClass } from "./export.ts";
import { apiKeys, captureFromApi, compareKeys, exportKeys, type ApiChannelFile, type ApiUser, type KeyCompare } from "./apiconvert.ts";
import { hackerOnlyChannels, selfIdFlags } from "./hackerchannels.ts";
import { pageChanges as mergePageChanges, type PageChange } from "./merge.ts";
import { durationText, shipList, type ShipItem, type ShipList } from "./shiplist.ts";
import { emailReps, likelyReps, loadRepIndex, mentionAuthority, mentionReps, repEvidence, selfIdReps, selfIdSponsorList, type MentionPost, type RepSignalsFile } from "./reps.ts";
import { HAND_LABELER, labelerOf, labelProblems, OPUS_LABELER, readLabels, readRules } from "./labels.ts";
import { formatGate, scoreGate } from "./gate.ts";
import { labelApp } from "./label.ts";
import {
  buildRows,
  candidatesFromExport,
  DEFAULT_SEED,
  KEYWORD_RE,
  lockedChannels,
  RANDOM_N,
  readPoolMeta,
  readSponsors,
  selectPool,
  withFlagged,
  writeSheet,
  type PoolMeta,
  type Sponsors,
} from "./pool.ts";
import { messageFromRow, redactedInputs } from "./inputs.ts";
import { costUsd, formatUsage, sumUsage, type Usage } from "./usage.ts";
import { formatPreview, preview } from "./preview.ts";
import { BOARD_FONT_DIR, BOARD_FONTS, BOARD_LIVE_JS, BOARD_PAGE, BOARD_PREFILL_JS, boardData, plainText, v1Ids, type BoardData } from "./board.ts";
import { joinSponsors, planCredits, planPeople, planSessions, submissionDeadline } from "./planjoin.ts";
import { GROUP_EFFORT, GROUP_MAX_TOKENS, GROUP_MODEL, GROUP_SCHEMA, groupHash, groupOffers, groupRequest, groupSystemPrompt, inputHash, withLabelAmounts, type GroupResult } from "./group.ts";
import {
  applyJudge,
  JUDGE_EFFORT,
  JUDGE_MAX_TOKENS,
  JUDGE_MODEL,
  JUDGE_SCHEMA,
  judgeHash,
  judgeOne,
  judgeSystemPrompt,
  rulesSection,
  type JudgeCache,
  type JudgeRun,
  type Labels,
} from "./prelabel.ts";
import { buildOrganizers, loadOrganizerIds, rolesById, type Organizer } from "./roles.ts";
import { DiscordBot } from "./discordbot.ts";
import { budgetedAnswer, buildContext, CHAT_DAILY_USD, ChatBudget, DailyCapReached, handleInbound, readAgentData, readChatLog, type ChatTurn } from "./agent.ts";
import { channelFromEnv, isChannel, whyNoChannel, type MessageChannel } from "./channels.ts";
import { TelegramApi, telegramSenders } from "./telegram.ts";
import { ingestDiscord, runAlerts } from "./watch.ts";
import { AVATAR_MAX_BITS, avatarHashes, hammingHex, linkEvidence, loadPersonKey, profileEvidence, type AccountEvidence, type PersonLink, type PersonLinksFile, type SnapshotUser } from "./people.ts";
import { buildRun, readMessages, readRuns, saveRun } from "./runs.ts";
import type { ExportUser } from "./export.ts";
import {
  BOARD_DATA_PATH,
  CACHE_PATH,
  CANON_FIXTURES_PATH,
  CANON_JUDGE_FIXTURES_PATH,
  CANON_JUDGE_PATH,
  CANON_PATH,
  CANON_HISTORY_PATH,
  CANON_STORE_PATH,
  CAPTURES_DIR,
  DISCOVERED_PATH,
  DISCOVERY_PATH,
  FIT_CACHE_PATH,
  GAPS_CACHE_PATH, PERSON_LINKS_PATH, PLAN_TIMINGS_PATH, REP_SIGNALS_PATH,
  SHIP_GAPS_PATH,
  PREFILL_CACHE_PATH,
  PRODUCTS_PATH,
  PREFILL_EVAL_PATH,
  PREFILL_REPOS_PATH,
  FIT_BASELINE_PATH,
  FIT_EVAL_PATH,
  FIT_EVAL_SET_PATH,
  EVENT_PATH,
  DEFAULT_EXPORT_DIR,
  ERRORS_PATH,
  GROUP_PATH,
  ITEMS_PATH,
  JUDGE_CACHE_PATH,
  JUDGE_RUN_PATH,
  LABELS_PATH,
  MESSAGES_PATH,
  ALERTS_LOG_PATH,
  DISCORD_UNREAD_PATH,
  PLAN_PATH,
  OUTBOX_PATH,
  CHAT_LOG_PATH,
  CHANNEL_STATE_PATH,
  CHAT_SPEND_PATH,
  ORGANIZERS_PATH,
  PAGE_FIXTURES_DIR,
  PAGES_DIR,
  POOL_META_PATH,
  RULES_PATH,
  RUN_PATH,
  RUNS_PATH,
  SLACK_DOM_FIXTURES_DIR,
  SPONSORS_PATH,
  fromCaller,
  takeEventArg,
  useEvent,
} from "./event.ts";
import { findTokens, scrubTokens, total } from "./domscrub.ts";
import { BUNDLE_DIR, summarizeSync, wholeFiles, type SyncLogLite } from "./syncbundle.ts";
import { threadRunFromRaw, type ThreadRaw } from "../extension/src/thread.ts";
import { loadPages, needsRedaction, pageCoverage, pageKey, redactSnapshot, snapshotHash, type LoadedPage } from "./pages.ts";
import type { EventConfig } from "./classify.ts";
import {
  CANON_EFFORT,
  CANON_JUDGE_SCHEMA,
  CANON_MAX_TOKENS,
  CANON_MODEL,
  CANON_SCHEMA,
  canonHash,
  canonInputHash,
  canonJudgeRequest,
  canonJudgeSystemPrompt,
  canonRequest,
  canonSystemPrompt,
  checkCanon,
  assignIds,
  checkJudge,
  keepDropped,
  keyed,
  rematch,
  REMATCH_THRESHOLD,
  type JudgeVerdict,
  type Keyed,
  type KeptField,
} from "./canon.ts";
import { coverage, type CoverageReport } from "./coverage.ts";
import { callChecked } from "./model.ts";
import { checkFit, sponsorAliases, FIT_EFFORT, FIT_TOP, FIT_MAX_TOKENS, FIT_MODEL, FIT_SCHEMA, fitHash, fitRequest, fitSystemPrompt, trackCards, type Ranked, type SponsorAliases } from "./fit.ts";
import { fitGate, fmt, formatFitGate, formatFitReport, scoreFit, type EvalItem, type PairHit } from "./fiteval.ts";
import { planGaps, type GapCache, type ProjectFact } from "./gaps.ts";
import { checkoutRepo, checkoutRepoAsync, repoFacts, repoTexts } from "./repo.ts";
import { planStream, type PlanEvent, type PlanSteps } from "./planstream.ts";
import { PREFILL_MAX_TOKENS, PREFILL_SCHEMA, PREFILL_SYSTEM, prefillDraft, prefillFacts, prefillHash, prefillRequest, type PrefillCache, type PrefillDraft, type Product } from "./prefill.ts";
import { builtWithReport, formatPaired, pairedVsBaseline, scoreBuiltWith } from "./prefilleval.ts";
import { recheckGaps, shipTracks, type ShipGapStore } from "./ship.ts";
import { cliWidth, wrapText } from "./wrap.ts";
import { boothBlocks, boothQuestions, parsePlanBody, parseStack, planMeta, planTracks, trackDetail, type FitCache, type PlanInput, type PlanTrack, type StackItem } from "./plan.ts";
import { devpostQuery, eventDraft, organizersFrom, organizerTag, slackDeadlines, workspaceSubdomain, type DiscoveredUser } from "./autoconfig.ts";
import { compareSponsors, devpostCanonPages, discoverUrls, organizersFromRestricted, pickDevpostHit, sponsorsDraft, type DevpostHit } from "./discover.ts";
import { needsExtension, PoliteFetcher, USER_AGENT, type FetchResult } from "./fetch.ts";
import { buildNameList, compileRedactor } from "./redact.ts";
import type { Entity, Message, PageSnapshot } from "./schema.ts";
import { PAGE_ACCESS, SCHEMA_VERSION, pageFileName, parseAuthorsCaptureFile, parsePageSnapshot, parseThreadCaptureFile, threadCaptureName, type AuthorsCaptureFile, type Item, type PageAccess, type ThreadCaptureFile } from "./schema.ts";
import { snapshotPage } from "../extension/src/page.ts";

/** slackdump export finished 2026-10-27 03:17 America/Los_Angeles (design doc, D2). */
const EXPORT_CUTOFF = "2026-10-27T03:17:00-07:00";

const USAGE = `usage:
  Spend guard (costguard.ts): every command that can call a model prints its estimated cost first and refuses a run
  estimated over $1 unless given --yes (estimate: input at 2 characters a token, uncached, plus each call's full
  output budget; a retry after a failed output check is another call, checked as it runs).
  bun run hr compare [capture.json | dir ...] [--export DIR] [--json OUT] [--cutoff ISO]
      Checks each captured channel against the slackdump export: keyed recall by ts
      (pass >= ${RECALL_MIN * 100}%), author match (pass >= ${AUTHOR_MIN * 100}%), time (<= ${TIME_MAX_S}s, recorded only).
      Default input: captures/. Exit 1 if any channel's keyed recall fails.
  bun run hr record-run --id RUN_ID [capture.json | dir ...]
      Records a capture session in ${RUNS_PATH} and its messages in ${MESSAGES_PATH}
      (non-posts dropped, broadcasts marked). Re-recording the same id replaces it.
  bun run hr pool [--seed N] [--export DIR] [--check] [--add-flagged]
      Writes the day-2 labeling sheet ${LABELS_PATH}: every keyword hit in the locked channels'
      baseline (top-level, plus replies also sent to the channel) and the miss checks, shown as
      pool = miss_check: ${RANDOM_N} random top-level non-hits, plus (--add-flagged, after a full
      hr classify) every non-hit the classifier flags as credit or dated. Which is which is kept in
      ${POOL_META_PATH} so the sheet doesn't reveal classifier answers. Re-running keeps every label
      column. --check only validates the labels entered so far. Labeling rules: docs/labeling.md
  bun run hr prelabel [--dry-run] [--yes] [--include-hand] [--limit N] [--concurrency N] [--show MESSAGE_ID]
      The Opus judge (D21): ${JUDGE_MODEL} (effort ${JUDGE_EFFORT}) fills the label columns of every row in
      ${LABELS_PATH} from the same redacted input Haiku gets, under the rules in ${RULES_PATH} (Columns
      section, verbatim), with labeler = ${OPUS_LABELER}. Blind to Haiku: never reads items.json, the classify
      cache or review/pool.json. Hand-labeled rows are kept unless --include-hand. Cached in ${JUDGE_CACHE_PATH}; run record in ${JUDGE_RUN_PATH}.
  bun run hr label [--port N] [--open]
      Optional: local page for correcting ${LABELS_PATH} by hand on 127.0.0.1, one row at a time, keys c/d/n/x.
      A save sets labeler = ${HAND_LABELER}, which hr prelabel then keeps. Never shows classifier output. Ctrl-C to stop.
  bun run hr gate [--json OUT]
      Scores ${ITEMS_PATH} against the labeled rows of ${LABELS_PATH}: capture recall, credit and dated
      precision/recall, amount and deadline match, both miss checks, with counts and both prompt hashes.
      With Opus labels every number is agreement with Opus, not accuracy, and the report says so.
      Unlabeled rows are skipped and counted; nothing about them is printed. Exit 0 only on a complete pass.
  bun run hr group [--dry-run] [--force] [--yes]
      The Opus grouping pass: claude-opus-5-5 reads every post the judge labeled is_credit = y (same redacted
      input as classify and prelabel, blind to the classifier) and writes the distinct offers with their source
      posts to ${GROUP_PATH}. One streamed request; skipped while the input is unchanged unless --force.
  bun run hr board [--build-only] [--port N] [--yes]
      Builds ${BOARD_DATA_PATH} from the Opus offers (hr group) and the capture, then serves the board on
      127.0.0.1. Needs a current ${GROUP_PATH}. Plan, Recheck gaps and repo drafts call models; each request is
      estimated in the server log and refused over $1 unless the board was started with --yes.
  bun run hr pages [--from-html FILE --url URL --access public|authenticated]
      Lists the page snapshots in ${PAGES_DIR} (from the extension's "Capture this page"): url, when, access
      flag, blocks, hash, and any canon_pages / schedule_pages in ${EVENT_PATH} with no snapshot yet.
      --from-html builds a test fixture snapshot from saved HTML into ${PAGE_FIXTURES_DIR} (never canon).
  bun run hr canon [--fixtures] [--judge] [--dry-run] [--force] [--yes]
      Extracts tracks, prizes, judging criteria and rules from each canon page's latest snapshot (one
      ${CANON_MODEL} call per page; cached by input), verifies every quote, then runs the D15 coverage
      checks. --judge adds the Opus judge ("what's missing or misplaced"). --fixtures reads
      ${PAGE_FIXTURES_DIR} and writes ${CANON_FIXTURES_PATH}, never ${CANON_PATH}. Exit 1 on any failed check.
  bun run hr fit-eval [--fixtures] [--dry-run] [--limit N] [--concurrency 6] [--set-baseline] [--yes]
  bun run hr plan (--idea "..." | --from fixtures/dogfood/<name>.json) [--stack "Apify: pull course catalogs, Claude API, ..."] [--repo URL] [--fresh] [--at ISO] [--yes]
      Each stack item is a name with an optional ": used for" (what it does in your project); --stack overrides --from's.
      Runs the board's Plan stream in-process and appends its timing to ${PLAN_TIMINGS_PATH}. --fresh skips the fit and
      gap caches (and saves nothing) to time an input as if it were new: that makes model calls. --at replays Credits,
      Sessions and People at an instant (default: now).
  bun run hr prefill --repo https://github.com/<owner>/<repo> [--yes]
      P1b: drafts Plan's description, stack and used-fors from a public repo, each with the lines it came from.
      Prints drafts only; nothing is saved to a project until the user confirms each one.
  bun run hr sync-ingest [~/Downloads/hackrecon/sync/<stamp>]
      (A background API pull's bundle has a pull/ folder: it is kept as pulled and converted into the same
      capture files.)
      Brings in a "Sync this event" bundle (the newest by default): captures to ${CAPTURES_DIR}/sync-<stamp>/,
      thread pane samples (scrubbed again) to ${SLACK_DOM_FIXTURES_DIR}/, and prints what the sync did.
      Then: bun run hr compare ${CAPTURES_DIR}/sync-<stamp>
  bun run hr rebuild-threads ${CAPTURES_DIR}/sync-<stamp>
      Rebuilds each <channel_id>.threads.json from its .threads.raw.json with the current selectors.ts (the
      extension's own first version is kept once as .threads.ext.json).
  bun run hr scrub-dom [files…]
      Strips Slack session tokens (xoxc-, xoxd-, bearer, JWT, signed file URLs) from saved DOM samples in
      ${SLACK_DOM_FIXTURES_DIR}/, in place. Prints counts only. Run it after saving any sample.
  bun run hr prefill-eval [--dry-run] [--limit N] [--concurrency 4] [--yes]
      P1b's eval on ${PREFILL_REPOS_PATH}: Built With recall of the drafted stack, and fit recall@3/@5 with the
      drafted stack in place of Built With (run C), paired against ${FIT_BASELINE_PATH}'s run B.
  bun run hr ship --from fixtures/dogfood/<name>.json [--enter "Best Actor, Claude for Public Benefit, ..."] [--repo URL] [--at ISO] [--yes]
      --enter defaults to the fixture's "entered" list. Prints Ship as of --at (default: now): the deadline with
      any post that moved it, Recheck gaps when a repo is linked (the entered tracks' stated requirements and
      entry steps against its latest commit; reused while the commit is unchanged), then the checklist.
      Plan's Tracks section for one project, from data/canon.json: the same ranker, quote check and cache as
      fit-eval. Prints each track with its fit word, reason, verified quote, and the time to the section.
      The idea-fit eval (D23): ranks ${FIT_EVAL_SET_PATH}'s winning projects against canon's sponsor tracks with
      ${FIT_MODEL}, run A (description only) and run B (+ Built With), and scores recall@3 on won tracks.
      Rankings are cached by input in ${FIT_CACHE_PATH}; the report goes to ${FIT_EVAL_PATH}.
  bun run hr sync [--canon [--yes]] [--offline]
      After a Slack capture: finds the event's Devpost and schedule pages in announcement posts (restricted-posting
      channels, else authority_channels, else channels named *announce*; Devpost search by event name as fallback),
      fetches every public page (one request per URL per sync, User-Agent "${USER_AGENT}", robots.txt respected)
      into ${PAGES_DIR}, and drafts sponsors.json and organizers. It never calls a model: changed canon pages are
      listed, and re-read only with --canon (hr canon --judge, under the spend guard). Config you wrote wins
      over a draft; drafts and the run report go to ${DISCOVERED_PATH}. --offline skips the network.
      With no ${EVENT_PATH} yet, it runs hr discover first.
  bun run hr discover [--export DIR] [--workspace-name NAME] [--offline] [--against CONFIG_DIR]
      Zero setup: writes ${EVENT_PATH}, ${SPONSORS_PATH} and ${ORGANIZERS_PATH} from the workspace (permalink
      subdomain, searched on Devpost), canon (tracks, deadlines, timezone), the last sync's sidebar (sponsor
      channels) and organizer posts. No model. A file is written only when missing or unchanged since discover
      wrote it; everything goes to ${DISCOVERY_PATH}. --export: users.json for admin and owner flags.
      --against: compares the drafts with a hand-written config directory. The newest API pull supplies the
      workspace's name, its channel list and users.list's admin flags when there's no --export.
  bun run hr compare-api [captures/sync-<stamp>/pull …] [--export DIR]
      The API pull's acceptance check: every config channel's posts and replies, by ts, against the Slack export
      (default: every ingested pull). Exit 0 only when no channel is missing anything.
  bun run hr preview
      Receipt preview from the current data, to pick the board headline: distinct credit offers, priced per
      person, the $ total, offers with a deadline or claim window, sponsors covered, rep candidates. Not the
      receipt: URL merge only, no Opus credit pass, reps unconfirmed; it prints its basis and gaps.
  bun run hr organizers [--export DIR]
  bun run hr rep-signals [--export DIR]
      Writes ${REP_SIGNALS_PATH}: sponsor reps beyond the name/title and external-badge signals, each with its
      evidence and source (reps.ts). Confirmed: a profile email on the sponsor's domain (sponsors.json "domains"), or
      an organizer mentioning the person's user ID beside the sponsor's name. Likely staff: an offer, prize or workshop
      post in the sponsor's channel, an answer to a hacker's question in its threads, and no post in a hacker-only
      channel; shown, never given authority. The export is read for users.json emails, and for mentions and
      hacker-only channels the capture doesn't hold (author IDs and mention IDs only). Run after person-links.
  bun run hr person-links [--export DIR]
      Links Slack accounts that are one person, so a rep with two accounts counts once (user 2026-11-07). Checks
      accounts on the same sponsor's side, in order: same profile email, same avatar image (fetched from Slack's
      image CDN as users.json lists it, hashed, discarded; macOS sips), same real name + title + company. Never by
      name alone. Writes ${PERSON_LINKS_PATH} (ids and hashed evidence).
      One-time (A5): writes ${ORGANIZERS_PATH} from the baseline's users.json (admins, owners,
      CAL HACKS tags, director/exec/organizer/logistics titles). Used for poster_role.
  bun run hr classify [--new] [--labeled-only] [--dry-run] [--yes] [--limit N] [--concurrency N] [--show MESSAGE_ID]
      Classifies captured messages with ${MODEL} (redacted text only). --labeled-only: just the messages
      in ${LABELS_PATH}. Cached in ${CACHE_PATH}; failures in ${ERRORS_PATH}; items in ${ITEMS_PATH}.
      --new: only posts never classified under any prompt (a sync's new posts); the rest keep their newest
      answer, even after event.json changed the prompt. --dry-run builds every request and prints one and the
      estimate, with no API call. Needs ANTHROPIC_API_KEY (.env).
  bun run hr discord-ingest [DIR]
      Discord (read-only): what the extension saved from your open Discord tabs (DIR, default
      ~/Downloads/hackrecon/discord), and, with DISCORD_BOT_TOKEN in .env, the crossposts the HackRecon bot reads
      in your own server (docs/discord-bot.md). New posts go to ${MESSAGES_PATH}; unread badges to ${DISCORD_UNREAD_PATH}.
  bun run hr alerts [--dry-run] [--at ISO] [--list]
      Alerts for fresh posts: tracks or judging posted, a deadline or room change, a workshop or sponsor offer
      that matches your Plan (${PLAN_PATH}, saved by \`hr plan\`), unread badges. Important ones at once (one per 10
      minutes, four an hour), the rest in a digest every 2 hours. Sent to your channel (HACKRECON_CHANNEL in .env,
      default telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; sms: the four TWILIO_* / HACKRECON_SMS_TO keys);
      --dry-run, or a channel not set up, writes them to ${OUTBOX_PATH} only. --list prints every alert found so far.
  bun run hr watch [--every 2m] [--once] [--dry-run] [DIR]
      discord-ingest, then classify --new on new posts (the cost guard applies: a run over $1 is refused and
      the posts wait; watch never passes --yes), then alerts, every --every. On a two-way channel (Telegram) it
      also answers your messages from your Plan and the event's data, with claude-haiku-5-5, up to $1 of
      answers per watch session (the cost guard), $3 a day per event (event.json chat_daily_usd; kept in
      ${CHAT_SPEND_PATH} across restarts), and 20 an hour; questions and answers go to ${CHAT_LOG_PATH}.
  bun run hr ask [--at ISO] [--yes] "QUESTION"
      The same answer the chat would give, printed here: for checking the agent without a channel.
  bun run hr telegram-chat-id
      After you message your bot in Telegram: prints the bot's name and your chat ID for TELEGRAM_CHAT_ID.`;

const COMMANDS = ["ask", "telegram-chat-id", "compare", "scrub-dom", "sync-ingest", "rebuild-threads", "record-run", "pool", "organizers", "person-links", "rep-signals", "classify", "gate", "label", "prelabel", "preview", "group", "board", "pages", "canon", "fit-eval", "sync", "discover", "compare-api", "plan", "ship", "prefill", "prefill-eval", "discord-ingest", "alerts", "watch"];

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "compare") return compare(rest);
  if (cmd === "record-run") return recordRun(rest);
  if (cmd === "pool") return pool(rest);
  if (cmd === "organizers") return organizers(rest);
  if (cmd === "person-links") return personLinks(rest);
  if (cmd === "rep-signals") return repSignals(rest);
  if (cmd === "classify") return classify(rest);
  if (cmd === "gate") return gate(rest);
  if (cmd === "label") return label(rest);
  if (cmd === "prelabel") return prelabel(rest);
  if (cmd === "preview") return receiptPreview(rest);
  if (cmd === "group") return group(rest);
  if (cmd === "board") return board(rest);
  if (cmd === "pages") return pages(rest);
  if (cmd === "canon") return canon(rest);
  if (cmd === "fit-eval") return fitEval(rest);
  if (cmd === "plan") return planCli(rest);
  if (cmd === "ship") return shipCli(rest);
  if (cmd === "prefill") return prefillCli(rest);
  if (cmd === "prefill-eval") return prefillEval(rest);
  if (cmd === "scrub-dom") return scrubDom(rest);
  if (cmd === "sync-ingest") return syncIngest(rest);
  if (cmd === "rebuild-threads") return rebuildThreads(rest);
  if (cmd === "sync") return sync(rest);
  if (cmd === "discover") return discover(rest);
  if (cmd === "compare-api") return compareApi(rest);
  if (cmd === "discord-ingest") return discordIngest(rest);
  if (cmd === "alerts") return alerts(rest);
  if (cmd === "watch") return watch(rest);
  if (cmd === "ask") return ask(rest);
  if (cmd === "telegram-chat-id") return telegramChatId();
  if (cmd) {
    // Name the bad command first (a stray "board." used to print only the usage), and suggest the near miss.
    const near = COMMANDS.find((c) => cmd.replace(/[^a-z-]/g, "") === c);
    console.error(`Unknown command: ${JSON.stringify(cmd)}${near ? `. Did you mean \`bun run hr ${near}\`?` : ""}\n`);
  }
  console.error(USAGE);
  return cmd ? 2 : 0;
}

const DISCORD_DOWNLOADS = join(homedir(), "Downloads", "hackrecon", "discord");

function discordBot(): DiscordBot | null {
  const token = process.env.DISCORD_BOT_TOKEN;
  return token ? new DiscordBot(token, { fetch: (u, i) => fetch(u, i), sleep: (ms) => Bun.sleep(ms), now: Date.now }) : null;
}

/** New Discord posts in, as Messages. Returns how many were added. */
async function discordIngestRun(dir: string): Promise<number> {
  let bot: DiscordBot | null = null;
  try {
    bot = discordBot();
  } catch (e) {
    console.error(`discord-ingest: ${(e as Error).message}`);
  }
  const r = await ingestDiscord({ dir, bot, now: new Date() });
  console.log(
    `discord-ingest: ${r.files} file${r.files === 1 ? "" : "s"} from ${dir}, ${r.posts} posts read, ${r.added} new; ${r.unread} unread badge${r.unread === 1 ? "" : "s"}` +
      (r.bot ? `; bot: ${r.bot.crossposts} crossposts from ${r.bot.channels} channel${r.bot.channels === 1 ? "" : "s"} in ${r.bot.guilds} server${r.bot.guilds === 1 ? "" : "s"}, ${r.bot.calls} calls, ${r.bot.retries} retries` : bot ? "" : "; bot: off (no DISCORD_BOT_TOKEN)"),
  );
  for (const c of r.proposed) console.log(`  #${c.channel} (${c.guild}) is read-only for you and named like announcements. If only the event's staff post there, add "${c.key}" to discord_authority_channels in ${EVENT_PATH} so its tracks, judging and room-change posts can alert`);
  if (r.bot?.empty) console.log(`  ${r.bot.empty} crossposts arrived with no text: turn on the Message Content Intent (docs/discord-bot.md, step 2)`);
  for (const e of r.errors) console.error(`  ${e}`);
  return r.added;
}

async function discordIngest(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  await discordIngestRun(positionals[0] ? fromCaller(positionals[0]) : DISCORD_DOWNLOADS);
  return 0;
}

/** The user's channel, or null (said why) when it can't send. */
function userChannel(): MessageChannel | null {
  const c = channelFromEnv(process.env);
  if (isChannel(c)) return c;
  console.log(`channel: ${whyNoChannel(c)}; alerts go to ${OUTBOX_PATH} only`);
  return null;
}

async function alertsRun(dryRun: boolean, nowMs: number, channel: MessageChannel | null = dryRun ? null : userChannel()): Promise<void> {
  const send = dryRun || !channel ? null : { channel: channel.kind, send: (body: string) => channel.send(body) };
  let organizerIds = new Set<string>();
  try {
    organizerIds = loadOrganizerIds();
  } catch {}
  const tz = existsSync(EVENT_PATH) ? readEvent().timezone : "America/Los_Angeles";
  const r = await runAlerts({ nowMs, tz, organizerIds, send });
  for (const a of r.fresh) console.log(`  ${a.level === "now" ? "now   " : "digest"} ${a.kind}: ${a.what} (${a.source}). Why: ${a.why}`);
  for (const o of r.outbox) console.log(`  message (${o.level}, ${o.status}${o.error ? `: ${o.error}` : ""}):\n${o.body.replace(/^/gm, "    | ")}`);
  console.log(`alerts: ${r.fresh.length} new, ${r.outbox.filter((o) => o.status === "sent").length} sent${channel ? ` by ${channel.label}` : ""}, ${r.outbox.filter((o) => o.status === "dry-run").length} to the outbox only; waiting: ${r.queued.now} important, ${r.queued.digest} for the digest`);
}

async function alerts(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean", default: false }, at: { type: "string" }, list: { type: "boolean", default: false } } });
  if (values.list) {
    for (const l of existsSync(ALERTS_LOG_PATH) ? readFileSync(ALERTS_LOG_PATH, "utf8").trim().split("\n").filter(Boolean) : []) {
      const a = JSON.parse(l) as { found_at: string; level: string; kind: string; what: string; source: string; why: string };
      console.log(`${a.found_at}  ${a.level.padEnd(6)} ${a.kind}: ${a.what} (${a.source}). Why: ${a.why}`);
    }
    return 0;
  }
  const nowMs = values.at ? Date.parse(values.at) : Date.now();
  if (Number.isNaN(nowMs)) {
    console.error(`--at ${values.at}: not a date (use ISO 8601 with an offset)`);
    return 2;
  }
  await alertsRun(values["dry-run"]!, nowMs);
  return 0;
}

async function watch(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { every: { type: "string", default: "2m" }, once: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } } });
  const m = /^(\d+)(s|m)$/.exec(values.every!);
  if (!m || Number(m[1]) * (m[2] === "m" ? 60 : 1) < 30) {
    console.error(`--every ${values.every}: use 30s or more, e.g. 2m`);
    return 2;
  }
  const everyMs = Number(m[1]) * (m[2] === "m" ? 60_000 : 1000);
  const dir = positionals[0] ? fromCaller(positionals[0]) : DISCORD_DOWNLOADS;
  const dryRun = values["dry-run"]!;
  const channel = dryRun ? null : userChannel();
  // One guard for the whole session's answers: they stop at COST_LIMIT_USD, and the user is told so in the chat.
  const guard = new CostGuard("chat", false);
  const chat = channel?.receive && !dryRun ? chatLoop(channel, guard, values.once!) : null;
  if (channel && !channel.receive) console.log(`watch: ${channel.label} is one-way; replies aren't read`);
  for (;;) {
    console.log(`\nwatch ${new Date().toLocaleTimeString()}`);
    // classify --new only when posts arrived: it costs nothing otherwise, and a refused run isn't re-asked every tick.
    if ((await discordIngestRun(dir)) > 0) await classify(["--new"]);
    await alertsRun(dryRun, Date.now(), channel);
    if (values.once) {
      await chat;
      return 0;
    }
    await Bun.sleep(everyMs);
  }
}

/** The user's replies, answered as they arrive (long polling), beside the watch ticks. --once reads what's waiting. */
async function chatLoop(channel: MessageChannel, guard: CostGuard, once: boolean): Promise<void> {
  const client = anthropicClient(guard);
  // One post boundary per session (agent.ts buildContext): unseen by any post, and stable so answers share the cache.
  const boundary = randomBytes(6).toString("hex");
  const state = readJsonFile<Record<string, { cursor?: string }>>(CHANNEL_STATE_PATH, {});
  let cursor = state[channel.kind]?.cursor;
  console.log(`chat: reading your ${channel.label} messages${client ? "" : " (no ANTHROPIC_API_KEY: they'll be told answers are off)"}`);
  for (;;) {
    let r: Awaited<ReturnType<NonNullable<MessageChannel["receive"]>>>;
    try {
      r = await channel.receive!(cursor, once ? 0 : 25);
    } catch (e) {
      console.error(`chat: ${(e as Error).message}`);
      if (once) return;
      await Bun.sleep(10_000);
      continue;
    }
    if (r.ignored) console.log(`chat: ${r.ignored} message${r.ignored === 1 ? "" : "s"} not from your chat (or not text) ignored`);
    const { turns, stale } = await handleInbound({
      channel,
      inbound: r.messages,
      nowMs: Date.now(),
      tz: budget().tz,
      history: readChatLog(),
      dailyCapUsd: budget().capUsd,
      ask: async (question, history) => {
        if (!client) return { error: "answers are off (no ANTHROPIC_API_KEY in .env)" };
        const d = readAgentData(Date.now());
        return budgetedAnswer(client, guard, budget(), { question, history, context: buildContext(d, boundary), eventName: d.event?.event ?? "", tz: d.tz });
      },
    });
    for (const t of turns) {
      appendFileSync(CHAT_LOG_PATH, JSON.stringify(t) + "\n");
      console.log(`chat: ${t.status}: ${t.q.slice(0, 80)}`);
    }
    if (stale) console.log(`chat: ${stale} question${stale === 1 ? "" : "s"} sent while watch was off skipped (older than 15 minutes)`);
    if (r.cursor !== cursor) {
      cursor = r.cursor;
      writeJsonFile(CHANNEL_STATE_PATH, { ...readJsonFile<Record<string, { cursor?: string }>>(CHANNEL_STATE_PATH, {}), [channel.kind]: { cursor } });
    }
    if (once) return;
  }
}

/** The event's daily chat budget, from event.json (read per question, so an edit applies at once). */
function budget(): ChatBudget {
  const e = existsSync(EVENT_PATH) ? readEvent() : null;
  return new ChatBudget(e?.chat_daily_usd ?? CHAT_DAILY_USD, e?.timezone ?? "America/Los_Angeles");
}

async function ask(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { at: { type: "string" }, yes: { type: "boolean", default: false } } });
  const question = positionals.join(" ").trim();
  if (!question) {
    console.error('Usage: bun run hr ask "what\'s next on the schedule?"');
    return 2;
  }
  const nowMs = values.at ? Date.parse(values.at) : Date.now();
  if (Number.isNaN(nowMs)) {
    console.error(`--at ${values.at}: not a date (use ISO 8601 with an offset)`);
    return 2;
  }
  const guard = new CostGuard("ask", values.yes!);
  const client = anthropicClient(guard);
  if (!client) return 1;
  const d = readAgentData(nowMs);
  const context = buildContext(d);
  console.log(`ask: context ${context.length} chars (${d.messages.length} posts known, plan ${d.plan ? "saved" : "missing"})`);
  try {
    const b = budget();
    const r = await budgetedAnswer(client, guard, b, { question, history: [] as ChatTurn[], context, eventName: d.event?.event ?? "", tz: d.tz });
    console.log(`ask: today's chat spend $${b.spent(Date.now()).toFixed(4)} of $${b.capUsd.toFixed(2)}`);
    console.log("text" in r ? r.text : `no answer: ${r.error}`);
    return "text" in r ? 0 : 1;
  } catch (e) {
    console.error(e instanceof DailyCapReached ? `${(e as Error).message} (event.json chat_daily_usd sets it)` : (e as Error).message);
    return 1;
  }
}

async function telegramChatId(): Promise<number> {
  let api: TelegramApi;
  try {
    api = new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? "", { fetch: (u, i) => fetch(u, i), sleep: Bun.sleep });
  } catch (e) {
    console.error(`${(e as Error).message}: add TELEGRAM_BOT_TOKEN=... to .env (docs/discord-bot.md)`);
    return 2;
  }
  try {
    const r = await telegramSenders(api);
    if (!r.senders.length) {
      console.log(`No messages yet. In Telegram, open @${r.bot}, send it any message (or tap Start), then run this again.`);
      return 1;
    }
    for (const s of r.senders) console.log(`@${r.bot} has a message from ${s.name || "someone"}: chat ID ${s.chat_id}`);
    console.log(`If that's you, add TELEGRAM_CHAT_ID=${r.senders.length === 1 ? r.senders[0]!.chat_id : "<your chat ID>"} to .env.`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

function compare(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      export: { type: "string", default: DEFAULT_EXPORT_DIR },
      json: { type: "string" },
      cutoff: { type: "string", default: EXPORT_CUTOFF },
      sponsors: { type: "string", default: SPONSORS_PATH },
    },
  });
  const paths = positionals.length ? positionals.map(fromCaller) : [CAPTURES_DIR];
  const files = captureFiles(paths);
  const threadFiles = threadCaptureFiles(paths);
  if (!files.length && !threadFiles.length) {
    console.error("No capture files found. Pass paths, e.g. bun run hr compare ~/Downloads/C0C7TCNCR1N.json");
    return 2;
  }
  const exp = loadExport(fromCaller(values.export!));
  const cutoff = Date.parse(values.cutoff!) / 1000;
  const reports: ChannelReport[] = [];
  for (const f of files) {
    let loaded: LoadedCapture;
    try {
      loaded = loadCapture(f);
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
      continue;
    }
    reports.push(compareChannel(loaded.capture, exp, cutoff, loaded.dropped));
  }

  if (reports.length) {
    printTable(reports);
    for (const r of reports) printDetails(r);
    printLockedCoverage(values.sponsors!, reports);
  }
  const threads = compareThreadFiles(threadFiles, exp, cutoff, values.sponsors!);
  if (values.json) {
    writeFileSync(fromCaller(values.json), JSON.stringify(threadFiles.length ? { channels: reports, threads } : reports, null, 2));
    console.log(`\nwrote ${fromCaller(values.json)}`);
  }
  return reports.some((r) => !r.pass.recall) || (threads && !threads.totals.pass) ? 1 : 0;
}

function syncIngest(args: string[]): number {
  const inbox = join(homedir(), "Downloads", "hackrecon", "sync");
  const dir = args[0] ? fromCaller(args[0]) : existsSync(inbox) ? readdirSync(inbox).filter((d) => BUNDLE_DIR.test(d)).sort().map((d) => join(inbox, d)).pop() : undefined;
  if (!dir || !existsSync(dir)) {
    console.error(`No sync bundle in ${inbox}/. Run "Sync this event" in the extension first.`);
    return 2;
  }
  const stamp = dir.split("/").pop()!;
  const out = join(CAPTURES_DIR, `sync-${stamp}`);
  mkdirSync(out, { recursive: true });
  mkdirSync(SLACK_DOM_FIXTURES_DIR, { recursive: true });
  const read = (sub: string, parts: string[]) => Buffer.concat(parts.map((p) => readFileSync(join(dir, sub, p))));
  let bad = 0;
  for (const sub of ["captures", "slack-dom", "pull"]) {
    if (!existsSync(join(dir, sub))) continue;
    for (const f of wholeFiles(readdirSync(join(dir, sub)))) {
      if (f.missing) {
        console.error(`${sub}/${f.name}: parts ${f.missing.join(", ")} missing; skipped`);
        bad++;
        continue;
      }
      const text = read(sub, f.parts).toString("utf8");
      if (sub === "pull") {
        // The API pull's raw files: kept as pulled (tokens scrubbed again), converted below.
        mkdirSync(join(out, "pull"), { recursive: true });
        const { html, found } = scrubTokens(text);
        if (total(found)) console.log(`pull/${f.name}: stripped ${total(found)} token${total(found) === 1 ? "" : "s"}`);
        writeFileSync(join(out, "pull", f.name), html);
        continue;
      }
      if (sub === "slack-dom") {
        const { html, found } = scrubTokens(text);
        writeFileSync(join(SLACK_DOM_FIXTURES_DIR, f.name), html);
        if (total(found)) console.log(`slack-dom/${f.name}: stripped ${total(found)} token${total(found) === 1 ? "" : "s"} the extension missed`);
        continue;
      }
      try {
        const v = JSON.parse(text);
        if (/\.authors\.json$/.test(f.name)) parseAuthorsCaptureFile(v, f.name, new Set(Object.values(readSponsors(SPONSORS_PATH)).map((s) => s.sponsor)));
        // Hacker-only channels are captured normally, with text (user 2026-11-07); older bundles may still hold .authors.json.
        else if (/\.threads\.json$/.test(f.name)) parseThreadCaptureFile(v, f.name);
        writeFileSync(join(out, f.name), text);
      } catch (e) {
        console.error(`captures/${f.name}: ${(e as Error).message}; skipped`);
        bad++;
      }
    }
  }
  if (existsSync(join(out, "pull"))) bad += convertApiBundle(join(out, "pull"), out, `api-${stamp}`);
  for (const f of captureFiles([out])) {
    try {
      loadCapture(f);
    } catch (e) {
      console.error(`${f}: ${(e as Error).message}`);
      bad++;
    }
  }
  const logPath = join(dir, "sync.json");
  if (existsSync(join(out, "pull"))) {
    const pl = readJsonFile<{ channels?: unknown[]; calls?: number; retries?: number; full?: boolean } | null>(join(out, "pull", "pull.json"), null);
    console.log(pl ? `API pull: ${pl.full ? "full" : "incremental"}, ${pl.channels?.length ?? 0} channels, ${pl.calls} calls, ${pl.retries} retries` : "API pull: no pull.json (stopped early?)");
  } else if (existsSync(logPath)) {
    writeFileSync(join(out, "sync.json"), readFileSync(logPath));
    for (const l of summarizeSync(JSON.parse(readFileSync(logPath, "utf8")) as SyncLogLite)) console.log(l);
  } else console.log("no sync.json in the bundle (the sync may still be running, or stopped before its first channel)");
  console.log(`\ncaptures in ${out}/; samples in ${SLACK_DOM_FIXTURES_DIR}/. Next: bun run hr compare ${out}`);
  return bad ? 1 : 0;
}

async function rebuildThreads(args: string[]): Promise<number> {
  const dir = args[0] ? fromCaller(args[0]) : "";
  if (!dir || !existsSync(dir)) {
    console.error("usage: bun run hr rebuild-threads captures/sync-<stamp>");
    return 2;
  }
  const { parseHTML } = await import("linkedom");
  const toRows = (html: string) => [...(parseHTML(`<html><body><div id="r">${html}</div></body></html>`).document.getElementById("r")?.children ?? [])] as unknown as Element[];
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => /^[CG][A-Z0-9]+\.threads\.raw\.json$/.test(f)).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as { run_id: string; channel_id: string; channel_name: string; started_at: string; finished_at: string; base: string; threads: ThreadRaw[] };
    const ctx = { channelId: raw.channel_id, channelName: raw.channel_name, runId: raw.run_id, capturedAt: raw.finished_at, base: raw.base };
    const file: ThreadCaptureFile = { schema_version: SCHEMA_VERSION, kind: "threads", run_id: raw.run_id, source: "extension", channel_id: raw.channel_id, channel_name: raw.channel_name, started_at: raw.started_at, finished_at: raw.finished_at, budget: "uncapped", threads: raw.threads.map((t) => threadRunFromRaw(t, ctx, toRows)) };
    parseThreadCaptureFile(JSON.parse(JSON.stringify(file)), f);
    const target = join(dir, `${raw.channel_id}.threads.json`);
    const kept = join(dir, `${raw.channel_id}.threads.ext.json`);
    if (existsSync(target) && !existsSync(kept)) renameSync(target, kept);
    writeFileSync(target, JSON.stringify(file, null, 2));
    n++;
    console.log(`${raw.channel_name}: ${file.threads.length} threads, ${file.threads.reduce((a, t) => a + t.replies.length, 0)} replies`);
  }
  console.log(`rebuilt ${n} thread files in ${dir}`);
  return n ? 0 : 2;
}

function scrubDom(args: string[]): number {
  const files = args.length ? args.map(fromCaller) : existsSync(SLACK_DOM_FIXTURES_DIR) ? readdirSync(SLACK_DOM_FIXTURES_DIR).filter((f) => f.endsWith(".html")).sort().map((f) => join(SLACK_DOM_FIXTURES_DIR, f)) : [];
  if (!files.length) {
    console.error(`No DOM samples in ${SLACK_DOM_FIXTURES_DIR}/`);
    return 2;
  }
  let stripped = 0;
  for (const f of files) {
    const { html, found } = scrubTokens(readFileSync(f, "utf8"));
    const n = total(found);
    if (n) writeFileSync(f, html);
    stripped += n;
    const kinds = Object.entries(found).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(", ");
    console.log(`${f.split("/").pop()}: ${n ? `stripped ${n} (${kinds})` : "clean"}`);
  }
  console.log(`${files.length} samples, ${stripped} token${stripped === 1 ? "" : "s"} stripped`);
  return 0;
}

/** Step 1's gate (D5): thread recall over the locked 25's export replies by ts, at least RECALL_MIN. */
function compareThreadFiles(files: string[], exp: ReturnType<typeof loadExport>, cutoff: number, sponsorsPath: string) {
  if (!files.length) return null;
  const reports: ThreadReport[] = [];
  for (const f of files) {
    try {
      reports.push(compareThreads(parseThreadCaptureFile(JSON.parse(readFileSync(f, "utf8")), f), exp, cutoff));
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
    }
  }
  const sponsors = JSON.parse(readFileSync(sponsorsPath, "utf8")) as Record<string, { stretch?: boolean }>;
  const locked = Object.entries(sponsors).filter(([, v]) => !v.stretch).map(([k]) => k);
  const totals = threadTotals(exp, locked, reports.filter((r) => locked.includes(r.channel_name)));
  const rows = reports.map((r) => [
    r.channel_name,
    `${r.matched}/${r.export_replies}`,
    `${pct(r.recall)} ${mark(r.pass.recall)}`,
    `${r.author.matched}/${r.author.checked} ${mark(r.pass.author)}`,
    `${r.threads_opened}/${r.threads_attempted}/${r.threads_in_export}`,
    Object.entries(r.stop_reasons).map(([k, n]) => `${k} ${n}`).join(", "),
    `${r.extras.length}`,
    `${r.duration_s}s`,
  ]);
  const head = ["channel", "replies found", "recall", "author", "threads open/tried/export", "stops", "extra", "time"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((x) => x[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join("  ");
  console.log(`\nThread replies (step 1) against the export, by ts`);
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  rows.forEach((x) => console.log(line(x)));
  for (const r of reports) {
    const why = (k: string) => r.missed.filter((m) => m.why === k).length;
    if (r.missed.length) console.log(`  ${r.channel_name}: missed ${r.missed.length} (in an opened pane ${why("in_pane")}, pane not opened ${why("not_opened")}, thread not tried ${why("not_attempted")})`);
    for (const m of r.missed.filter((m) => m.why === "in_pane").slice(0, 5)) console.log(`    ${m.permalink}  ${m.author}: ${m.text}`);
    for (const x of r.extras) console.log(`    extra ${x.ts} (${x.why}): ${x.text}`);
    for (const c of r.count_mismatches) console.log(`    ${c.thread_ts}: Slack showed ${c.shown} replies, the export has ${c.export}`);
    if (r.no_text.length) console.log(`  ${r.channel_name}: ${r.no_text.length} found with no text (read while Slack still showed its loading placeholder)`);
  }
  const lockedNoText = reports.filter((r) => locked.includes(r.channel_name)).reduce((n, r) => n + r.no_text.length, 0);
  console.log(`\nlocked ${locked.length} thread recall: ${totals.matched}/${totals.replies} = ${pct(totals.recall)} ${mark(totals.pass)} (gate ${pct(RECALL_MIN)})` + (lockedNoText ? `; ${lockedNoText} of them have no text` : "") + (totals.uncaptured.length ? `; no thread file yet: ${totals.uncaptured.join(", ")}` : ""));
  return { reports, totals };
}

function recordRun(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { id: { type: "string" }, sponsors: { type: "string", default: SPONSORS_PATH } },
  });
  if (!values.id) {
    console.error("record-run needs --id, e.g. --id day1-2026-10-27");
    return 2;
  }
  const files = captureFiles(positionals.length ? positionals.map(fromCaller) : [CAPTURES_DIR]);
  if (!files.length) {
    console.error("No capture files found.");
    return 2;
  }
  const sponsors = JSON.parse(readFileSync(values.sponsors!, "utf8")) as Record<string, { stretch?: boolean }>;
  const loaded = files.map(loadCapture);
  const unknown = loaded.map((l) => l.capture.channel_name).filter((c) => !(c in sponsors));
  if (unknown.length) {
    console.error(`Not in ${values.sponsors}: ${unknown.join(", ")}`);
    return 2;
  }
  const { run, messages } = buildRun(values.id, loaded, Object.keys(sponsors));
  saveRun(run, messages);
  const dropped = loaded.flatMap((l) => l.dropped.map((d) => `${l.capture.channel_name} ${d.ts} ${d.reason}`));
  const locked = Object.entries(sponsors).filter(([, v]) => !v.stretch).map(([k]) => k);
  const lockedIn = locked.filter((c) => run.channels.includes(c)).length;
  console.log(
    `recorded ${run.run_id}: ${run.channels.length} channels (${lockedIn}/${locked.length} locked), ${run.message_count} messages, ` +
      `${messages.filter((m) => m.subtype === "thread_broadcast").length} broadcasts, started ${run.started_at}`,
  );
  if (dropped.length) console.log(`non-posts dropped on load: ${dropped.join("; ")}`);
  return 0;
}

function pool(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      seed: { type: "string", default: String(DEFAULT_SEED) },
      export: { type: "string", default: DEFAULT_EXPORT_DIR },
      sponsors: { type: "string", default: SPONSORS_PATH },
      check: { type: "boolean", default: false },
      "add-flagged": { type: "boolean", default: false },
    },
  });
  const existing = readLabels();
  if (values.check) return printLabelProblems(existing) ? 1 : 0;

  const sponsors = readSponsors(values.sponsors!);
  const channels = lockedChannels(sponsors);
  const cands = candidatesFromExport(loadExport(fromCaller(values.export!)), channels);
  const seed = Number(values.seed);
  const prev = readPoolMeta(POOL_META_PATH);
  // Sheets written before the miss checks were blinded marked random rows in the sheet itself.
  const keepRandom = new Set(prev?.random_ids ?? existing.filter((r) => r.pool === "random").map((r) => r.message_id));
  let sel = selectPool(cands, seed, RANDOM_N, keepRandom);
  const messages = readMessages();
  const captured = new Map(messages.map((m) => [m.id, m]));
  const flaggedIds = new Set(prev?.flagged_ids ?? []);
  let flaggedCheck = prev?.flagged_check;

  if (values["add-flagged"]) {
    // Miss check 1 (D12): needs a classifier answer for every captured candidate, not just the sheet.
    const run = readJsonFile<ClassifyRun | null>(RUN_PATH, null);
    const inCapture = cands.filter((c) => captured.has(c.id));
    const classified = new Set(run?.classified ?? []);
    const missing = inCapture.filter((c) => !classified.has(c.id)).length;
    if (!run || missing) {
      console.error(
        `${missing || inCapture.length} of ${inCapture.length} captured messages in the locked channels have no classifier answer in ${ITEMS_PATH}. ` +
          "Run `bun run hr classify` (without --labeled-only) first.",
      );
      return 2;
    }
    const flags = new Set(
      readJsonFile<Item[]>(ITEMS_PATH, [])
        .filter((it) => it.kind === "credit" || it.deadline_status !== "none")
        .map((it) => it.message_id),
    );
    const taken = new Set([...sel.keyword, ...sel.random].map((c) => c.id));
    const before = flaggedIds.size;
    for (const c of inCapture) if (flags.has(c.id) && !taken.has(c.id)) flaggedIds.add(c.id);
    flaggedCheck = { at: new Date().toISOString(), prompt_hash: run.prompt_hash, classified: classified.size, candidates: inCapture.length };
    console.log(`miss check 1: ${flaggedIds.size - before} rows added to the sheet as pool = miss_check (${flaggedIds.size} in total)`);
  }
  sel = withFlagged(sel, cands, flaggedIds);
  const workspace = new URL(messages[0]!.permalink).origin;
  const { rows, orphans } = buildRows(sel, { sponsors, captured, workspace, existing });
  writeSheet(LABELS_PATH, [...rows, ...orphans]);

  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const counts = {
    keyword_top_level: count((r) => r.pool === "keyword" && r.subtype === ""),
    keyword_broadcast: count((r) => r.pool === "keyword" && r.subtype === "thread_broadcast"),
    random: sel.random.length,
    flagged: sel.flagged.length,
    in_capture: count((r) => r.in_capture === "y"),
    not_in_capture: count((r) => r.in_capture === "n"),
    kept_outside_pool: orphans.length,
  };
  const meta: PoolMeta = {
    built_at: new Date().toISOString(),
    runs: readRuns().map((r) => r.run_id),
    channels,
    keyword_regex: KEYWORD_RE.source,
    keyword_flags: KEYWORD_RE.flags,
    seed,
    random_n: RANDOM_N,
    random_ids: sel.random.map((c) => c.id),
    flagged_ids: [...flaggedIds],
    ...(flaggedCheck ? { flagged_check: flaggedCheck } : {}),
    counts,
  };
  writeJsonFile(POOL_META_PATH, meta);
  console.log(
    `wrote ${LABELS_PATH}: ${rows.length + orphans.length} rows from ${channels.length} channels: ` +
      `${counts.keyword_top_level} top-level keyword hits, ${counts.keyword_broadcast} broadcast keyword hits ` +
      `(subtype thread_broadcast), ${counts.random + counts.flagged} miss_check (${counts.random} random, seed ${seed}; ` +
      `${counts.flagged} classifier-flagged${flaggedCheck ? "" : ", check not run yet"}); ${counts.in_capture} in the capture, ${counts.not_in_capture} not`,
  );
  for (const r of orphans) console.log(`kept (labeled, no longer in the pool): ${r.message_id}`);
  console.log(`wrote ${POOL_META_PATH} (which miss check each miss_check row belongs to)`);
  printLabelProblems([...rows, ...orphans]);
  return 0;
}

async function label(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string", default: "4317" }, open: { type: "boolean", default: false } } });
  if (!readLabels().length) {
    console.error(`${LABELS_PATH} not found or empty: run \`bun run hr pool\` first`);
    return 2;
  }
  const app = labelApp(LABELS_PATH);
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(values.port), fetch: app.fetch });
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`labeling ${LABELS_PATH} at ${url} (saves after each row; Ctrl-C to stop)`);
  console.log("Close the sheet in any spreadsheet app while labeling here, or its next save will overwrite these labels.");
  if (values.open) Bun.spawn(["open", url]);
  return new Promise<number>(() => {}); // serve until Ctrl-C
}

async function prelabel(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "include-hand": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      show: { type: "string" },
      sponsors: { type: "string", default: SPONSORS_PATH },
    },
  });
  const rows = readLabels();
  if (!rows.length) {
    console.error(`${LABELS_PATH} not found or empty: run \`bun run hr pool\` first`);
    return 2;
  }
  const sponsors = readSponsors(values.sponsors!);
  const messages = readMessages();
  const system = judgeSystemPrompt(rulesSection(readFileSync(RULES_PATH, "utf8")), readEvent());
  const hash = judgeHash(system);
  // Same builder as hr classify, so the judge reads exactly the classifier's redacted text. Rows the
  // capture missed get their baseline text through the same redaction.
  const captured = new Set(messages.map((m) => m.id));
  const uncaptured = rows.filter((r) => !captured.has(r.message_id)).map(messageFromRow);
  const byId = new Map(redactedInputs(messages, sponsors, hash, uncaptured).map((i) => [i.message.id, i]));
  const inputs = rows.map((r) => byId.get(r.message_id)!);
  const hand = new Set(values["include-hand"] ? [] : rows.filter((r) => labelerOf(r) === HAND_LABELER).map((r) => r.message_id));
  const handRows = rows.filter((r) => labelerOf(r) === HAND_LABELER).length;
  const cache = readJsonFile<JudgeCache>(JUDGE_CACHE_PATH, {});
  let todo = inputs.filter((i) => !hand.has(i.message.id) && !cache[i.key]);
  if (values.limit) todo = todo.slice(0, Number(values.limit));
  console.log(
    `${rows.length} rows: ${handRows} hand-labeled (${values["include-hand"] ? "Opus labels them too: --include-hand" : "kept; --include-hand to have Opus label them"}), ${inputs.filter((i) => !hand.has(i.message.id) && cache[i.key]).length} cached, ` +
      `${todo.length} to label; ${uncaptured.length} not in the capture (baseline text); model ${JUDGE_MODEL}, effort ${JUDGE_EFFORT}, prompt ${hash}`,
  );

  if (values["dry-run"]) {
    const sample = values.show ? inputs.find((i) => i.message.id === values.show) : (todo[0] ?? inputs[0]);
    if (sample) {
      console.log(`\n--- system prompt (${system.length} chars) ---\n${system}`);
      console.log(`\n--- request for ${sample.message.id} (${sample.message.permalink}) ---\n${sample.user}`);
    }
    console.log("\ndry run: no API call, nothing written");
    return 0;
  }

  const guard = new CostGuard("prelabel", values.yes!);
  if (!guard.preflight(todo.map((i) => plannedCall(JUDGE_MODEL, system, i.user, JUDGE_SCHEMA, JUDGE_MAX_TOKENS)))) return 2;
  const client = anthropicClient(guard);
  if (!client) return 2;
  console.log(`Stop \`hr label\` and close ${LABELS_PATH} in any spreadsheet app until this finishes; it rewrites the sheet at the end.`);
  const errors: JudgeRun["errors"] = [];
  const usages: Usage[] = [];
  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let i; (i = queue.shift()); ) {
      const r = await judgeOne(client, system, hash, i);
      usages.push(r.usage);
      if ("entry" in r) cache[i.key] = r.entry;
      else errors.push({ message_id: i.message.id, reason: r.error });
      if (++done % 10 === 0) writeJsonFile(JUDGE_CACHE_PATH, cache), console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  writeJsonFile(JUDGE_CACHE_PATH, cache);

  // Re-read the sheet so hand edits made during the run are kept.
  const answers = new Map<string, Labels>();
  for (const i of inputs) if (cache[i.key]) answers.set(i.message.id, cache[i.key]!.labels);
  const applied = applyJudge(readLabels(), answers, values["include-hand"]);
  writeSheet(LABELS_PATH, applied.rows);
  const usage = sumUsage(usages);
  const run: JudgeRun = {
    model: JUDGE_MODEL,
    labeler: OPUS_LABELER,
    effort: JUDGE_EFFORT,
    prompt_hash: hash,
    rules: `${RULES_PATH} (Columns section, verbatim)`,
    written_at: new Date().toISOString(),
    rows: applied.rows.length,
    labeled: applied.opus,
    kept_hand: applied.hand,
    errors,
    usage,
    cost_usd: Number(costUsd(usage, JUDGE_MODEL).toFixed(4)),
  };
  writeJsonFile(JUDGE_RUN_PATH, run);
  const opusRows = applied.rows.filter((r) => r.labeler === OPUS_LABELER);
  console.log(
    `wrote ${LABELS_PATH}: ${applied.opus} rows labeled by ${OPUS_LABELER} (credit ${opusRows.filter((r) => r.is_credit === "y").length}, ` +
      `dated ${opusRows.filter((r) => r.is_dated === "y").length}), ${applied.hand} hand-labeled kept, ${applied.unlabeled} unlabeled; ` +
      `${errors.length} errors` + (errors.length ? ` (rerun to retry them)` : ""),
  );
  for (const e of errors) console.log(`  error ${e.message_id}: ${e.reason}`);
  console.log(`${formatUsage(usages.length, usage, JUDGE_MODEL)}. Wrote ${JUDGE_RUN_PATH}`);
  printLabelProblems(applied.rows);
  return errors.length ? 1 : 0;
}

function gate(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: "string" } } });
  const rows = readLabels();
  if (!rows.length) {
    console.error(`${LABELS_PATH} not found or empty: run \`bun run hr pool\` first`);
    return 2;
  }
  const run = readJsonFile<ClassifyRun | null>(RUN_PATH, null);
  if (!run) {
    console.error(`${RUN_PATH} not found: run \`bun run hr classify --labeled-only\` first`);
    return 2;
  }
  const meta = readPoolMeta(POOL_META_PATH);
  const judgeRun = readJsonFile<JudgeRun | null>(JUDGE_RUN_PATH, null);
  const randomIds = new Set(meta?.random_ids ?? rows.filter((r) => r.pool === "random").map((r) => r.message_id));
  const report = scoreGate({
    rows,
    items: readJsonFile<Item[]>(ITEMS_PATH, []),
    classified: new Set(run.classified),
    errors: new Set(run.errors),
    randomIds,
    flaggedIds: new Set(meta?.flagged_ids ?? []),
    promptHash: run.prompt_hash,
    currentPromptHash: promptHash(systemPrompt(readEvent(), readRules())),
    // Miss check 1 counts only if it ran on this prompt's flags: a reclassify flags a different set.
    flaggedCheckRan: meta?.flagged_check?.prompt_hash === run.prompt_hash,
    judge: judgeRun
      ? { model: judgeRun.model, promptHash: judgeRun.prompt_hash, currentPromptHash: judgeHash(judgeSystemPrompt(rulesSection(readFileSync(RULES_PATH, "utf8")), readEvent())) }
      : null,
  });
  console.log(formatGate(report));
  if (values.json) writeJsonFile(values.json, report), console.log(`\nwrote ${values.json}`);
  return Object.values(report.pass).every(Boolean) && report.complete ? 0 : 1;
}

/** The grouping request: every sheet row the judge labeled a credit, as the shared redacted input. */
function groupInput(sponsors: Sponsors) {
  const system = groupSystemPrompt(readRules(), readEvent());
  const hash = groupHash(system);
  const rows = readLabels().filter((r) => r.is_credit === "y" && labelProblems(r).length === 0);
  const messages = readMessages();
  const captured = new Set(messages.map((m) => m.id));
  const uncaptured = rows.filter((r) => !captured.has(r.message_id)).map(messageFromRow);
  const byId = new Map(redactedInputs(messages, sponsors, hash, uncaptured).map((i) => [i.message.id, i]));
  const inputs = rows.map((r) => byId.get(r.message_id)!);
  const request = groupRequest(inputs);
  const links = new Set(inputs.flatMap((i) => i.message.links));
  const texts = new Map(inputs.map((i) => [i.message.id, i.message.text]));
  return { system, hash, request, ids: inputs.map((i) => i.message.id), links, texts, input_hash: inputHash(system, request), uncaptured: uncaptured.length };
}

async function group(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false }, force: { type: "boolean", default: false }, yes: { type: "boolean", default: false }, sponsors: { type: "string", default: SPONSORS_PATH } },
  });
  const g = groupInput(readSponsors(values.sponsors!));
  if (!g.ids.length) {
    console.error(`no rows labeled is_credit = y in ${LABELS_PATH}: run \`bun run hr prelabel\` first`);
    return 2;
  }
  const prev = readJsonFile<GroupResult | null>(GROUP_PATH, null);
  console.log(`${g.ids.length} credit posts (${g.uncaptured} not in the capture); model ${GROUP_MODEL}, effort ${GROUP_EFFORT}, prompt ${g.hash}, input ${g.input_hash}; request ${g.request.length} chars`);
  if (values["dry-run"]) {
    console.log(`\n--- system prompt (${g.system.length} chars) ---\n${g.system}\n\n--- request (first 3000 chars) ---\n${g.request.slice(0, 3000)}\n\ndry run: no API call, nothing written`);
    return 0;
  }
  if (prev?.input_hash === g.input_hash && !values.force) {
    console.log(`${GROUP_PATH} is current (${prev.offers.length} offers); --force to rerun`);
    return 0;
  }
  const guard = new CostGuard("group", values.yes!);
  if (!guard.preflight([plannedCall(GROUP_MODEL, g.system, g.request, GROUP_SCHEMA, GROUP_MAX_TOKENS)])) return 2;
  const client = anthropicClient(guard);
  if (!client) return 2;
  const r = await groupOffers(client, g.system, g.request, g.ids, g.links, g.texts);
  const cost = Number(costUsd(r.usage, GROUP_MODEL).toFixed(4));
  if ("error" in r) {
    console.error(`grouping failed after ${r.calls} call(s): ${r.error}. Nothing written. ${formatUsage(r.calls, r.usage, GROUP_MODEL)}`);
    return 1;
  }
  const out: GroupResult = {
    model: GROUP_MODEL,
    effort: GROUP_EFFORT,
    prompt_hash: g.hash,
    input_hash: g.input_hash,
    posts: g.ids.length,
    offers: r.offers,
    not_offers: r.not_offers,
    written_at: new Date().toISOString(),
    usage: r.usage,
    cost_usd: cost,
  };
  writeJsonFile(GROUP_PATH, out);
  console.log(`wrote ${GROUP_PATH}: ${r.offers.length} offers from ${g.ids.length} posts, ${r.not_offers.length} not offers`);
  for (const n of r.not_offers) console.log(`  not an offer ${n.post}: ${n.reason}`);
  console.log(`${formatUsage(r.calls, r.usage, GROUP_MODEL)}. Then: bun run hr preview`);
  return 0;
}

async function board(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { "build-only": { type: "boolean", default: false }, port: { type: "string", default: "0" }, yes: { type: "boolean", default: false }, sponsors: { type: "string", default: SPONSORS_PATH } },
  });
  const sponsors = readSponsors(values.sponsors!);
  const grouped = readJsonFile<GroupResult | null>(GROUP_PATH, null);
  if (!grouped || grouped.input_hash !== groupInput(sponsors).input_hash) {
    console.error(`${GROUP_PATH} is ${grouped ? "stale" : "missing"}: run \`bun run hr group\` first (the board shows only Opus-grouped offers)`);
    return 2;
  }
  const event = readEvent();
  const last = readRuns().at(-1);
  const organizerIds = loadOrganizerIds();
  const person = loadPersonKey();
  const reps = loadRepIndex(person);
  const labels = readLabels();
  const messages = readMessages();
  const data = boardData({
    event: event.event,
    timezone: event.timezone,
    schedule: event.schedule,
    run_id: last?.run_id ?? "",
    channels: last?.channels ?? [],
    messages,
    sponsors,
    offers: withLabelAmounts(grouped.offers, new Map(labels.map((r) => [r.message_id, r]))),
    role: rolesById(messages, sponsors, organizerIds, person, reps.confirmed),
    person,
    reps,
    basis: { grouping: grouped.input_hash, model: grouped.model, written_at: grouped.written_at },
    permalinks: new Map(labels.map((r) => [r.message_id, r.permalink])),
  });
  data.v1_ids = v1Ids(readJsonFile<BoardData | null>(BOARD_DATA_PATH, null), data.offers);
  writeJsonFile(BOARD_DATA_PATH, data);
  console.log(`wrote ${BOARD_DATA_PATH}: ${data.offers.length} offers, ${data.posts.length} posts, ${data.frames.length} frames, ${data.reps.length} sponsor channels`);
  if (values["build-only"]) return 0;
  const headers = { "Cache-Control": "no-store" };
  // D6: the one POST route answers only the board's own page: same Origin, and this run's token from the page.
  const token = crypto.randomUUID();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
  const planContext = () => ({ entities: readJsonFile<CanonPage[]>(CANON_PATH, []).flatMap((p) => p.entities), event: readEvent(), aliases: sponsorAliases(readJsonFile<Sponsors>(SPONSORS_PATH, {})) });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/plan/stream") {
        // P2: Plan's sections as NDJSON, one line per section as it's ready (planstream.ts), tracks first.
        if (req.headers.get("origin") !== `http://127.0.0.1:${server.port}` || req.headers.get("x-hr-token") !== token) return json({ error: "not from this board" }, 403);
        const text = await req.text();
        if (text.length > 16_000) return json({ error: "request too large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return json({ error: "not JSON" }, 400);
        }
        const input = parsePlanBody(body);
        if ("error" in input) return json(input, 400);
        // ?now: the board's review clock (as /ship/list), so P3–P5 join as of that moment; otherwise now.
        const at = new URL(req.url).searchParams.get("now");
        const nowMs = at ? Date.parse(at) : Date.now();
        if (Number.isNaN(nowMs)) return json({ error: "now: not a date" }, 400);
        const ctx = planContext();
        const enc = new TextEncoder();
        let open = true;
        const stream = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            // Read to the end even if the page went away (it typed again): finished model calls are still cached.
            await runPlanStream(input, ctx, { via: "board", nowMs, guard: new CostGuard("board plan", values.yes!) }, (e) => {
              if (!open) return;
              // Errors stay in the server log; the page shows its own sentence.
              const out =
                "error" in e
                  ? { section: e.section, ms: e.ms, error: true }
                  : e.section === "tracks"
                    ? { section: e.section, ms: e.ms, from: e.from, tracks: e.tracks.map((t) => ({ ...t, detail: trackDetail(ctx.entities, t.track_id) })) }
                    : e.section === "gaps"
                      ? { section: e.section, ms: e.ms, from: e.from, gaps: e.gaps, checked: e.checked, repo_lines: e.facts.repo }
                      : e;
              try {
                ctrl.enqueue(enc.encode(JSON.stringify(out) + "\n"));
              } catch {
                open = false;
              }
            });
            if (open) ctrl.close();
          },
          cancel() {
            open = false;
          },
        });
        return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
      }
      if (req.method === "POST" && path === "/ship/gaps") {
        // Ship's Recheck gaps (P9 renders it): the entered tracks against the repo's latest commit.
        if (req.headers.get("origin") !== `http://127.0.0.1:${server.port}` || req.headers.get("x-hr-token") !== token) return json({ error: "not from this board" }, 403);
        const text = await req.text();
        if (text.length > 16_000) return json({ error: "request too large" }, 413);
        let body: { entering?: unknown };
        try {
          body = JSON.parse(text);
        } catch {
          return json({ error: "not JSON" }, 400);
        }
        const input = parsePlanBody(body);
        if ("error" in input) return json(input, 400);
        if (!input.repo) return json({ error: "link a repo to recheck gaps" }, 400);
        const ids = Array.isArray(body.entering) ? body.entering.filter((x): x is string => typeof x === "string").slice(0, 60) : [];
        if (!ids.length) return json({ error: "no tracks entered" }, 400);
        const { entities, event, aliases } = planContext();
        const { tracks, unknown } = shipTracks(entities, ids, event, aliases);
        if (unknown.length) return json({ error: `not tracks on this event: ${unknown.join(", ")}` }, 400);
        const gcache = readJsonFile<GapCache>(GAPS_CACHE_PATH, {});
        const store = readJsonFile<ShipGapStore>(SHIP_GAPS_PATH, {});
        const r = await recheckGaps(anthropicClient(new CostGuard("board ship", values.yes!)), { ...input, repo: input.repo }, tracks, entities, gcache, store);
        if ("error" in r) {
          console.error(`ship: couldn't recheck gaps: ${r.error}`);
          return json({ error: "couldn't recheck gaps" }, 503);
        }
        writeJsonFile(GAPS_CACHE_PATH, gcache);
        writeJsonFile(SHIP_GAPS_PATH, store);
        console.log(`ship: gaps ${r.from} at ${r.commit.slice(0, 7)}`);
        return json(r);
      }
      if (req.method === "POST" && path === "/plan/prefill") {
        // P1b: drafts from a repo link, each with its source lines. Nothing is saved here: the page shows each draft
        // and fills the input only with the ones the user picks.
        if (req.headers.get("origin") !== `http://127.0.0.1:${server.port}` || req.headers.get("x-hr-token") !== token) return json({ error: "not from this board" }, 403);
        const text = await req.text();
        if (text.length > 1_000) return json({ error: "request too large" }, 413);
        let body: { repo?: unknown };
        try {
          body = JSON.parse(text);
        } catch {
          return json({ error: "not JSON" }, 400);
        }
        const url = typeof body.repo === "string" ? body.repo.trim() : "";
        const repo = checkoutRepo(url);
        if ("error" in repo) return json({ error: repo.error.startsWith("only public") ? repo.error : "couldn't read that repo: is it public?" }, 400);
        const cache = readJsonFile<PrefillCache>(PREFILL_CACHE_PATH, {});
        const t0 = Date.now();
        const r = await prefillDraft(anthropicClient(new CostGuard("board prefill", values.yes!)), repo, repoTexts(repo), cache, readProducts());
        if ("error" in r) {
          console.error(`plan: prefill failed: ${r.error}`);
          return json({ error: "couldn't draft from that repo" }, 503);
        }
        writeJsonFile(PREFILL_CACHE_PATH, cache);
        console.log(`plan: prefill ${repo.url} @ ${repo.sha.slice(0, 7)} in ${Date.now() - t0} ms (${r.from}; ${r.added.length} sponsor products added)`);
        return json({ repo: repo.url, commit: repo.sha, draft: r.draft });
      }
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (path === "/ship/list") {
        // Ship's checklist (P9) for the tracks the viewer entered, as of ?now (the board's review clock) or now.
        const q = new URL(req.url).searchParams;
        const { entities, event } = planContext();
        const trackIds = new Set(entities.filter((x) => x.kind === "track").map((x) => x.id));
        const entered = (q.get("entered") ?? "").split(",").filter(Boolean).slice(0, 60);
        const unknown = entered.filter((id) => !trackIds.has(id));
        if (unknown.length) return json({ error: `not tracks on this event: ${unknown.join(", ")}` }, 400);
        const nowMs = q.get("now") ? Date.parse(q.get("now")!) : Date.now();
        if (Number.isNaN(nowMs)) return json({ error: "now: not a date" }, 400);
        return json(shipListAt(entities, event, entered, nowMs));
      }
      if (path === "/plan/meta") {
        const { entities, event } = planContext();
        // ?now: the board's review clock, as /ship/list; a replay never shows a time before its post.
        const at = new URL(req.url).searchParams.get("now");
        const nowMs = at ? Date.parse(at) : undefined;
        if (Number.isNaN(nowMs)) return json({ error: "now: not a date" }, 400);
        return json({ ...planMeta(entities, event, nowMs), version: dataVersion(), stale: stalePages() });
      }
      if (path === "/")
        return new Response(readFileSync(BOARD_PAGE, "utf8").replace('<meta name="hr-token" content="">', `<meta name="hr-token" content="${token}">`).replace("<!-- prefill.js -->", () => `<script>${readFileSync(BOARD_PREFILL_JS, "utf8")}</script>`).replace("<!-- live.js -->", () => `<script>${readFileSync(BOARD_LIVE_JS, "utf8")}</script>`), {
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'",
          },
        });
      if (path === "/board.json") return new Response(readFileSync(BOARD_DATA_PATH, "utf8"), { headers: { ...headers, "Content-Type": "application/json" } });
      const font = BOARD_FONTS.find((f) => path === `/fonts/${f}`);
      if (font) return new Response(readFileSync(BOARD_FONT_DIR + font), { headers: { "Content-Type": "font/woff2", "Cache-Control": "max-age=86400" } });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`board: http://127.0.0.1:${server.port}/  (local only; Ctrl-C to stop)`);
  return await new Promise<number>(() => {});
}

async function pages(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { "from-html": { type: "string" }, url: { type: "string" }, access: { type: "string" } } });
  if (values["from-html"]) {
    if (!values.url || !PAGE_ACCESS.includes(values.access as PageAccess)) {
      console.error(`--from-html needs --url URL and --access ${PAGE_ACCESS.join("|")}`);
      return 2;
    }
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(readFileSync(fromCaller(values["from-html"]), "utf8"));
    const snap = snapshotPage(document as unknown as Document, { url: values.url, captured_at: new Date().toISOString(), access: values.access as PageAccess, captured_by: "fixture" });
    const out = `${PAGE_FIXTURES_DIR}/${pageFileName(values.url)}`;
    writeJsonFile(out, snap);
    console.log(`wrote ${out}: ${snap.blocks.length} blocks, ${snap.links.length} links${snap.no_text ? ` (${snap.no_text})` : ""}`);
    return 0;
  }
  const event = readEvent();
  const wanted = [...(event.canon_pages ?? []), ...(event.schedule_pages ?? [])];
  const { pages: loaded, errors } = loadPages(PAGES_DIR);
  for (const e of errors) console.error(`unreadable: ${e}`);
  const { latest, missing } = pageCoverage(loaded, wanted);
  if (!loaded.length) console.log(`No page snapshots in ${PAGES_DIR} yet. Use the extension's "Capture this page".`);
  for (const p of latest.values()) {
    const s = p.snapshot;
    const access = s.access ?? "no flag (treated as authenticated)";
    console.log(`${s.url}\n  ${s.captured_at}  ${access}  ${s.blocks.length} blocks  hash ${p.hash}${s.no_text ? `  ${s.no_text}` : ""}`);
  }
  if (!wanted.length) console.log(`${EVENT_PATH} lists no canon_pages or schedule_pages.`);
  for (const u of missing) console.log(`missing: ${u} (in ${EVENT_PATH}, no snapshot yet)`);
  return errors.length ? 1 : 0;
}

interface CanonPage {
  url: string;
  file: string;
  captured_by: PageSnapshot["captured_by"];
  access: string | null;
  snapshot_hash: string;
  redacted: number | null;
  model: string;
  prompt_hash: string;
  input_hash: string;
  entities: Entity[];
  coverage: CoverageReport;
  /** D7: ids from the previous extraction with no entity left (or two candidates), shown "no longer on the page". */
  no_longer_on_page: { id: string; reason: "no match" | "ambiguous"; best: number }[];
  /** Entry steps and requirements this read lacked, carried over from the previous read (canon.ts keepDropped). */
  kept_from_previous?: KeptField[];
  match_keys: Keyed[];
  usage: Usage;
  cost_usd: number;
  written_at: string;
}
interface CanonJudged {
  url: string;
  input_hash: string;
  verdict: JudgeVerdict;
  usage: Usage;
  cost_usd: number;
  written_at: string;
}

function canonInput(p: LoadedPage, event: EventConfig) {
  let snap = p.snapshot;
  let redacted: number | null = null;
  if (needsRedaction(snap)) {
    // D12: logged-in page (or no flag): redact with the captured posters' names, as for Slack.
    const names = new Set(readMessages().filter((m) => m.author_kind !== "bot").map((m) => m.author_name));
    const r = redactSnapshot(snap, compileRedactor(buildNameList(names, readSponsors(SPONSORS_PATH))));
    snap = r.snapshot;
    redacted = r.replaced;
  }
  const system = canonSystemPrompt(event);
  const request = canonRequest(snap);
  return { snap, redacted, system, request, prompt_hash: canonHash(system), input_hash: canonInputHash(system, request) };
}

/** The only way hr makes a client: every call passes through the run's spend guard (costguard.ts). */
function anthropicClient(guard: CostGuard): Anthropic | null {
  try {
    return guardClient(new Anthropic({ maxRetries: 2 }), guard);
  } catch (e) {
    console.error(`No Anthropic credentials: add ANTHROPIC_API_KEY=... to .env (Bun loads it; .env is gitignored). ${(e as Error).message}`);
    return null;
  }
}

/** A re-read never silently drops fields (user 2026-11-07): entry steps and requirements the previous read had are
 *  kept (keepDropped), and every kept one and every id no longer on the page is printed. */
function keepPrevious(prev: CanonPage | undefined, next: Entity[], gone: CanonPage["no_longer_on_page"], snap: PageSnapshot): { entities: Entity[]; kept: KeptField[] } {
  const r = keepDropped(prev?.entities ?? [], next, snap);
  for (const k of r.kept)
    console.log(`kept from the previous read (this read lacks it): ${k.kind} ${k.id}: "${k.value}"${k.quote_on_page ? "" : "; its quote is no longer in this snapshot, so check the page"}`);
  for (const g of gone) console.log(`no longer on the page (${g.reason}): ${g.id}`);
  return r;
}

/** D7: an entity whose id changed but whose page text still matches keeps its previous id, so done and
 *  selected marks survive; previous ids with nothing left are kept in no_longer_on_page until they reappear. */
function carryIds(prev: CanonPage | undefined, next: Entity[], snap: PageSnapshot): { entities: Entity[]; gone: CanonPage["no_longer_on_page"] } {
  if (!prev?.match_keys) return { entities: next, gone: [] };
  const m = rematch(prev.match_keys, keyed(next, snap), REMATCH_THRESHOLD);
  const fix = (v: unknown) => (typeof v === "string" && m.renamed.has(v) ? m.renamed.get(v)! : v);
  const entities = next.map((e) => ({
    ...e,
    id: m.renamed.get(e.id) ?? e.id,
    fields: Object.fromEntries(Object.entries(e.fields).map(([k, fv]) => [k, k === "track_id" || k === "applies_to" ? { ...fv, value: fix(fv.value) } : fv])),
  }));
  const gone = [...m.gone, ...(prev.no_longer_on_page ?? [])].filter((g, i, all) => all.findIndex((x) => x.id === g.id) === i && !entities.some((e) => e.id === g.id));
  if (m.renamed.size || gone.length) console.log(`D7: ${m.renamed.size} entities kept their previous id; ${gone.length} no longer on the page`);
  return { entities, gone };
}

interface StoredExtraction {
  entities: Entity[];
  usage: CanonPage["usage"];
  written_at: string;
  /** The output file the extraction was first written to. */
  from: string;
}

async function canon(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { fixtures: { type: "boolean", default: false }, judge: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, force: { type: "boolean", default: false }, yes: { type: "boolean", default: false } },
  });
  const event = readEvent();
  const dir = values.fixtures ? PAGE_FIXTURES_DIR : PAGES_DIR;
  const outPath = values.fixtures ? CANON_FIXTURES_PATH : CANON_PATH;
  const judgePath = values.fixtures ? CANON_JUDGE_FIXTURES_PATH : CANON_JUDGE_PATH;
  const { pages: loaded, errors } = loadPages(dir);
  for (const e of errors) console.error(`unreadable: ${e}`);
  const { latest, missing } = pageCoverage(loaded, event.canon_pages ?? []);
  for (const u of missing) console.log(`missing: ${u} has no snapshot in ${dir}`);
  const todo = [...latest.values()].filter((p) => (event.canon_pages ?? []).some((u) => pageKey(u) === pageKey(p.snapshot.url)));
  if (!todo.length) {
    console.error(`no snapshots of ${EVENT_PATH} canon_pages in ${dir}${values.fixtures ? "" : ': use the extension\'s "Capture this page", or --fixtures'}`);
    return 2;
  }
  const prev = new Map(readJsonFile<CanonPage[]>(outPath, []).map((c) => [pageKey(c.url), c]));
  const store = readJsonFile<Record<string, StoredExtraction>>(CANON_STORE_PATH, {});
  // Seed from pages already extracted (either output file), so text extracted once is never extracted again.
  for (const path of [CANON_FIXTURES_PATH, CANON_PATH])
    for (const pg of readJsonFile<CanonPage[]>(path, [])) store[`${pg.prompt_hash}|${pg.input_hash}`] ??= { entities: pg.entities, usage: pg.usage, written_at: pg.written_at, from: path };
  const out: CanonPage[] = [];
  let client: Anthropic | null = null;
  let failed = errors.length > 0 || missing.length > 0;
  // The spend guard: the same rule as the loop below decides which pages call the model.
  const guard = new CostGuard("canon", values.yes!);
  if (!values["dry-run"]) {
    const calls = todo.flatMap((p) => {
      const c = canonInput(p, event);
      const page = prev.get(pageKey(p.snapshot.url));
      const stored = store[`${c.prompt_hash}|${c.input_hash}`];
      return (stored && !values.force) || (page && page.input_hash === c.input_hash && !values.force) ? [] : [plannedCall(CANON_MODEL, c.system, c.request, CANON_SCHEMA, CANON_MAX_TOKENS)];
    });
    if (!guard.preflight(calls)) return 2;
    if (values.judge) console.log("canon: the judge's calls are estimated as they run, and stop at the same limit");
  }
  for (const p of todo) {
    const c = canonInput(p, event);
    const key = pageKey(p.snapshot.url);
    console.log(`\n${p.snapshot.url}  ${p.snapshot.captured_by}, ${p.snapshot.access ?? "no access flag"}${c.redacted !== null ? `, redacted (${c.redacted} replaced)` : ""}; ${p.snapshot.blocks.length} blocks, request ${c.request.length} chars, prompt ${c.prompt_hash}, input ${c.input_hash}`);
    if (values["dry-run"]) {
      console.log(`--- system prompt (${c.system.length} chars) ---\n${c.system}\n--- request (first 2000 chars) ---\n${c.request.slice(0, 2000)}`);
      continue;
    }
    let page = prev.get(key);
    const stored = store[`${c.prompt_hash}|${c.input_hash}`];
    // The store wins over this file's own copy: one input has one extraction, whichever file asks.
    if (stored && !values.force) {
      const read = carryIds(page, assignIds(stored.entities, c.snap), c.snap);
      const { entities, kept } = keepPrevious(page, read.entities, read.gone, c.snap);
      const gone = read.gone;
      page = {
        url: p.snapshot.url,
        file: p.file,
        captured_by: p.snapshot.captured_by,
        access: p.snapshot.access,
        snapshot_hash: p.hash,
        redacted: c.redacted,
        model: CANON_MODEL,
        prompt_hash: c.prompt_hash,
        input_hash: c.input_hash,
        entities,
        coverage: coverage(c.snap, entities),
        no_longer_on_page: gone,
        ...(kept.length ? { kept_from_previous: kept } : {}),
        match_keys: keyed(entities, c.snap),
        usage: stored.usage,
        cost_usd: 0,
        written_at: stored.written_at,
      };
      console.log(`stored extraction (${entities.length} entities, same prompt and input as ${stored.from} at ${stored.written_at.slice(0, 19)}); --force to re-extract`);
    } else if (!page || page.input_hash !== c.input_hash || values.force) {
      client ??= anthropicClient(guard);
      if (!client) return 2;
      const r = await callChecked(client, {
        model: CANON_MODEL,
        effort: CANON_EFFORT,
        max_tokens: CANON_MAX_TOKENS,
        system: c.system,
        schema: CANON_SCHEMA,
        request: c.request,
        check: (parsed) => checkCanon(parsed, c.snap, p.hash),
      });
      console.log(formatUsage(r.calls, r.usage, CANON_MODEL));
      if ("error" in r) {
        console.error(`extraction failed after ${r.calls} call(s): ${r.error}. Nothing written for this page.`);
        failed = true;
        if (page) out.push(page);
        continue;
      }
      const read = carryIds(page, r.value.entities, c.snap);
      const { entities, kept } = keepPrevious(page, read.entities, read.gone, c.snap);
      const gone = read.gone;
      page = {
        url: p.snapshot.url,
        file: p.file,
        captured_by: p.snapshot.captured_by,
        access: p.snapshot.access,
        snapshot_hash: p.hash,
        redacted: c.redacted,
        model: CANON_MODEL,
        prompt_hash: c.prompt_hash,
        input_hash: c.input_hash,
        entities,
        coverage: coverage(c.snap, entities),
        no_longer_on_page: gone,
        ...(kept.length ? { kept_from_previous: kept } : {}),
        match_keys: keyed(entities, c.snap),
        usage: r.usage,
        cost_usd: Number(costUsd(r.usage, CANON_MODEL).toFixed(4)),
        written_at: new Date().toISOString(),
      };
      store[`${c.prompt_hash}|${c.input_hash}`] = { entities: page.entities, usage: r.usage, written_at: page.written_at, from: outPath };
    } else {
      // Same input: ids are re-derived anyway, so a change to the id scheme reaches cached pages (marks follow, D7).
      const { entities, gone } = carryIds(page, assignIds(page.entities, c.snap), c.snap);
      page = { ...page, entities, no_longer_on_page: gone, match_keys: keyed(entities, c.snap), coverage: coverage(c.snap, entities) };
      console.log(`cached (${page.entities.length} entities, input unchanged); --force to rerun`);
    }
    out.push(page);
    const byKind = new Map<string, number>();
    for (const e of page.entities) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    const counts = [...byKind].map(([k, n]) => `${n} ${k}`);
    console.log(`entities: ${counts.join(", ") || "none"}`);
    for (const ch of page.coverage.checks) {
      console.log(`  ${ch.pass === null ? "n/a " : ch.pass ? "PASS" : "FAIL"} ${ch.name}: ${ch.summary}`);
      for (const d of ch.details.slice(0, ch.pass === false ? 60 : 25)) console.log(`       ${d}`);
      if (ch.details.length > 25 && ch.pass !== false) console.log(`       … ${ch.details.length - 25} more in ${outPath}`);
    }
    if (!page.coverage.pass) failed = true;
  }
  if (values["dry-run"]) {
    console.log("\ndry run: no API call, nothing written");
    return 0;
  }
  writeJsonFile(CANON_STORE_PATH, store);
  for (const [k, c] of prev) if (!out.some((o) => pageKey(o.url) === k)) out.push(c); // pages no longer listed stay until removed by hand
  // A page record a new snapshot replaces is kept (live canon only): merge places each changed field in the window
  // between the two captures (§3 rule 2).
  const replaced = values.fixtures ? [] : out.flatMap((o) => { const p = prev.get(pageKey(o.url)); return p && p.snapshot_hash !== o.snapshot_hash ? [p] : []; });
  if (replaced.length) writeJsonFile(CANON_HISTORY_PATH, [...readJsonFile<CanonPage[]>(CANON_HISTORY_PATH, []), ...replaced]);
  writeJsonFile(outPath, out);
  console.log(`\nwrote ${outPath}: ${out.length} page(s), ${out.reduce((n, p) => n + p.entities.length, 0)} entities`);

  if (values.judge) {
    const judged = new Map(readJsonFile<CanonJudged[]>(judgePath, []).map((j) => [pageKey(j.url), j]));
    for (const page of out.filter((o) => todo.some((t) => pageKey(t.snapshot.url) === pageKey(o.url)))) {
      const p = todo.find((t) => pageKey(t.snapshot.url) === pageKey(page.url))!;
      const snap = canonInput(p, event).snap;
      const system = canonJudgeSystemPrompt(event);
      const request = canonJudgeRequest(snap, page.entities);
      const input_hash = canonInputHash(system, request);
      let j = judged.get(pageKey(page.url));
      if (!j || j.input_hash !== input_hash || values.force) {
        client ??= anthropicClient(guard);
        if (!client) return 2;
        const r = await callChecked(client, {
          model: CANON_MODEL,
          effort: CANON_EFFORT,
          max_tokens: CANON_MAX_TOKENS,
          system,
          schema: CANON_JUDGE_SCHEMA,
          request,
          check: (parsed) => checkJudge(parsed, snap, page.entities),
        });
        console.log(`\njudge ${page.url}: ${formatUsage(r.calls, r.usage, CANON_MODEL)}`);
        if ("error" in r) {
          console.error(`judge failed: ${r.error}`);
          failed = true;
          continue;
        }
        j = { url: page.url, input_hash, verdict: r.value, usage: r.usage, cost_usd: Number(costUsd(r.usage, CANON_MODEL).toFixed(4)), written_at: new Date().toISOString() };
        judged.set(pageKey(page.url), j);
      } else console.log(`\njudge ${page.url}: cached`);
      const v = j.verdict;
      console.log(`  ${v.missing.length || v.misplaced.length ? "FAIL" : "PASS"} judge (agreement with Opus): ${v.missing.length} missing, ${v.misplaced.length} misplaced`);
      for (const m of v.missing) console.log(`       missing ${m.kind} [${m.block}]: ${m.what}`);
      for (const m of v.misplaced) console.log(`       misplaced ${m.entity_id}: ${m.problem}`);
      if (v.missing.length || v.misplaced.length) failed = true;
    }
    writeJsonFile(judgePath, [...judged.values()]);
  }
  return failed ? 1 : 0;
}

async function sync(args: string[]): Promise<number> {
  // --canon: re-read changed pages with the model (hr canon --judge); never without it (user 2026-11-07).
  const { values } = parseArgs({ args, options: { canon: { type: "boolean", default: false }, yes: { type: "boolean", default: false }, offline: { type: "boolean", default: false } } });
  // Zero setup: a new event's first sync writes its config from the workspace and Devpost (hr discover, no model).
  if (!existsSync(EVENT_PATH)) {
    console.log(`no ${EVENT_PATH} yet: discovering it`);
    const code = await discover(values.offline ? ["--offline"] : []);
    if (code) return code;
  }
  const event = readEvent();
  const messages = readMessages();
  const caps = captureFiles([CAPTURES_DIR]).map((f) => loadCapture(f).capture);
  const channels = [...new Set([...caps.map((c) => c.channel_name), ...messages.map((m) => m.channel_name)])].sort();
  // Announcement channels: Slack's restricted-posting flag first (a signal hackers can't set, D19), then config, then names.
  const flagged = caps.filter((c) => c.posting_restricted === true).map((c) => c.channel_name);
  const unknown = caps.filter((c) => c.posting_restricted == null).length;
  const [annSource, ann] = flagged.length
    ? ["Slack restricted-posting notice", flagged]
    : event.authority_channels?.length
      ? ["event.json authority_channels", event.authority_channels]
      : ["channel name contains \"announce\" (no capture carries the restricted-posting flag yet: unverified)", channels.filter((c) => /announce/i.test(c))];
  const announcement = new Set(ann);
  console.log(`announcement channels (${annSource}): ${[...announcement].join(", ") || "none"}${unknown ? `; ${unknown} of ${caps.length} captures predate or lack the restricted-posting flag` : ""}`);

  // Trust (security review 2026-11-06): a channel's name proves nothing, since hackers can often create channels.
  // Under the name fallback only posts by listed organizer ids count, and with no list nothing from Slack is
  // fetched or made canon. Slack's restricted-posting flag and the user's authority_channels are trusted as is.
  const nameOnly = !flagged.length && !event.authority_channels?.length;
  const listed = existsSync(ORGANIZERS_PATH) ? loadOrganizerIds() : new Set<string>();
  const trusted = nameOnly ? messages.filter((m) => !!m.author_id && listed.has(m.author_id)) : messages;
  if (nameOnly) console.log(listed.size ? `name-only announcement channels: counting only posts by the ${listed.size} ids in ${ORGANIZERS_PATH}` : `name-only announcement channels and no ${ORGANIZERS_PATH}: Slack links are listed, not fetched; set authority_channels or capture with the restricted-posting flag`);
  const found = discoverUrls(trusted, nameOnly && !listed.size ? new Set() : announcement);
  const untrusted = nameOnly && !listed.size ? discoverUrls(messages, announcement) : null;
  if (untrusted?.devpost) console.log(`unverified Devpost link (not used): ${untrusted.devpost.url}`);
  const fetcher = new PoliteFetcher();
  let devpostRoot = found.devpost?.url ?? null;
  let devpostWhy = found.devpost?.why ?? "";
  if (!devpostRoot && !values.offline) {
    const r = await fetcher.get(`https://devpost.com/api/hackathons?search=${encodeURIComponent(event.event)}`, "json");
    if (r.status === "fetched" && r.html) {
      const pick = pickDevpostHit(event.event, ((JSON.parse(r.html) as { hackathons?: DevpostHit[] }).hackathons ?? []));
      devpostRoot = pick.hit ? new URL(pick.hit.url).origin + "/" : null;
      devpostWhy = pick.why;
    } else devpostWhy = `Devpost search failed: ${r.detail}`;
  }
  console.log(`devpost: ${devpostRoot ?? "not found"}${devpostWhy ? ` (${devpostWhy})` : ""}${found.devpost_other.length ? `; also linked: ${found.devpost_other.map((f) => f.url).join(", ")}` : ""}`);
  const canonPages = event.canon_pages?.length ? event.canon_pages : devpostRoot ? devpostCanonPages(devpostRoot) : [];
  const schedulePages = event.schedule_pages?.length ? event.schedule_pages : found.schedule.map((f) => f.url);
  if (event.canon_pages?.length && devpostRoot && !event.canon_pages.some((u) => pageKey(u) === pageKey(devpostRoot!))) console.log(`note: event.json canon_pages doesn't include the discovered ${devpostRoot}; keeping event.json`);
  for (const f of found.schedule) console.log(`schedule candidate: ${f.url} (${f.why}, ${f.posts.length} post${f.posts.length === 1 ? "" : "s"})`);

  // Fetch: every public page, once each this sync.
  type Fetched = FetchResult & { saved?: string; hash?: string; changed?: boolean; role: string };
  const results: Fetched[] = [];
  if (!values.offline) {
    const { latest } = pageCoverage(loadPages(PAGES_DIR).pages, [...canonPages, ...schedulePages]);
    const { parseHTML } = await import("linkedom");
    for (const [role, list] of [["canon", canonPages], ["schedule", schedulePages]] as const)
      for (const url of list) {
        const r: Fetched = { ...(await fetcher.get(url)), role };
        if (r.status === "fetched" && r.html) {
          const { document } = parseHTML(r.html);
          const snap = snapshotPage(document as unknown as Document, { url, captured_at: new Date().toISOString(), access: "public", captured_by: "fetch" });
          const why = needsExtension(snap, r.html);
          if (why) Object.assign(r, { status: "needs_extension", detail: why });
          else {
            const hash = snapshotHash(snap);
            const prev = latest.get(pageKey(url));
            r.hash = hash;
            r.changed = !prev || prev.hash !== hash;
            // Same text from another path (a fixture or the extension): rewrite so provenance says "fetch".
            if (r.changed || prev!.snapshot.captured_by !== "fetch") writeJsonFile((r.saved = `${PAGES_DIR}/${pageFileName(url)}`), snap);
          }
        }
        delete r.html;
        results.push(r);
        console.log(`${r.status.padEnd(17)} ${url}  ${r.detail}${r.hash ? `; hash ${r.hash}${r.changed ? ", changed: saved" : r.saved ? ", same text, now saved as fetched" : ", unchanged"}` : ""}`);
      }
    const reqs = results.reduce((n, r) => n + r.requests, 0) + fetcher.robotsRequests;
    console.log(`${results.length} pages, ${reqs} HTTP requests (${fetcher.robotsRequests} robots.txt)`);
  }

  // Pages the extension read in a background tab during "Sync this event" (Devpost refuses most plain fetches).
  const inbox = join(homedir(), "Downloads", "hackrecon", "pages");
  const ingested: (IngestDecision & { file: string })[] = [];
  if (existsSync(inbox)) {
    const wantedKeys = new Set([...canonPages, ...schedulePages].map(pageKey));
    const { latest } = pageCoverage(loadPages(PAGES_DIR).pages, [...canonPages, ...schedulePages]);
    mkdirSync(join(inbox, "ingested"), { recursive: true });
    for (const f of readdirSync(inbox).filter((f) => f.endsWith(".page.json"))) {
      const path = join(inbox, f);
      let snap: PageSnapshot;
      try {
        snap = parsePageSnapshot(JSON.parse(readFileSync(path, "utf8")), f);
      } catch (e) {
        console.error(`extension page ${f}: unreadable (${(e as Error).message}); left in place`);
        continue;
      }
      const cur = latest.get(pageKey(snap.url));
      const d = decideIngest(snap, wantedKeys, cur && { hash: cur.hash, captured_at: cur.snapshot.captured_at });
      if (d.snapshot) {
        writeJsonFile(`${PAGES_DIR}/${pageFileName(snap.url)}`, d.snapshot);
        results.push({ url: snap.url, status: "fetched", detail: `from the extension: ${d.detail}`, requests: 0, role: canonPages.some((u) => pageKey(u) === pageKey(snap.url)) ? "canon" : "schedule", hash: snapshotHash(d.snapshot), changed: true });
      }
      renameSync(path, join(inbox, "ingested", `${Date.now()}-${f}`));
      ingested.push({ ...d, file: f, snapshot: undefined });
      console.log(`extension page   ${snap.url}  ${d.action}: ${d.detail}`);
    }
  }

  // Drafts. Config the user wrote wins: a draft only fills a missing file, else it's compared and reported.
  const canonEntities = readJsonFile<CanonPage[]>(CANON_PATH, []).flatMap((p) => p.entities);
  const draft = sponsorsDraft(canonEntities, channels, announcement);
  let sponsorReport: ReturnType<typeof compareSponsors> | null = null;
  if (!existsSync(SPONSORS_PATH)) {
    writeJsonFile(SPONSORS_PATH, draft.sponsors);
    console.log(`wrote ${SPONSORS_PATH} (draft: ${Object.keys(draft.sponsors).length} channels; check it)`);
  } else {
    sponsorReport = compareSponsors(draft.sponsors, readSponsors(SPONSORS_PATH));
    console.log(`sponsors draft vs ${SPONSORS_PATH}: ${sponsorReport.matched}/${sponsorReport.n} channels agree on sponsor and kind`);
    for (const r of sponsorReport.rows.filter((r) => !r.match)) console.log(`  ${r.channel}: yours ${r.hand}, draft ${r.draft}`);
  }
  if (draft.tags_without_channel.length) console.log(`Devpost sponsors with no channel: ${draft.tags_without_channel.join(", ")}`);
  if (draft.channels_without_tag.length) console.log(`sponsor channels with no Devpost prize: ${draft.channels_without_tag.join(", ")}`);
  const proposals = organizersFromRestricted(messages, announcement);
  const known = existsSync(ORGANIZERS_PATH) ? loadOrganizerIds() : new Set<string>();
  const newOnes = proposals.filter((p) => !known.has(p.id));
  console.log(`organizers from restricted-posting channels: ${proposals.length} posters; ${proposals.length - newOnes.length} already in ${ORGANIZERS_PATH}${known.size ? ` (${known.size} listed)` : ""}${newOnes.length ? `, ${newOnes.length} new (in ${DISCOVERED_PATH}, not applied)` : ""}`);
  if (!existsSync(ORGANIZERS_PATH) && proposals.length && annSource.startsWith("Slack")) {
    writeJsonFile(ORGANIZERS_PATH, proposals.map((p) => ({ id: p.id, why: ["restricted-posting channel"] })));
    console.log(`wrote ${ORGANIZERS_PATH} from the restricted-posting channels (confirm once)`);
  }
  writeJsonFile(DISCOVERED_PATH, {
    synced_at: new Date().toISOString(),
    announcement: { source: annSource, channels: [...announcement] },
    devpost: { root: devpostRoot, why: devpostWhy, other: found.devpost_other },
    canon_pages: canonPages,
    schedule: found.schedule,
    fetch: results,
    extension_pages: ingested,
    sponsors: { draft: draft.sponsors, tags_without_channel: draft.tags_without_channel, channels_without_tag: draft.channels_without_tag, vs_config: sponsorReport },
    organizers: { proposals: newOnes, known_matched: proposals.length - newOnes.length },
  });
  console.log(`wrote ${DISCOVERED_PATH}`);
  const stuck = results.filter((r) => r.status !== "fetched");
  for (const r of stuck.filter((r) => r.status === "needs_extension" || r.status === "refused")) console.log(`the extension reads it in a background tab on the next "Sync this event": ${r.url}`);
  const have = new Set(loadPages(PAGES_DIR).pages.map((p) => pageKey(p.snapshot.url)));
  const lost = results.filter((r) => r.role === "canon" && r.status !== "fetched" && !have.has(pageKey(r.url)));
  for (const r of lost) console.error(`no snapshot at all for canon page ${r.url}`);
  const changed = results.filter((r) => r.changed && r.role === "canon");
  if (!values.canon || values.offline || !changed.length) {
    if (changed.length) console.log(`canon pages changed (${changed.map((r) => r.url).join(", ")}); no model was called. To re-read them: bun run hr sync --canon, or bun run hr canon --judge`);
    return lost.length ? 1 : 0;
  }
  return canon(["--judge", ...(values.yes ? ["--yes"] : [])]);
}

interface FitCached {
  ranked: Ranked[];
  usage: Usage;
  calls: number;
}

type PlanContext = { entities: Entity[]; event: EventConfig; aliases: SponsorAliases };

async function runPlanStream(input: PlanInput, ctx: PlanContext, opts: { via: "board" | "cli"; fresh?: boolean; nowMs?: number; guard: CostGuard }, on: (e: PlanEvent) => void): Promise<PlanEvent[]> {
  const fcache = opts.fresh ? {} : readJsonFile<FitCache>(FIT_CACHE_PATH, {});
  const gcache = opts.fresh ? {} : readJsonFile<GapCache>(GAPS_CACHE_PATH, {});
  const client = anthropicClient(opts.guard);
  const events: PlanEvent[] = [];
  for await (const e of planStream({
    tracks: () => planTracks(client, input, ctx.entities, ctx.event, fcache, ctx.aliases),
    repo: input.repo ? () => checkoutRepoAsync(input.repo!) : null,
    repoLines: (repo, tracks) => repoFacts(repo, tracks.filter((t) => t.fit === "likely").flatMap((t) => t.product_names)),
    gaps: (tracks, lines) => planGaps(client, tracks, ctx.entities, input, lines, gcache),
    booths: (tracks, gaps) => boothBlocks(boothQuestions(tracks, input, gaps)),
    joins: planJoins(input, ctx, opts.nowMs ?? Date.now()),
    log: (l) => console.error(l),
  })) {
    if ("error" in e) console.error(`plan: ${e.section}: ${e.error}`);
    events.push(e);
    on(e);
  }
  const of = (section: string) => events.find((e) => e.section === section && !("error" in e)) as Extract<PlanEvent, { from: string }> | undefined;
  // The SMS alerts read the last Plan for "why it matters" (watch.ts): idea, stack and ranked tracks only.
  const ranked = events.find((e) => e.section === "tracks" && !("error" in e)) as Extract<PlanEvent, { section: "tracks"; tracks: unknown }> | undefined;
  if (ranked)
    writeJsonFile(PLAN_PATH, {
      saved_at: new Date().toISOString(),
      input: { idea: input.idea, stack: input.stack },
      tracks: ranked.tracks.map((t) => ({ track_id: t.track_id, name: t.name, sponsor: t.sponsor, fit: t.fit, product_names: t.product_names })),
    });
  if (!opts.fresh) {
    if (of("tracks")?.from === "model") writeJsonFile(FIT_CACHE_PATH, fcache);
    if (of("gaps")?.from === "model") writeJsonFile(GAPS_CACHE_PATH, gcache);
  }
  const done = events.at(-1) as Extract<PlanEvent, { section: "done" }>;
  const timing = {
    at: new Date().toISOString(),
    via: opts.via,
    ...(opts.fresh ? { fresh: true } : {}),
    first: done.first,
    total_ms: done.ms,
    sections: Object.fromEntries(events.filter((e) => e.section !== "done").map((e) => [e.section, "error" in e ? { ms: e.ms, error: true } : { ms: e.ms, ...("from" in e ? { from: e.from } : {}) }])),
    repo: !!input.repo,
  };
  mkdirSync(dirname(PLAN_TIMINGS_PATH), { recursive: true });
  appendFileSync(PLAN_TIMINGS_PATH, JSON.stringify(timing) + "\n");
  console.log(`plan: first section ${done.first ? `(${done.first.section}) in ${done.first.ms} ms` : "never"}; all in ${done.ms} ms (${Object.entries(timing.sections).map(([k, v]) => `${k} ${"from" in v ? v.from : "error" in v ? "error" : ""}`.trim()).join(", ")})`);
  return events;
}

async function planCli(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { idea: { type: "string" }, stack: { type: "string" }, from: { type: "string" }, repo: { type: "string" }, fresh: { type: "boolean" }, at: { type: "string" }, yes: { type: "boolean", default: false } } });
  // A fixture's stack is the CLI string or a list of {name, used_for} (a used-for may hold commas).
  const dog = values.from ? readJsonFile<{ idea: string; stack: string | StackItem[]; targeted?: string[]; repo?: string } | null>(values.from, null) : null;
  if (values.from && !dog) {
    console.error(`${values.from} not found`);
    return 2;
  }
  const idea = dog?.idea ?? values.idea;
  if (!idea) {
    console.error("--idea or --from is required");
    return 2;
  }
  const input: PlanInput = { idea, stack: values.stack !== undefined || typeof dog?.stack !== "object" ? parseStack(values.stack ?? (dog?.stack as string | undefined)) : dog.stack.length ? dog.stack : null };
  const repoUrl = values.repo ?? dog?.repo;
  if (repoUrl) input.repo = repoUrl;
  // The board's stream (P2), run in-process: the same steps, caches and timing line.
  const ctx: PlanContext = { entities: readJsonFile<CanonPage[]>(CANON_PATH, []).flatMap((p) => p.entities), event: readEvent(), aliases: sponsorAliases(readJsonFile<Sponsors>(SPONSORS_PATH, {})) };
  const nowMs = values.at ? Date.parse(values.at) : Date.now();
  if (Number.isNaN(nowMs)) {
    console.error(`--at ${values.at}: not a date (use ISO 8601 with an offset)`);
    return 2;
  }
  const events = await runPlanStream(input, ctx, { via: "cli", fresh: values.fresh, nowMs, guard: new CostGuard("plan", values.yes!) }, () => {});
  const tr = events.find((e) => e.section === "tracks");
  const ge = events.find((e) => e.section === "gaps");
  if (!tr || "error" in tr || tr.section !== "tracks") {
    console.error("couldn't rank tracks (see above)");
    return 1;
  }
  if (!ge || "error" in ge || ge.section !== "gaps") {
    console.error("couldn't check requirements (see above)");
    return 1;
  }
  const r = { items: tr.tracks, from: tr.from, ms: tr.ms, usage: tr.usage };
  const g = { gaps: ge.gaps, checked: ge.checked, facts: ge.facts, from: ge.from, ms: ge.ms, usage: ge.usage };
  const repoNote = ge.repo ? `repo ${ge.repo.url} @ ${ge.repo.commit.slice(0, 7)}: ${ge.facts.repo} lines naming the likely tracks' products` : "";

  // Every line is wrapped at spaces here, so the terminal never soft-wraps one (a soft wrap can lose the space).
  const width = cliWidth();
  const out = (line: string) => console.log(wrapText(line, width));
  out(`Tracks to target (${r.from}, ready at ${r.ms} ms${r.usage ? `; ${formatUsage(1, r.usage, FIT_MODEL)}` : ""})`);
  out(`Gaps (${g.from}, ready at ${g.ms} ms${g.usage ? `; ${formatUsage(1, g.usage, FIT_MODEL)}` : ""}): ${g.checked} stated requirements and entry steps on likely tracks, against ${g.facts.description} description sentences, ${g.facts.stack} stack lines and ${g.facts.repo} repo lines${repoNote ? ` (${repoNote})` : ""}`);
  let shown = "";
  for (const t of r.items) {
    if (t.fit === "possible" && shown !== "possible") out("\n  Also possible");
    shown = t.fit;
    out(`\n  ${t.name}   ${t.fit === "likely" ? "likely fits" : "possible"}${t.capped ? " (ranked likely; the title's product isn't in your description or stack)" : ""}${t.label ? `   (${t.label})` : ""}`);
    out(`    ${t.reason}`);
    out(`    "${t.quote}"  ${t.source_url}`);
    for (const s of t.steps) out(`    [ ] ${s.label} (${s.step_kind}): "${s.quote}"`);
    for (const x of g.gaps.filter((x) => x.track_id === t.track_id)) {
      out(`    Gap: ${x.gap}`);
      out(`      page (${x.requirement.kind === "entry_step" ? "entry step" : "requirement"}): "${x.requirement.quote}"  ${x.requirement.source_url}`);
      for (const p of x.project) out(`      ${p.source}: "${p.quote}"${p.url ? `  ${p.url}` : ""}`);
    }
    if (t.fit === "likely" && t.evidence === "stated" && !g.gaps.some((x) => x.track_id === t.track_id)) out(`    Gaps: none found. That says nothing about whether the requirements are met.`);
  }
  // P3–P5, as of --at (or now).
  const at = (iso: string | number) => new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleString("en-US", { timeZone: ctx.event.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const sec = <K extends "credits" | "sessions" | "people">(k: K) => events.find((e) => e.section === k) as Extract<PlanEvent, { section: K }> | undefined;
  out(`\nAs of ${at(nowMs / 1000)}${values.at ? " (--at)" : ""}`);
  const cr = sec("credits");
  if (cr && !("error" in cr)) {
    out(`\nCredits (${cr.credits.length}${cr.dropped ? `; ${cr.dropped} dropped: quote not found in its posts` : ""}), joined on: ${cr.sponsors.map((x) => `${x.sponsor} (${x.why.join("; ")})`).join(", ") || "no sponsor"}`);
    if (!cr.credits.length) out("  No offer posted so far matches your stack");
    for (const c of cr.credits) {
      out(`  ${c.sponsor}: ${c.value}   ${c.limit ? `closes ${at(c.limit)}` : c.limit_unclear ? "limit unclear" : "no stated limit"}${c.claim ? ` · ${c.claim}` : ""}${c.promo_code ? ` · code ${c.promo_code}` : ""}`);
      out(`    "${c.quote}"  ${c.source_url}`);
    }
  } else out(`\nCredits: failed`);
  const se = sec("sessions");
  if (se && !("error" in se)) {
    out(`\nSessions (${se.sessions.length}), before ${se.deadline ? `${se.deadline.name}, ${at(se.deadline.at)}` : "no known submission deadline"}`);
    if (!se.sessions.length) out("  No upcoming session from these sponsors before the submission deadline");
    for (const x of se.sessions) out(`  ${at(x.start)} · ${x.sponsor}: "${x.quote}"  ${x.source_url}`);
  } else out(`\nSessions: failed`);
  const blocks = boothBlocks(boothQuestions(r.items, input, g.gaps));
  const pe = sec("people");
  const people = pe && !("error" in pe) ? pe.people : [];
  out("\nBooths and reps: one block per sponsor, the reps (People) under its questions");
  for (const sponsor of [...new Set([...blocks.map((b) => b.sponsor), ...people.map((p) => p.sponsor)])]) {
    const b = blocks.find((x) => x.sponsor === sponsor);
    out(`  ${sponsor}${b ? `: ${b.text}` : ""}`);
    for (const q of b?.questions ?? []) out(`    ${q.grounds}  ${q.source_url}`);
    const p = people.find((x) => x.sponsor === sponsor);
    if (p && !p.reps.length) out("    Reps: no rep of a targeted track has posted yet");
    for (const rep of p?.reps ?? []) out(`    ${rep.likely ? "Likely staff" : "Rep"}: ${rep.name}${rep.accounts > 1 ? ` (${rep.accounts} accounts)` : ""}, ${rep.posts} post${rep.posts === 1 ? "" : "s"}, first ${at(rep.first)}: "${rep.quote}"  ${rep.source_url}\n      matched: ${rep.signals.join("; ")}`);
  }
  if (pe && "error" in pe) out("  People: failed");
  if (dog?.targeted?.length) {
    const hit = dog.targeted.filter((s) => r.items.some((t) => `${t.sponsor} ${t.name}`.toLowerCase().includes(s.toLowerCase().split(" ")[0]!)));
    out(`\nthe user targeted ${dog.targeted.join(", ")}; ${hit.length} of ${dog.targeted.length} appear above${hit.length < dog.targeted.length ? ` (missing: ${dog.targeted.filter((s) => !hit.includes(s)).join(", ")})` : ""}. Targeted, not won: no track prizes, so this isn't a win label.`);
  }
  return 0;
}

/** "Best Actor, claude for public" → track ids: each part is an id or a unique case-insensitive part of a name. */
function matchTracks(entities: Entity[], parts: string[]): { ids: string[] } | { error: string } {
  const tracks = entities.filter((x) => x.kind === "track");
  const ids: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    const hits = tracks.filter((t) => t.id === part || (t.name.value ?? "").toLowerCase().includes(part.toLowerCase()));
    if (hits.length !== 1) return { error: `"${part}" matches ${hits.length ? hits.map((t) => t.name.value).join(", ") : "no track"}; give more of the name` };
    ids.push(hits[0]!.id);
  }
  return { ids };
}

/** Ship's checklist (shiplist.ts) for the entered tracks, as of `nowMs`: the capture's posts by then, rendered as the
 *  board renders them. */
/** Each canon page's first snapshot (the baseline) and every later field change with its window (merge §3). With
 *  no replaced records, the baseline is today's canon and there are no changes. */
function canonTimeline(): { baseline: Entity[]; changes: PageChange[] } {
  const byPage = new Map<string, CanonPage[]>();
  for (const p of [...readJsonFile<CanonPage[]>(CANON_HISTORY_PATH, []), ...readJsonFile<CanonPage[]>(CANON_PATH, [])]) byPage.set(pageKey(p.url), [...(byPage.get(pageKey(p.url)) ?? []), p]);
  const baseline: Entity[] = [], changes: PageChange[] = [];
  for (const recs of byPage.values()) {
    baseline.push(...recs[0]!.entities);
    for (let k = 1; k < recs.length; k++) changes.push(...mergePageChanges(recs[k - 1]!, recs[k]!));
  }
  return { baseline, changes };
}

function shipListAt(entities: Entity[], event: EventConfig, entered: string[], nowMs: number): ShipList {
  const sponsors = readSponsors(SPONSORS_PATH);
  const messages = readMessages();
  const person = loadPersonKey();
  const role = rolesById(messages, sponsors, loadOrganizerIds(), person, loadRepIndex(person).confirmed);
  // Merge §3: each page's first snapshot plus later edits, when canon has replaced a page; else today's canon.
  const t = canonTimeline();
  return shipList({ entities: t.changes.length ? t.baseline : entities, pageChanges: t.changes, event, messages, isOrganizer: (m) => role(m) === "organizer", shown: (m) => plainText(m.text), entered, nowSec: nowMs / 1000 });
}

async function shipCli(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { from: { type: "string" }, enter: { type: "string" }, repo: { type: "string" }, at: { type: "string" }, yes: { type: "boolean", default: false } } });
  const dog = values.from ? readJsonFile<{ idea: string; stack: string | StackItem[]; repo?: string; entered?: string[] } | null>(values.from, null) : null;
  if (!dog) {
    console.error(values.from ? `${values.from} not found` : "--from is required");
    return 2;
  }
  const nowMs = values.at ? Date.parse(values.at) : Date.now();
  if (Number.isNaN(nowMs)) {
    console.error(`--at: not a date: ${values.at}`);
    return 2;
  }
  const repo = values.repo ?? dog.repo;
  const entities = readJsonFile<CanonPage[]>(CANON_PATH, []).flatMap((p) => p.entities);
  const m = matchTracks(entities, values.enter !== undefined ? values.enter.split(",") : (dog.entered ?? []));
  if ("error" in m) {
    console.error(`--enter: ${m.error}`);
    return 2;
  }
  if (!m.ids.length) {
    console.error('--enter is required (or "entered" in the fixture): the tracks you plan to enter, e.g. --enter "Best Actor, Claude for Public Benefit"');
    return 2;
  }
  const event = readEvent();
  const at = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: event.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const out = (line: string) => console.log(wrapText(line, cliWidth()));
  const list = shipListAt(entities, event, m.ids, nowMs);
  const left = list.deadline ? Date.parse(list.deadline.at) - nowMs : null;
  out(`Ship at ${at(new Date(nowMs).toISOString())}: ${m.ids.length} tracks you plan to enter`);
  if (list.deadline) {
    const d = list.deadline;
    out(`${left! > 0 ? "Submissions close" : "Submissions closed"} ${at(d.at)}${left! > 0 ? ` · in ${durationText(left!)}` : ""}${d.was ? ` · Devpost said ${at(d.was.at)}` : ""}`);
    out(`  "${d.quote}"  ${d.from === "slack" ? `#${d.channel} ` : ""}${d.source_url}`);
    if (d.was) out(`  Devpost: "${d.was.quote}"  ${d.was.source_url}`);
  } else out("No submission deadline found on the pages or in the posts read.");
  const lastHour = left !== null && left > 0 && left < 3_600_000;
  if (lastHour) out("Last hour: Ship shows the countdown and the unticked Required items; the other groups fold to one line each.");

  if (repo) {
    const { tracks } = shipTracks(entities, m.ids, event, sponsorAliases(readJsonFile<Sponsors>(SPONSORS_PATH, {})));
    const input = { idea: dog.idea, stack: typeof dog.stack === "string" ? parseStack(dog.stack) : dog.stack.length ? dog.stack : null, repo };
    const gcache = readJsonFile<GapCache>(GAPS_CACHE_PATH, {});
    const store = readJsonFile<ShipGapStore>(SHIP_GAPS_PATH, {});
    const r = await recheckGaps(anthropicClient(new CostGuard("ship", values.yes!)), input, tracks, entities, gcache, store);
    if ("error" in r) {
      console.error(`couldn't recheck gaps: ${r.error}`);
      return 1;
    }
    writeJsonFile(GAPS_CACHE_PATH, gcache);
    writeJsonFile(SHIP_GAPS_PATH, store);
    out(`\nRecheck gaps: ${r.repo} @ ${r.commit.slice(0, 7)}, the latest commit as of ${at(r.latest_at)}. ${r.from === "reused" ? `Checked ${at(r.checked_at)}; the commit hasn't changed since, so that result stands.` : `Checked ${at(r.checked_at)}.`} ${r.checked} stated requirements and entry steps, ${r.repo_lines} repo lines.`);
    out(r.gaps.length ? `Open gaps (${r.gaps.length})` : !r.checked ? "Open gaps: nothing to check. None of these tracks states a requirement or entry step on the pages read." : "Open gaps: none found. That says nothing about whether the requirements are met.");
    for (const g of r.gaps) {
      out(`  ${g.track}\n    ${g.gap}`);
      out(`      page (${g.requirement.kind === "entry_step" ? "entry step" : "requirement"}): "${g.requirement.quote}"  ${g.requirement.source_url}`);
      for (const p of g.project) out(`      ${p.source}: "${p.quote}"${p.url ? `  ${p.url}` : ""}`);
    }
  }

  const item = (x: ShipItem) => {
    out(`    [ ] ${x.label}${x.at ? `   (${at(x.at)}${x.until ? `–${new Date(x.until).toLocaleString("en-US", { timeZone: event.timezone, hour: "numeric", minute: "2-digit" })}` : ""})` : ""}`);
    if (x.quote) out(`        "${x.quote}"`);
    out(`        ${x.from === "standing" ? "HackRecon's standing item" : x.from === "slack" ? `added in #${x.channel}  ${x.source_url}` : x.source_url}`);
  };
  out(`\nRequired to submit (${list.required.length})`);
  list.required.forEach(item);
  const tracksN = list.tracks.reduce((n, t) => n + t.items.length, 0);
  out(`\nFor the tracks you entered (${tracksN})${lastHour ? "   folded in the last hour" : ""}`);
  for (const t of list.tracks) {
    out(`  ${t.name}${t.items.length ? "" : "   (no requirements or entry steps stated)"}`);
    t.items.forEach(item);
  }
  out(`\nJudging (${list.judging.length})${lastHour ? "   folded in the last hour" : ""}`);
  list.judging.forEach(item);
  return 0;
}

const readProducts = () => readJsonFile<{ products: Product[] }>(PRODUCTS_PATH, { products: [] }).products;

function printDraft(d: PrefillDraft, out: (line: string) => void) {
  const src = (s: PrefillDraft["description"]["sources"]) => s.map((x) => `      ${x.source}: "${x.quote}"${x.url ? `  ${x.url}` : ""}`);
  out(`Description (draft)\n  ${d.description.text}`);
  for (const l of src(d.description.sources)) out(l);
  out(`\nStack (drafts; confirm each before it's saved)`);
  for (const it of d.stack) {
    out(`  ${it.name}${it.used_for ? `: ${it.used_for}` : "   (no used-for: no README or code line says what it does)"}${it.origin === "sponsor_pass" ? "   [sponsor product found in the code]" : ""}`);
    for (const l of src(it.sources)) out(l);
  }
}

async function prefillCli(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { repo: { type: "string" }, yes: { type: "boolean", default: false } } });
  if (!values.repo) {
    console.error("--repo https://github.com/<owner>/<repo> is required");
    return 2;
  }
  const repo = checkoutRepo(values.repo);
  if ("error" in repo) {
    console.error(repo.error);
    return 1;
  }
  const cache = readJsonFile<PrefillCache>(PREFILL_CACHE_PATH, {});
  const t0 = Date.now();
  const r = await prefillDraft(anthropicClient(new CostGuard("prefill", values.yes!)), repo, repoTexts(repo), cache, readProducts());
  if ("error" in r) {
    console.error(`couldn't draft: ${r.error}`);
    return 1;
  }
  writeJsonFile(PREFILL_CACHE_PATH, cache);
  const out = (line: string) => console.log(wrapText(line, cliWidth()));
  out(`Prefill from ${repo.url} @ ${repo.sha.slice(0, 7)} (${r.from}, ${Date.now() - t0} ms; ${r.facts} repo lines${r.usage ? `; ${formatUsage(1, r.usage, FIT_MODEL)}` : ""})\n`);
  printDraft(r.draft, out);
  return 0;
}

async function prefillEval(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean", default: false }, limit: { type: "string" }, concurrency: { type: "string", default: "4" }, yes: { type: "boolean", default: false } } });
  const set = readJsonFile<{ items: EvalItem[] } | null>(FIT_EVAL_SET_PATH, null);
  const repos = readJsonFile<Record<string, string>>(PREFILL_REPOS_PATH, {});
  const baseline = readJsonFile<{ canon: string; pair_hits: PairHit[] } | null>(FIT_BASELINE_PATH, null);
  if (!set || !baseline) {
    console.error(`needs ${FIT_EVAL_SET_PATH} and ${FIT_BASELINE_PATH}`);
    return 2;
  }
  let items = set.items.filter((it) => repos[it.slug]);
  if (values.limit) items = items.slice(0, Number(values.limit));
  const products = readProducts();
  // C: the model's draft alone. C+: with the sponsor-product pass (user 2026-11-06).
  const stackOf = (d: PrefillDraft, run: "C" | "C+") => d.stack.filter((s) => run === "C+" || s.origin !== "sponsor_pass").map((s) => s.name);
  const event = readEvent();
  const entities = readJsonFile<CanonPage[]>(baseline.canon, []).flatMap((p) => p.entities);
  const cards = trackCards(entities, event, sponsorAliases(readJsonFile<Sponsors>(SPONSORS_PATH, {})));
  const system = fitSystemPrompt(event, cards);
  const pcache = readJsonFile<PrefillCache>(PREFILL_CACHE_PATH, {});
  const fcache = readJsonFile<Record<string, FitCached>>(FIT_CACHE_PATH, {});
  console.log(`${items.length} of ${set.items.length} winners link a GitHub repo (${PREFILL_REPOS_PATH}); canon ${baseline.canon}, ${cards.length} sponsor tracks`);
  // Clone (or reuse) and read every repo first: free, and it tells the dry run how big each request is.
  const prepared: { it: EvalItem; repo: Exclude<ReturnType<typeof checkoutRepo>, { error: string }>; texts: Map<string, string> }[] = [];
  const unreadable: string[] = [];
  for (const it of items) {
    const repo = checkoutRepo(repos[it.slug]!);
    if ("error" in repo) unreadable.push(`${it.slug}: ${repo.error}`);
    else prepared.push({ it, repo, texts: repoTexts(repo) });
  }
  for (const u of unreadable) console.log(`  unreadable: ${u}`);
  const sizes = prepared.map((p) => prefillRequest(prefillFacts(p.repo, p.texts)).length);
  const cachedDrafts = prepared.filter((p) => pcache[prefillHashOf(p)]).length;
  console.log(`${prepared.length} repos read; prefill request ${Math.min(...sizes)}–${Math.max(...sizes)} chars (mean ${Math.round(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length))}); ${cachedDrafts} drafts cached`);
  {
    let fitTodo = 0;
    let added = 0;
    for (const p of prepared) {
      const r = await prefillDraft(null, p.repo, p.texts, pcache, products);
      if ("error" in r) continue;
      added += r.added.length;
      for (const run of ["C", "C+"] as const) if (!fcache[fitHash(system, fitRequest(p.it.description, stackOf(r.draft, run)))]) fitTodo++;
    }
    console.log(`sponsor-product pass: ${added} products added across the cached drafts; ${fitTodo} fit rankings not cached`);
  }
  if (values["dry-run"]) {
    console.log("dry run: no API call");
    return 0;
  }
  const guard = new CostGuard("prefill-eval", values.yes!);
  const draftCalls = prepared.filter((p) => !pcache[prefillHashOf(p)]).map((p) => plannedCall(FIT_MODEL, PREFILL_SYSTEM, prefillRequest(prefillFacts(p.repo, p.texts)), PREFILL_SCHEMA, PREFILL_MAX_TOKENS));
  if (!guard.preflight(draftCalls)) return 2;
  console.log("prefill-eval: fit rankings for new drafts are estimated as they run, and stop at the same limit");
  const client = anthropicClient(guard);
  if (!client) return 2;
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let calls = 0;
  const failed: string[] = [];
  const drafts = new Map<string, PrefillDraft>();
  let next = 0;
  const worker = async () => {
    while (next < prepared.length) {
      const p = prepared[next++]!;
      const r = await prefillDraft(client, p.repo, p.texts, pcache, products);
      if ("error" in r) {
        failed.push(`prefill ${p.it.slug}: ${r.error}`);
        continue;
      }
      if (r.usage) {
        usage = sumUsage([usage, r.usage]);
        calls++;
      }
      drafts.set(p.it.slug, r.draft);
      for (const stack of new Set([JSON.stringify(stackOf(r.draft, "C")), JSON.stringify(stackOf(r.draft, "C+"))])) {
      const request = fitRequest(p.it.description, JSON.parse(stack));
      const hash = fitHash(system, request);
      if (!fcache[hash]) {
        const f = await callChecked(client, { model: FIT_MODEL, effort: FIT_EFFORT, max_tokens: FIT_MAX_TOKENS, system, schema: FIT_SCHEMA, request, check: (x) => checkFit(x, cards) });
        usage = sumUsage([usage, f.usage]);
        calls += f.calls;
        if ("error" in f) failed.push(`fit ${p.it.slug}: ${f.error}`);
        else fcache[hash] = { ranked: f.value, usage: f.usage, calls: f.calls };
      }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  writeJsonFile(PREFILL_CACHE_PATH, pcache);
  writeJsonFile(FIT_CACHE_PATH, fcache);
  console.log(formatUsage(calls, usage, FIT_MODEL));
  for (const f of failed) console.error(`failed: ${f}`);
  // (a) Built With recall, for the model's draft alone (C) and with the sponsor-product pass (C+)
  const done = prepared.filter((p) => drafts.has(p.it.slug));
  const bwOf = (run: "C" | "C+") => done.map((p) => scoreBuiltWith(p.it.slug, p.it.built_with ?? [], stackOf(drafts.get(p.it.slug)!, run), products));
  const scores = { C: bwOf("C"), "C+": bwOf("C+") };
  const added = Object.fromEntries(done.map((p) => [p.it.slug, drafts.get(p.it.slug)!.stack.filter((x) => x.origin === "sponsor_pass").map((x) => ({ name: x.name, sources: x.sources }))]).filter(([, a]) => (a as unknown[]).length));
  const bw = { C: builtWithReport(scores.C), "C+": builtWithReport(scores["C+"]) };
  console.log(`\n(a) Built With recall, ${bw.C.projects} projects with a Built With list, ${bw.C.tags} tags. Sponsor-product pass: ${Object.values(added).flat().length} products added to ${Object.keys(added).length} projects.`);
  for (const run of ["C", "C+"] as const) {
    const r = bw[run];
    console.log(`  ${run === "C" ? "model draft (C)        " : "with sponsor pass (C+) "}strict ${fmt(r.strict)}, loose ${fmt(r.loose)}, loose + alias table ${fmt(r.aliased)}`);
  }
  // (b) Fit with each drafted stack in place of Built With, paired with the baseline's run B on the same pairs
  const byName = new Map(cards.map((c) => [c.name, c]));
  const hitsOf = (run: "C" | "C+") => {
    const m = new Map<string, { C3: boolean; C5: boolean }>();
    for (const p of prepared) {
      const d = drafts.get(p.it.slug);
      const ranked = d ? fcache[fitHash(system, fitRequest(p.it.description, stackOf(d, run)))]?.ranked : undefined;
      for (const prize of p.it.won) {
        const card = byName.get(prize);
        if (!card) continue;
        const ids = (ranked ?? []).map((r) => r.track_id);
        m.set(`${p.it.slug}|${prize}`, { C3: ids.slice(0, 3).includes(card.id), C5: ids.slice(0, FIT_TOP).includes(card.id) });
      }
    }
    return m;
  };
  const fit = { C: pairedVsBaseline(baseline.pair_hits, hitsOf("C")), "C+": pairedVsBaseline(baseline.pair_hits, hitsOf("C+")) };
  console.log(`\n(b) Fit with the drafted stack in place of Built With, ${fit.C.pairs} won sponsor-track pairs of ${baseline.pair_hits.length} (projects with a readable repo), paired with the baseline's run B on the same pairs (95% CI: Agresti–Min paired):`);
  for (const run of ["C", "C+"] as const) for (const r of fit[run].paired) console.log(`  ${formatPaired(r, run)}`);
  console.log(`  whole baseline for reference: B recall@3 ${fmt({ hits: baseline.pair_hits.filter((p) => p.B3).length, n: baseline.pair_hits.length })}, recall@5 ${fmt({ hits: baseline.pair_hits.filter((p) => p.B5).length, n: baseline.pair_hits.length })}`);
  if (fit.C.not_in_baseline.length) console.log(`  not in the baseline (skipped): ${fit.C.not_in_baseline.join(", ")}`);
  writeJsonFile(PREFILL_EVAL_PATH, { built_with: bw, scores, added, fit, failed, unreadable, usage, calls, model: FIT_MODEL, written_at: new Date().toISOString(), limit: values.limit ?? null });
  console.log(`\nwrote ${PREFILL_EVAL_PATH}`);
  return failed.length ? 1 : 0;

  function prefillHashOf(p: (typeof prepared)[number]) {
    return prefillHash(prefillRequest(prefillFacts(p.repo, p.texts)));
  }
}

async function fitEval(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { fixtures: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, limit: { type: "string" }, concurrency: { type: "string", default: "6" }, "set-baseline": { type: "boolean", default: false }, yes: { type: "boolean", default: false } },
  });
  const event = readEvent();
  const canonPath = values.fixtures ? CANON_FIXTURES_PATH : CANON_PATH;
  const pages = readJsonFile<CanonPage[]>(canonPath, []);
  const entities = pages.flatMap((p) => p.entities);
  if (!entities.some((e) => e.kind === "track")) {
    console.error(`no tracks in ${canonPath}: run \`bun run hr canon${values.fixtures ? " --fixtures" : ""}\` first`);
    return 2;
  }
  const set = readJsonFile<{ items: EvalItem[] } | null>(FIT_EVAL_SET_PATH, null);
  if (!set) {
    console.error(`no eval set at ${FIT_EVAL_SET_PATH}`);
    return 2;
  }
  const cards = trackCards(entities, event, sponsorAliases(readJsonFile<Sponsors>(SPONSORS_PATH, {})));
  const system = fitSystemPrompt(event, cards);
  const names = new Set(entities.filter((e) => e.kind === "track").map((e) => e.name.value ?? ""));
  let items = set.items.filter((it) => it.won.some((w) => cards.some((c) => c.name === w)));
  if (values.limit) items = items.slice(0, Number(values.limit));
  const jobs = items.flatMap((it) =>
    (["A", "B"] as const).map((run) => {
      const request = fitRequest(it.description, run === "B" ? it.built_with : null);
      return { it, run, request, hash: fitHash(system, request) };
    }),
  );
  const cache = readJsonFile<Record<string, FitCached>>(FIT_CACHE_PATH, {});
  const todo = jobs.filter((j) => !cache[j.hash]);
  console.log(`${items.length} projects with a won sponsor track, ${cards.length} sponsor tracks from ${canonPath}; model ${FIT_MODEL}, effort ${FIT_EFFORT}; system ${system.length} chars; ${jobs.length} rankings, ${todo.length} not cached`);
  if (values["dry-run"]) {
    console.log(`\n--- system prompt (first 3000 chars) ---\n${system.slice(0, 3000)}\n--- request, run B, first project ---\n${jobs[1]?.request}\n\ndry run: no API call`);
    return 0;
  }
  let client: Anthropic | null = null;
  if (todo.length) {
    const guard = new CostGuard("fit-eval", values.yes!);
    if (!guard.preflight(todo.map((j) => plannedCall(FIT_MODEL, system, j.request, FIT_SCHEMA, FIT_MAX_TOKENS)))) return 2;
    client = anthropicClient(guard);
    if (!client) return 2;
  }
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let calls = 0;
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const j = todo[next++]!;
      const r = await callChecked(client!, { model: FIT_MODEL, effort: FIT_EFFORT, max_tokens: FIT_MAX_TOKENS, system, schema: FIT_SCHEMA, request: j.request, check: (p) => checkFit(p, cards) });
      usage = sumUsage([usage, r.usage]);
      calls += r.calls;
      if ("error" in r) failed.push(`${j.run} ${j.it.slug}: ${r.error}`);
      else cache[j.hash] = { ranked: r.value, usage: r.usage, calls: r.calls };
      if ((Object.keys(cache).length + failed.length) % 20 === 0) writeJsonFile(FIT_CACHE_PATH, cache);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  if (todo.length) {
    writeJsonFile(FIT_CACHE_PATH, cache);
    console.log(formatUsage(calls, usage, FIT_MODEL));
  }
  for (const f of failed) console.error(`failed: ${f}`);
  const runMap = (run: "A" | "B") => new Map(jobs.filter((j) => j.run === run && cache[j.hash]).map((j) => [j.it.slug, cache[j.hash]!.ranked]));
  // Score over the whole set: projects that won only event-level prizes add no pairs but are listed (D23).
  const report = scoreFit(values.limit ? items : set.items, cards, names, event, runMap("A"), runMap("B"));
  console.log(`\n${formatFitReport(report)}`);
  writeJsonFile(FIT_EVAL_PATH, { ...report, model: FIT_MODEL, effort: FIT_EFFORT, canon: canonPath, written_at: new Date().toISOString() });
  console.log(`\nwrote ${FIT_EVAL_PATH}`);
  if (values.limit) {
    console.log("\nfit gate: not applied to a --limit run (it needs the whole pair set)");
    return failed.length ? 1 : 0;
  }
  if (values["set-baseline"]) {
    if (failed.length) {
      console.error("not setting a baseline from a run with failed rankings");
      return 1;
    }
    writeJsonFile(FIT_BASELINE_PATH, { canon: canonPath, model: FIT_MODEL, effort: FIT_EFFORT, written_at: new Date().toISOString(), pair_hits: report.pair_hits });
    console.log(`wrote ${FIT_BASELINE_PATH} (${report.pair_hits.length} pairs): later runs are gated against it`);
    return 0;
  }
  const base = readJsonFile<{ canon: string; written_at: string; pair_hits: PairHit[] } | null>(FIT_BASELINE_PATH, null);
  if (!base) {
    console.log(`\nfit gate: no baseline at ${FIT_BASELINE_PATH}; set it with \`bun run hr fit-eval --fixtures --set-baseline\``);
    return failed.length ? 1 : 0;
  }
  const gate = fitGate(report.pair_hits, base.pair_hits);
  console.log(`\n${formatFitGate(gate, `${base.canon}, ${base.written_at.slice(0, 10)}`)}`);
  return failed.length || !gate.passes ? 1 : 0;
}

function receiptPreview(args: string[]): number {
  const { values } = parseArgs({ args, options: { sponsors: { type: "string", default: SPONSORS_PATH } } });
  const run = readJsonFile<ClassifyRun | null>(RUN_PATH, null);
  if (!run) {
    console.error(`${RUN_PATH} not found: run \`bun run hr classify\` first`);
    return 2;
  }
  const sponsors = readSponsors(values.sponsors!);
  const messages = readMessages();
  const last = readRuns().at(-1);
  const organizerIds = loadOrganizerIds();
  const person = loadPersonKey();
  const reps = loadRepIndex(person);
  const grouped = readJsonFile<GroupResult | null>(GROUP_PATH, null);
  const fresh = grouped && grouped.input_hash === groupInput(sponsors).input_hash;
  if (grouped && !fresh) console.log(`${GROUP_PATH} is stale (the credit labels, capture or prompt changed): using URL merge; rerun bun run hr group`);
  const labels = readLabels();
  const p = preview({
    ...(fresh ? { opus: withLabelAmounts(grouped.offers, new Map(labels.map((r) => [r.message_id, r]))) } : {}),
    items: readJsonFile<Item[]>(ITEMS_PATH, []),
    labels,
    messages,
    sponsors,
    channels: last?.channels ?? [],
    role: rolesById(messages, sponsors, organizerIds, person, reps.confirmed),
    person,
  });
  const current = promptHash(systemPrompt(readEvent(), readRules()));
  const stale = run.prompt_hash !== current ? " (STALE: config now gives a different prompt; rerun hr classify)" : "";
  const basis = fresh ? `Opus grouping ${grouped.input_hash} (${grouped.posts} credit posts)` : `classifier prompt ${run.prompt_hash}${stale}, ${run.classified.length} messages classified`;
  console.log(formatPreview(p, `${basis}, run ${last?.run_id ?? "none"}`));
  return 0;
}

async function personLinks(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { export: { type: "string", default: DEFAULT_EXPORT_DIR } } });
  const dir = fromCaller(values.export!);
  const usersFile = join(dir, "users.json");
  const users = loadExport(dir).users;
  const sponsors = readSponsors(SPONSORS_PATH);
  const messages = readMessages();
  // Roles from each account's own posts (no links yet); a link only merges accounts already on one sponsor's side.
  const role = rolesById(messages, sponsors, loadOrganizerIds());
  const sides = new Map<string, Set<string>>();
  for (const m of messages) {
    const s = sponsors[m.channel_name];
    if (!s || s.sponsor === "event" || !m.author_id || m.author_kind === "bot" || role(m) !== "sponsor-side") continue;
    sides.set(s.sponsor, (sides.get(s.sponsor) ?? new Set()).add(m.author_id));
  }
  type Raw = SnapshotUser;
  const evidence = new Map<string, AccountEvidence>();
  const avatars: PersonLinksFile["avatars"] = {};
  const account = async (id: string): Promise<AccountEvidence> => {
    if (evidence.has(id)) return evidence.get(id)!;
    const raw = (users.get(id) as Raw | undefined) ?? { id };
    const p = raw.profile ?? {};
    const e = profileEvidence(raw);
    // Default avatars are never fetched: they can't link anyone (people.ts linkEvidence).
    if (e.custom_image && p.image_192) {
      const h = await avatarHashes(p.image_192);
      if ("error" in h) console.error(`person-links: ${id}: avatar not hashed (${h.error})`);
      else (e.avatar = h), (avatars[id] = h);
    }
    evidence.set(id, e);
    return e;
  };
  const checked: PersonLinksFile["checked"] = [];
  const links: PersonLink[] = [];
  let closest: number | null = null;
  for (const [sponsor, ids] of [...sides].sort()) {
    if (ids.size < 2) continue;
    const list = [...ids].sort();
    checked.push({ scope: `sponsor-side for ${sponsor}`, accounts: list });
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [await account(list[i]!), await account(list[j]!)];
        const ev = linkEvidence(a, b);
        if (ev) links.push({ ids: [a.id, b.id], scope: `sponsor-side for ${sponsor}`, evidence: ev });
        else if (a.avatar && b.avatar) closest = Math.min(closest ?? 256, hammingHex(a.avatar.dhash, b.avatar.dhash));
      }
  }
  // The avatar threshold's margin: the closest pair of different people among every avatar hashed here.
  const hashed = Object.entries(avatars);
  let closestAny: number | null = null;
  const linkedPair = new Set(links.map((l) => l.ids.join("|")));
  for (let i = 0; i < hashed.length; i++)
    for (let j = i + 1; j < hashed.length; j++) {
      const ids = [hashed[i]![0], hashed[j]![0]].sort().join("|");
      if (!linkedPair.has(ids)) closestAny = Math.min(closestAny ?? 256, hammingHex(hashed[i]![1].dhash, hashed[j]![1].dhash));
    }
  const all = [...users.values()] as Raw[];
  const out: PersonLinksFile = {
    snapshot: { file: "users.json", sha256: createHash("sha256").update(readFileSync(usersFile)).digest("hex") },
    built_at: new Date().toISOString(),
    rule_notes: [
      `email: ${all.filter((u) => u.profile?.email).length} of ${all.length} accounts in this snapshot show one`,
      ...(all.some((u) => u.profile?.company) ? [] : ["profile: users.json has no company field, so real name + title + company can't hold"]),
      `avatar: identical bytes, or a 16x16 difference hash within ${AVATAR_MAX_BITS} of 256 bits; custom images only`,
    ],
    checked,
    avatars,
    links,
  };
  writeJsonFile(PERSON_LINKS_PATH, out);
  console.log(`wrote ${PERSON_LINKS_PATH}: ${links.length} link${links.length === 1 ? "" : "s"} among ${checked.reduce((n, c) => n + c.accounts.length, 0)} accounts on ${checked.length} sponsors' sides (${hashed.length} avatars hashed)`);
  for (const l of links) console.log(`  ${l.ids.join(" = ")}  ${l.scope}  ${JSON.stringify(l.evidence)}`);
  for (const n of out.rule_notes) console.log(`  rule note: ${n}`);
  console.log(`  closest unlinked avatars: ${closest ?? "none"} bits within a sponsor's side, ${closestAny ?? "none"} across all hashed (threshold ${AVATAR_MAX_BITS})`);
  return 0;
}

function organizers(args: string[]): number {
  const { values } = parseArgs({ args, options: { export: { type: "string", default: DEFAULT_EXPORT_DIR } } });
  const orgs = buildOrganizers(loadExport(fromCaller(values.export!)));
  writeJsonFile(ORGANIZERS_PATH, orgs);
  const by = (w: string) => orgs.filter((o) => o.why.includes(w)).length;
  console.log(
    `wrote ${ORGANIZERS_PATH}: ${orgs.length} organizer accounts (admin ${by("admin")}, owner ${by("owner")}, ` +
      `cal hacks tag ${by("cal hacks tag")}, title ${by("title")}; one account can match several)`,
  );
  return 0;
}

async function classify(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "labeled-only": { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      limit: { type: "string" },
      concurrency: { type: "string", default: "4" },
      show: { type: "string" },
      sponsors: { type: "string", default: SPONSORS_PATH },
    },
  });
  const sponsors = readSponsors(values.sponsors!);
  const order = Object.keys(sponsors);
  const messages = readMessages();
  const byId = new Map(messages.map((m) => [m.id, m]));
  let selected = [...messages].sort((a, b) => order.indexOf(a.channel_name) - order.indexOf(b.channel_name) || (a.ts < b.ts ? -1 : 1));
  if (values["labeled-only"]) {
    const rows = readLabels();
    if (!rows.length) {
      console.error(`${LABELS_PATH} not found or empty: run \`bun run hr pool\` first`);
      return 2;
    }
    const missing = rows.filter((r) => !byId.has(r.message_id)).length;
    selected = rows.flatMap((r) => byId.get(r.message_id) ?? []);
    console.log(`labeled set: ${rows.length} rows, ${selected.length} in the capture` + (missing ? `, ${missing} not captured (scored as capture misses, not classified)` : ""));
  }
  if (values.limit) selected = selected.slice(0, Number(values.limit));

  const system = systemPrompt(readEvent(), readRules());
  const hash = promptHash(system);
  // Inputs for every captured message: items.json covers all of them classified under this prompt.
  const allInputs = redactedInputs(messages, sponsors, hash);
  const inputById = new Map(allInputs.map((i) => [i.message.id, i]));
  const inputs = selected.map((m) => inputById.get(m.id)!);
  const cache = readJsonFile<Cache>(CACHE_PATH, {});
  const { todo, answer } = classifyPlan(inputs, cache, values.new!);
  const roles: Record<string, number> = {};
  for (const i of inputs) roles[i.role] = (roles[i.role] ?? 0) + 1;
  console.log(
    `${inputs.length} messages, ${inputs.length - todo.length} cached${values.new ? " (under any prompt)" : ""}, ${todo.length} to classify; model ${MODEL}, prompt ${hash}; ` +
      `poster_role ${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join(", ")}; ` +
      `${inputs.reduce((n, i) => n + i.redactions, 0)} redactions (${inputs.filter((i) => i.redactions).length} messages)`,
  );

  if (values["dry-run"]) {
    const sample = values.show ? inputs.find((i) => i.message.id === values.show) : (todo[0] ?? inputs[0]);
    if (sample) {
      console.log(`\n--- system prompt (${system.length} chars) ---\n${system}`);
      console.log(`\n--- request for ${sample.message.id} (${sample.message.permalink}) ---\n${sample.user}`);
    }
    console.log(`\nclassify: ${describeCalls(todo.map((i) => plannedCall(MODEL, system, i.user, OUTPUT_SCHEMA, MAX_TOKENS)))}`);
    console.log("dry run: no API call, nothing written");
    return 0;
  }

  const guard = new CostGuard("classify", values.yes!);
  if (!guard.preflight(todo.map((i) => plannedCall(MODEL, system, i.user, OUTPUT_SCHEMA, MAX_TOKENS)))) return 2;
  const client = anthropicClient(guard);
  if (!client) return 2;
  const errors: ClassifyError[] = [];
  const usages: Usage[] = [];
  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let i: ClassifyInput | undefined; (i = queue.shift()); ) {
      const r = await classifyOne(client, system, hash, i);
      usages.push(r.usage);
      if ("entry" in r) cache[i.key] = r.entry;
      else errors.push(r.error);
      if (++done % 20 === 0) writeJsonFile(CACHE_PATH, cache), console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  writeJsonFile(CACHE_PATH, cache);
  writeJsonFile(ERRORS_PATH, errors);

  // Every captured message cached under the current prompt and input, not only this run's selection; with --new, a
  // message with no answer under this prompt keeps its newest answer under an earlier one.
  // Counts only: what the classifier said is shown by `hr gate`, and only for labeled rows.
  const classified = allInputs.filter((i) => answer(i));
  const earlier = classified.filter((i) => !cache[i.key]).length;
  writeJsonFile(ITEMS_PATH, classified.flatMap((i) => toItems(answer(i)!, sponsors)));
  const run: ClassifyRun = {
    prompt_hash: hash,
    model: MODEL,
    written_at: new Date().toISOString(),
    classified: classified.map((i) => i.message.id),
    errors: errors.map((e) => e.message_id),
    usage: sumUsage(usages),
    cost_usd: Number(costUsd(sumUsage(usages), MODEL).toFixed(4)),
    ...(earlier ? { earlier_prompts: earlier } : {}),
  };
  writeJsonFile(RUN_PATH, run);
  console.log(
    `wrote ${ITEMS_PATH} and ${RUN_PATH}: ${classified.length} of ${messages.length} captured messages classified, ` +
      `${classified.length - earlier} under prompt ${hash}${earlier ? ` and ${earlier} under earlier prompts (--new)` : ""}; ` +
      `${errors.length} errors` + (errors.length ? ` (see ${ERRORS_PATH})` : ""),
  );
  for (const e of errors) console.log(`  error ${e.message_id}: ${e.reason}`);
  console.log(formatUsage(usages.length, run.usage!, MODEL));
  return errors.length ? 1 : 0;
}

/** Zero setup (user 2026-11-07): event.json, sponsors.json and organizers.json from the workspace and Devpost
 *  (autoconfig.ts). Each is written when missing, or when it is still exactly what discover last wrote; a file someone
 *  edited is never overwritten: its draft goes to data/discovery.json and the differences are printed. No model call:
 *  tracks, deadlines and the timezone come from canon, so a new event runs `hr canon` (estimated first) and then
 *  discover again. --against DIR compares the drafts with a hand-written config directory. */
async function discover(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { export: { type: "string" }, offline: { type: "boolean", default: false }, against: { type: "string" }, "workspace-name": { type: "string" } } });
  const caps = captureFiles([CAPTURES_DIR]).map((f) => loadCapture(f).capture);
  const messages = existsSync(MESSAGES_PATH) ? readMessages() : caps.flatMap((c) => c.messages);
  if (!messages.length) {
    console.error(`no captured posts in ${CAPTURES_DIR} or ${MESSAGES_PATH}: run "Sync this event" in the extension first`);
    return 2;
  }
  const sub = workspaceSubdomain(messages.map((m) => m.permalink));
  // The newest API pull (extension/src/apipull.ts) brings the workspace's display name and users.list's admin and
  // owner flags; without one, the subdomain's words search Devpost and flags come from --export.
  const pulls = existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).filter((d) => existsSync(join(CAPTURES_DIR, d, "pull", "users.json"))).sort() : [];
  const pullDir = pulls.length ? join(CAPTURES_DIR, pulls.at(-1)!, "pull") : null;
  const workspaceName = values["workspace-name"] ?? (pullDir ? readJsonFile<{ workspace?: { name?: string } }>(join(pullDir, "pull.json"), {}).workspace?.name : undefined) ?? null;
  const query = devpostQuery(workspaceName, sub);
  console.log(`workspace: ${sub ? `${sub}.slack.com` : "unknown"}; Devpost search: "${query ?? "nothing to search for"}"`);

  // The sidebar the extension saw on its newest sync (never its targets: those come from config), plus every captured
  // channel. Announcement channels, as hr sync decides them: Slack's restricted-posting flag, else names.
  const logs = existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).filter((d) => d.startsWith("sync-") && existsSync(join(CAPTURES_DIR, d, "sync.json"))).sort() : [];
  const pulled = pullDir ? readJsonFile<{ name: string }[]>(join(pullDir, "channels.json"), []) : [];
  const sidebar = pulled.length ? pulled : logs.length ? readJsonFile<{ sidebar?: { name: string }[] }>(join(CAPTURES_DIR, logs.at(-1)!, "sync.json"), {}).sidebar ?? [] : [];
  console.log(`channels: ${pulled.length ? `${pulled.length} from the API pull's conversations.list` : sidebar.length ? `${sidebar.length} from the sidebar in ${CAPTURES_DIR}/${logs.at(-1)}/sync.json` : "no sync log; captured channels only"}`);
  const channels = [...new Set([...sidebar.map((c) => c.name), ...caps.map((c) => c.channel_name), ...messages.map((m) => m.channel_name)])].sort();
  const flagged = [...new Set(caps.filter((c) => c.posting_restricted === true).map((c) => c.channel_name))];
  const announcement = new Set(flagged.length ? flagged : channels.filter((c) => /announce/i.test(c)));
  const authority = flagged.length ? null : { channels: [...announcement], source: `channels named *announce* (no capture carries Slack's restricted-posting flag)` };

  // Devpost: search by the workspace; an announcement link is the cross-check, and the fallback offline.
  const linked = discoverUrls(messages, announcement).devpost;
  let hit: DevpostHit | null = null;
  let why = "";
  if (!values.offline && query) {
    const r = await new PoliteFetcher().get(`https://devpost.com/api/hackathons?search=${encodeURIComponent(query)}`, "json");
    if (r.status === "fetched" && r.html) ({ hit, why } = pickDevpostHit(query, (JSON.parse(r.html) as { hackathons?: DevpostHit[] }).hackathons ?? []));
    else why = `Devpost search failed: ${r.detail}`;
  }
  const root = hit ? new URL(hit.url).origin + "/" : (linked?.url ?? null);
  if (!root) {
    console.error(`no Devpost page: ${why || "offline"}; and no Devpost link in ${[...announcement].join(", ") || "any announcement channel"}`);
    return 1;
  }
  if (hit && linked && pageKey(linked.url) !== pageKey(root)) console.log(`note: announcements link ${linked.url}, search found ${root}; using the search`);
  console.log(`devpost: ${root} (${hit ? why : `linked in announcements: ${linked!.why}`})`);
  const title = hit?.title ?? query!;

  const entities = readJsonFile<CanonPage[]>(CANON_PATH, []).filter((p) => pageKey(p.url).startsWith(pageKey(root))).flatMap((p) => p.entities);
  if (!entities.length) console.log(`no canon for ${root} yet: tracks, deadlines, the timezone and sponsor names need it. Next: bun run hr canon (it prints its estimated cost first), then bun run hr discover again`);

  // Organizers: admin and owner flags (the export's users.json until the extension reads them), the name tag, and
  // everyone posting where Slack restricts posting.
  const expDir = values.export ? fromCaller(values.export) : pullDir;
  const users: DiscoveredUser[] = expDir
    ? readJsonFile<ExportUser[]>(join(expDir, "users.json"), []).map((u) => {
        const x = u as ExportUser & { is_admin?: boolean; is_owner?: boolean; deleted?: boolean; is_bot?: boolean; profile?: { title?: string } };
        return { id: x.id, is_admin: x.is_admin, is_owner: x.is_owner, deleted: x.deleted, is_bot: x.is_bot, title: x.profile?.title, names: [x.profile?.display_name, x.profile?.real_name, x.real_name].filter(Boolean).join(" ") };
      })
    : [];
  // Authority only from signals a hacker can't set (D19): admin/owner flags and restricted-posting channels. Posters
  // in channels picked by name, name tags and titles are proposals, listed for the user and never written.
  const posters = organizersFromRestricted(messages, announcement).map((p) => p.id);
  const { organizers: orgs, proposals } = organizersFrom(users, organizerTag(title), flagged.length ? posters : [], flagged.length ? [] : posters);
  console.log(
    `organizers: ${orgs.length} (${expDir ? `admin/owner flags from ${expDir}/users.json${expDir === pullDir ? " (the API pull's users.list)" : ""}` : "no users list with admin flags yet"}; ` +
      `${flagged.length ? posters.length : 0} restricted-posting posters); ${proposals.length} proposed, not written (name tag, title, or posting in a channel named like announcements)`,
  );

  const items = readJsonFile<Item[]>(ITEMS_PATH, []);
  const slackSchedule = slackDeadlines(items, messages, announcement, new Set(orgs.map((o) => o.id)));
  const oldest = messages.reduce((n, m) => Math.min(n, Number(m.ts)), Infinity);
  const ev = eventDraft({ title, root, why: hit ? why : `Devpost link in announcements; the name is the workspace's (no Devpost search${values.offline ? ", --offline" : ""})`, entities, slackSchedule, oldestTs: Number.isFinite(oldest) ? oldest : null, authority });
  const sp = sponsorsDraft(entities, channels, announcement);

  // Write what's missing or still discover's own; keep anything edited by hand.
  const record = readJsonFile<{ written?: Record<string, string> }>(DISCOVERY_PATH, {});
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const written: Record<string, string> = { ...(record.written ?? {}) };
  for (const [path, value] of [[EVENT_PATH, ev.config], [SPONSORS_PATH, sp.sponsors], [ORGANIZERS_PATH, orgs]] as const) {
    const text = JSON.stringify(value, null, 2) + "\n";
    const cur = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (cur === null || sha(cur) === written[path]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      written[path] = sha(text);
      console.log(`${cur === null ? "wrote" : "updated"} ${path}`);
    } else console.log(`kept ${path} (edited since discover wrote it, or written by hand); its draft is in ${DISCOVERY_PATH}`);
  }
  for (const [k, v] of Object.entries(ev.sources)) console.log(`  ${k}: ${v}`);
  console.log(`  sponsors: ${Object.keys(sp.sponsors).length} channels; Devpost tags with no channel: ${sp.tags_without_channel.join(", ") || "none"}; channels with no Devpost tag (named from the channel): ${sp.channels_without_tag.join(", ") || "none"}`);
  for (const u of ev.config.unconfirmed) console.log(`  check: ${u}`);

  const against = values.against ? compareConfig(fromCaller(values.against), ev.config, sp.sponsors, orgs) : null;
  writeJsonFile(DISCOVERY_PATH, { discovered_at: new Date().toISOString(), workspace: sub, query, devpost: { root, why }, written, event: ev, sponsors: sp, organizers: orgs, organizer_proposals: proposals, against });
  console.log(`wrote ${DISCOVERY_PATH}`);
  return 0;
}

/** How close discovery came to a hand-written config: per field, per channel, and whether the classifier's prompt
 *  (built from event.json) would stay the same, so cached classifications survive. */
function compareConfig(dir: string, ev: EventConfig, sponsors: Sponsors, orgs: { id: string }[]) {
  const hand = readJsonFile<EventConfig & Record<string, unknown>>(join(dir, "event.json"), null as never);
  const handSp = readJsonFile<Sponsors>(join(dir, "sponsors.json"), {});
  const handOrgs = readJsonFile<{ id: string }[]>(join(dir, "organizers.json"), []);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const fields = ["event", "timezone", "hacking_start", "hacking_end", "oldest_message", "canon_pages", "schedule_pages", "authority_channels", "hacker_only_channels", "event_level_prizes", "tool_gated_prizes"].map((k) => ({
    field: k,
    match: same((ev as unknown as Record<string, unknown>)[k], hand[k]),
    hand: hand[k] ?? null,
    discovered: (ev as unknown as Record<string, unknown>)[k] ?? null,
  }));
  // One to one, by time and superseded state; an entry whose start matches but whose end time is missing or differs
  // is "start only". Time alone can pair two different events at the same minute: the labels are printed side by side.
  const taken = new Set<number>();
  const schedule = hand.schedule.map((h) => {
    const i = ev.schedule.findIndex((x, j) => !taken.has(j) && Date.parse(x.at) === Date.parse(h.at) && !!x.superseded_by === !!h.superseded_by);
    if (i >= 0) taken.add(i);
    const d = i >= 0 ? ev.schedule[i] : undefined;
    const full = !!d && (d.until ? Date.parse(d.until) : null) === (h.until ? Date.parse(h.until) : null);
    return { hand: `${h.what} @ ${h.at}${h.until ? `–${h.until}` : ""}${h.superseded_by ? " (superseded)" : ""}`, discovered: d ? `${d.what} @ ${d.at}${d.until ? `–${d.until}` : ""}${d.superseded_by ? " (superseded)" : ""}` : null, full };
  });
  const sp = compareSponsors(sponsors, handSp);
  const aliases = Object.entries(handSp).filter(([ch, h]) => h.aliases.length && !(sponsors[ch]?.aliases ?? []).length).map(([ch, h]) => `${ch}: ${h.aliases.join(", ")}`);
  const ids = new Set(orgs.map((o) => o.id)), handIds = new Set(handOrgs.map((o) => o.id));
  const rules = readRules();
  const prompt = { hand: promptHash(systemPrompt(hand, rules)), discovered: promptHash(systemPrompt(ev, rules)) };
  const report = {
    fields,
    schedule: { matched: schedule.filter((s) => s.full).length, start_only: schedule.filter((s) => s.discovered && !s.full).length, hand: hand.schedule.length, discovered: ev.schedule.length, rows: schedule },
    sponsors: { matched: sp.matched, hand: sp.n, discovered: Object.keys(sponsors).length, mismatched: sp.rows.filter((r) => !r.match), extra: sp.extra, aliases_not_derived: aliases },
    organizers: { hand: handIds.size, discovered: ids.size, both: [...ids].filter((i) => handIds.has(i)).length, only_hand: [...handIds].filter((i) => !ids.has(i)).length, only_discovered: [...ids].filter((i) => !handIds.has(i)).length },
    classify_prompt: { ...prompt, same: prompt.hand === prompt.discovered },
  };
  console.log(`\nagainst ${dir}:`);
  for (const f of fields) console.log(`  ${f.match ? "same" : "DIFF"} ${f.field}${f.match ? "" : `: hand ${JSON.stringify(f.hand)}, discovered ${JSON.stringify(f.discovered)}`}`);
  console.log(`  schedule: ${report.schedule.matched}/${report.schedule.hand} hand entries found by time, ${report.schedule.start_only} more by start time only (discovered ${report.schedule.discovered})`);
  for (const r of schedule) console.log(`    ${r.full ? "found " : r.discovered ? "start " : "MISSED"} ${r.hand}${r.discovered ? `  ← ${r.discovered}` : ""}`);
  console.log(`  sponsors: ${sp.matched}/${sp.n} channels same sponsor and kind; ${sp.extra.length} discovered channels not in the hand file${sp.extra.length ? ` (${sp.extra.join(", ")})` : ""}`);
  for (const r of report.sponsors.mismatched) console.log(`    DIFF ${r.channel}: hand ${r.hand}, discovered ${r.draft}`);
  console.log(`  aliases: ${aliases.length} hand channels have aliases discovery doesn't derive`);
  console.log(`  organizers: ${report.organizers.both} in both, ${report.organizers.only_hand} only hand, ${report.organizers.only_discovered} only discovered (hand ${handIds.size}, discovered ${ids.size})`);
  console.log(`  classifier prompt: ${report.classify_prompt.same ? "same as the hand config's: cached classifications stay valid" : `differs (hand ${prompt.hand}, discovered ${prompt.discovered}): installing it would make every cached classification stale; classify --new keeps them`}`);
  return report;
}

/** An API pull's raw channel files → the DOM sync's capture files in `out`, so record-run reads one format. */
function convertApiBundle(apiDir: string, out: string, runId: string): number {
  const users = new Map(readJsonFile<ApiUser[]>(join(apiDir, "users.json"), []).map((u) => [u.id, u]));
  const channels = new Map(readJsonFile<{ id: string; name: string }[]>(join(apiDir, "channels.json"), []).map((c) => [c.id, c.name]));
  // A pull that stopped early wrote no pull.json: take the workspace origin from another ingested pull's.
  const originOf = (d: string) => readJsonFile<{ workspace?: { origin?: string } }>(join(d, "pull.json"), {}).workspace?.origin ?? "";
  const siblings = existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).map((d) => join(CAPTURES_DIR, d, "pull")).filter((d) => existsSync(join(d, "pull.json"))) : [];
  const origin = originOf(apiDir) || siblings.map(originOf).find(Boolean) || "";
  let bad = 0;
  for (const f of readdirSync(apiDir).filter((f) => /^[CG][A-Z0-9]+\.json$/.test(f)).sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(apiDir, f), "utf8")) as ApiChannelFile;
      if (raw.kind !== "api-channel") throw new Error("not an API channel file");
      const { channel, threads } = captureFromApi(raw, { origin, runId, users, channels });
      parseThreadCaptureFile(JSON.parse(JSON.stringify(threads)), f);
      writeFileSync(join(out, f), JSON.stringify(channel, null, 2));
      if (threads.threads.length) writeFileSync(join(out, threadCaptureName(raw.channel_id)), JSON.stringify(threads, null, 2));
      console.log(`${raw.channel_name}: ${channel.messages.length} posts, ${threads.threads.length} threads, ${threads.threads.reduce((n, t) => n + t.replies.length, 0)} replies${raw.oldest ? ` (since ${raw.oldest})` : ""}`);
    } catch (e) {
      console.error(`pull/${f}: ${(e as Error).message}; skipped`);
      bad++;
    }
  }
  return bad;
}

/** The user's acceptance check for the API pull (2026-11-07): every config channel's posts and replies, by ts,
 *  against the Slack export. */
function compareApi(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { export: { type: "string", default: DEFAULT_EXPORT_DIR } } });
  const dirs = positionals.length ? positionals.map(fromCaller) : existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).filter((d) => existsSync(join(CAPTURES_DIR, d, "pull"))).sort().map((d) => join(CAPTURES_DIR, d, "pull")) : [];
  if (!dirs.length) {
    console.error(`no API pull in ${CAPTURES_DIR}/sync-*/pull/: run hr sync-ingest after a pull`);
    return 2;
  }
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /^[CG][A-Z0-9]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(d, f), "utf8")) as ApiChannelFile));
  const api = apiKeys(files);
  const exp = loadExport(fromCaller(values.export!));
  const sponsors = readSponsors(SPONSORS_PATH);
  const channels = [...new Set([...Object.keys(sponsors), ...(readEvent().authority_channels ?? [])])];
  const locked = new Set(Object.entries(sponsors).filter(([, s]) => !s.stretch).map(([c]) => c));
  const rows = channels.filter((c) => existsSync(join(exp.dir, c))).map((c) => compareKeys(c, api.get(c), exportKeys(readChannel(exp, c))));
  const sum = (rs: KeyCompare[], k: "posts" | "replies") => rs.reduce((a, r) => ({ e: a.e + r[k].export, m: a.m + r[k].matched, x: a.x + r[k].extra }), { e: 0, m: 0, x: 0 });
  console.log(`API pull (${dirs.length} bundle${dirs.length === 1 ? "" : "s"}) against ${exp.dir}, ${rows.length} config channels:`);
  for (const r of rows) {
    const ok = !r.posts.missing.length && !r.replies.missing.length;
    console.log(`  ${ok ? "same   " : "MISSING"} ${r.channel}: posts ${r.posts.matched}/${r.posts.export}${r.posts.extra ? ` +${r.posts.extra}` : ""}, replies ${r.replies.matched}/${r.replies.export}${r.replies.extra ? ` +${r.replies.extra}` : ""}${api.has(r.channel) ? "" : " (not pulled)"}`);
    for (const t of [...r.posts.missing.slice(0, 3), ...r.replies.missing.slice(0, 3)]) console.log(`      missing ${t}`);
  }
  const all = { posts: sum(rows, "posts"), replies: sum(rows, "replies") };
  const lockedReplies = sum(rows.filter((r) => locked.has(r.channel)), "replies");
  const exact = rows.filter((r) => !r.posts.missing.length && !r.replies.missing.length).length;
  console.log(`\n  ${exact}/${rows.length} channels with nothing missing`);
  console.log(`  posts ${all.posts.m}/${all.posts.e} (+${all.posts.x} only in the pull); replies ${all.replies.m}/${all.replies.e} (+${all.replies.x}); the locked ${locked.size}: replies ${lockedReplies.m}/${lockedReplies.e}`);
  console.log(`  "only in the pull" is posted after the export, or rows the export left out; "missing" is deleted since, or not read`);
  return exact === rows.length ? 0 : 1;
}

function printLabelProblems(rows: ReturnType<typeof readLabels>): number {
  const labeled = rows.filter((r) => r.is_credit || r.is_dated || r.exclude);
  let n = 0;
  for (const r of rows) {
    const p = labelProblems(r);
    if (p.length) n++, console.log(`  ${r.message_id} (${r.channel}): ${p.join("; ")}`);
  }
  console.log(`labeled so far: ${labeled.length}/${rows.length} rows; ${n} with problems`);
  return n;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const mark = (ok: boolean) => (ok ? "ok" : "FAIL");

function printTable(rs: ChannelReport[]): void {
  const rows = rs.map((r) => [
    r.channel_name,
    `${r.matched_real}/${r.export_top_level.real}`,
    `${pct(r.keyed_recall)} ${mark(r.pass.recall)}`,
    `${r.author.matched}/${r.author.checked} ${pct(r.author.rate)} ${mark(r.pass.author)}`,
    `${r.bot_captured}/${r.export_top_level.bot}`,
    `${r.broadcast_captured}/${r.export_broadcasts}`,
    `${r.extras.length}`,
    r.stop_reason,
    `${r.duration_s}s${r.pass.time ? "" : " (>2min)"}`,
    `${r.system_rows_skipped}/${r.export_top_level.system}`,
  ]);
  const head = ["channel", "real found", "keyed recall", "author match", "bot", "broadcast", "extra", "stop", "time", "system skip/export"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  rows.forEach((r) => console.log(line(r)));
}

function printDetails(r: ChannelReport): void {
  if (
    !r.missed.length &&
    !r.extras.length &&
    !r.dropped_on_load.length &&
    !r.author.mismatches.length &&
    !r.author.unverifiable.length &&
    !r.unresolved_authors &&
    !r.no_text.length
  )
    return;
  console.log(`\n## ${r.channel_name} (${r.channel_id})`);
  if (r.missed.length) {
    console.log(`missed ${r.missed.length}:`);
    for (const m of r.missed) console.log(`  ${m.permalink}  ${m.class === "broadcast" ? "[broadcast] " : ""}${m.author}: ${m.text}`);
  }
  if (r.dropped_on_load.length) {
    console.log(`non-posts dropped on load (capture predates the parser rule): ${r.dropped_on_load.map((d) => `${d.ts} ${d.reason}`).join(", ")}`);
  }
  if (r.extras.length) {
    console.log(`extra ${r.extras.length}:`);
    for (const e of r.extras) console.log(`  ${e.ts}  ${e.why}${e.subtype ? ` (${e.subtype})` : ""}: ${e.text}`);
  }
  if (r.author.mismatches.length) {
    console.log(`author mismatches ${r.author.mismatches.length}:`);
    for (const m of r.author.mismatches) console.log(`  ${m.ts}  captured "${m.captured}", export ${JSON.stringify(m.expected)}`);
  }
  for (const u of r.author.unverifiable) {
    const ok = u.captured_names.length === 1 && u.captured_names[0] !== "";
    console.log(`no name in export for ${u.user} (${u.posts} posts): captured ${JSON.stringify(u.captured_names)}${ok ? ", check by hand" : " FAIL: not one consistent name"}`);
  }
  if (r.unresolved_authors) console.log(`grouped posts with no resolved author: ${r.unresolved_authors}`);
  if (r.no_text.length) console.log(`found with no text (read while Slack still showed its loading placeholder): ${r.no_text.length}`);
}

function printLockedCoverage(sponsorsPath: string, rs: ChannelReport[]): void {
  if (!existsSync(sponsorsPath)) return;
  const sponsors = JSON.parse(readFileSync(sponsorsPath, "utf8")) as Record<string, { stretch?: boolean }>;
  const locked = Object.entries(sponsors).filter(([, v]) => !v.stretch).map(([k]) => k);
  const passed = new Set(rs.filter((r) => r.pass.recall).map((r) => r.channel_name));
  const todo = locked.filter((c) => !passed.has(c));
  const noText = rs.filter((r) => locked.includes(r.channel_name)).reduce((n, r) => n + r.no_text.length, 0);
  console.log(`\nlocked ${locked.length}: ${locked.length - todo.length} pass keyed recall` + (todo.length ? `; not yet: ${todo.join(", ")}` : "") + (noText ? `; ${noText} posts found with no text` : ""));
}

let args: string[];
try {
  const { slug, rest } = takeEventArg(process.argv.slice(2));
  args = rest;
  if (rest[0] && COMMANDS.includes(rest[0])) useEvent(slug);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
process.exit(
  await main(args).catch((e) => {
    // The spend guard (costguard.ts): a refused call ends the command; what it already wrote stays.
    if (!(e instanceof CostRefused)) throw e;
    console.error(e.message);
    return 2;
  }),
);

// Kept out of the grouping code's span (group.test.ts checks it never reads classifier output): Sessions read the
// classifier's workshop items.
/** P3–P5's joins (planjoin.ts) on this event's workspace data, read once per request. `nowMs` is the clock (the
 *  server's, or `hr plan --at`). */
function planJoins(input: PlanInput, ctx: PlanContext, nowMs: number): NonNullable<PlanSteps["joins"]> {
  const sponsors = readSponsors(SPONSORS_PATH);
  const messages = readMessages();
  const byId = new Map(messages.map((m) => [m.id, m]));
  const person = loadPersonKey();
  const reps = loadRepIndex(person);
  const role = rolesById(messages, sponsors, loadOrganizerIds(), person, reps.confirmed);
  const products = readProducts();
  const set = (tracks: PlanTrack[]) => joinSponsors(input, tracks, ctx.aliases, products);
  const nowSec = nowMs / 1000;
  // Every Plan quote comes from the board's rendering of a post (plain text, as posted), never the raw markup.
  const rendered = new Map<string, string>();
  const shown = (m: Message) => rendered.get(m.id) ?? (rendered.set(m.id, plainText(m.text)), rendered.get(m.id)!);
  return {
    credits: (tracks) => {
      const board = readJsonFile<BoardData | null>(BOARD_DATA_PATH, null);
      const sp = set(tracks);
      return { sponsors: sp, ...planCredits(board?.offers ?? [], sp, new Map(messages.map((m) => [m.permalink, shown(m)])), nowSec) };
    },
    sessions: (tracks) => {
      const deadline = submissionDeadline(planMeta(ctx.entities, ctx.event, nowMs).deadlines);
      return { deadline, sessions: planSessions(readJsonFile<Item[]>(ITEMS_PATH, []), byId, set(tracks), nowMs, deadline, shown) };
    },
    people: (tracks) => planPeople(messages, set(tracks), sponsors, role, person, nowSec, shown, reps),
  };
}

/** Runs Plan's stream (planstream.ts) with the real ranker, repo and gap check, hands each event to `on`, then saves
 *  what the model added to the caches and appends one timing line (PLAN_TIMINGS_PATH). `fresh` skips both caches
 *  and saves nothing: it times an input as if it were new. */

/** `hr rep-signals`: reps.ts's three signals over the capture, with the export filling what the capture can't hold
 *  yet (emails; mention IDs before the parser kept them; who posted in hacker-only channels, which aren't synced
 *  because their posts would reach the classifier). Every source is written into the file. */
async function repSignals(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { export: { type: "string", default: DEFAULT_EXPORT_DIR } } });
  const dir = fromCaller(values.export!);
  const exp = existsSync(join(dir, "users.json")) ? loadExport(dir) : null;
  const sponsors = readSponsors(SPONSORS_PATH);
  const event = readEvent();
  const messages = readMessages();
  const person = loadPersonKey();
  const organizers = readJsonFile<Organizer[]>(ORGANIZERS_PATH, []);
  const organizerIds = new Set(organizers.map((o) => o.id));
  const notes: string[] = [];

  // Replies: every synced thread capture, the newest copy of each reply.
  const replies = new Map<string, Message>();
  const syncDirs = existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).filter((d) => d.startsWith("sync-")).sort().map((d) => join(CAPTURES_DIR, d)) : [];
  for (const f of threadCaptureFiles(syncDirs)) for (const t of parseThreadCaptureFile(JSON.parse(readFileSync(f, "utf8")), f).threads) for (const r of t.replies) replies.set(r.id, r);
  const repliesSrc = replies.size ? `capture (${replies.size} thread replies from ${syncDirs.length} syncs)` : "not checked: no thread capture yet";

  // Signal 1: emails in the users.json snapshot.
  const users = exp ? [...exp.users.values()].map((u) => ({ id: u.id, email: (u as SnapshotUser).profile?.email })) : [];
  const shown = users.filter((u) => u.email).length;
  const withDomains = Object.values(sponsors).filter((s) => s.domains?.length).length;
  const emailsSrc = exp ? `export (${join(dir, "users.json")}): ${shown} of ${users.length} accounts show an email` : "not checked: no users.json snapshot";
  if (exp) notes.push(`email: ${shown} of ${users.length} accounts in users.json show an email; ${withDomains} sponsor${withDomains === 1 ? "" : "s"} list a domain in sponsors.json`);
  const email = emailReps(users, sponsors);

  // Signal 2: authority (D19) = admin/owner-backed organizer ids, plus any post in an authority channel.
  const authorityIds = new Set(organizers.filter((o) => o.why.includes("admin") || o.why.includes("owner")).map((o) => o.id));
  const caps = captureFiles([CAPTURES_DIR, ...syncDirs]).map((f) => loadCapture(f).capture);
  const authorityChannels = new Set([...(event.authority_channels ?? []), ...caps.filter((c) => c.posting_restricted === true).map((c) => c.channel_name)]);
  const captured = [...messages, ...replies.values()];
  const capturedMentions = captured.filter((m) => m.mentions?.length);
  let mentionPosts: MentionPost[];
  let mentionsSrc: string;
  if (capturedMentions.length || !exp) {
    mentionPosts = capturedMentions.map((m) => ({ author_id: m.author_id ?? "", channel_name: m.channel_name, text: m.text, mentions: m.mentions!, permalink: m.permalink, reply: !!m.thread_ts }));
    mentionsSrc = capturedMentions.length ? `capture (${capturedMentions.length} posts with mention IDs)` : "not checked: no capture carries mention IDs yet and no export";
  } else {
    const host = new URL(messages.find((m) => m.permalink)?.permalink ?? "https://slack.com").host;
    const idOf = new Map([...exp.channelsById].map(([id, name]) => [name, id]));
    mentionPosts = [...exp.channelsById.values()].filter((c) => existsSync(join(dir, c))).flatMap((c) =>
      readChannel(exp, c)
        .filter((m) => m.user && (rowClass(m) === "real" || rowClass(m) === "broadcast") && (m.text ?? "").includes("<@"))
        .map((m) => ({
          author_id: m.user!,
          channel_name: c,
          text: m.text ?? "",
          mentions: [...(m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)>/g)].map((x) => ({ id: x[1]!, label: x[0] })),
          permalink: `https://${host}/archives/${idOf.get(c)}/p${m.ts.replace(".", "")}`,
          reply: !isTopLevel(m),
        })),
    );
    mentionsSrc = `export (${dir}): the capture carries no mention IDs yet (parser keeps them from the next sync)`;
  }
  const authority = mentionAuthority(authorityIds, authorityChannels);
  const mention = mentionReps(mentionPosts, sponsors, authority, (id) => organizerIds.has(id));
  notes.push(`organizer mention: ${authorityIds.size} admin/owner-backed organizer ids, ${authorityChannels.size} authority channel${authorityChannels.size === 1 ? "" : "s"}; ${mentionPosts.filter(authority).length} authority posts with a mention read; ${mention.ambiguous} line${mention.ambiguous === 1 ? "" : "s"} naming two or more sponsors skipped`);

  // Hacker-only channels' posters: the newest authors-only capture of each (IDs and counts, no text), else the export
  // (author IDs only). Signal 3's exclusion, or with signal 2b, its counter-signal.
  const known = new Set([...messages.map((m) => m.channel_name), ...(exp ? exp.channelsById.values() : [])]);
  const authorsFiles = new Map<string, AuthorsCaptureFile>();
  for (const d of syncDirs) {
    for (const f of readdirSync(d).filter((f) => /\.authors\.json$/.test(f)).sort()) {
      const a = parseAuthorsCaptureFile(JSON.parse(readFileSync(join(d, f), "utf8")), f, new Set(Object.values(sponsors).map((s) => s.sponsor)));
      authorsFiles.set(a.channel_name, a);
      known.add(a.channel_name);
    }
  }
  const hackerChannels = hackerOnlyChannels(known, event.hacker_only_channels);
  const hackerCounts = new Map<string, { channel: string; posts: number }[]>();
  const count = (who: string, channel: string, n: number) => {
    const xs = hackerCounts.get(who) ?? [];
    const x = xs.find((c) => c.channel === channel);
    if (x) x.posts += n;
    else xs.push({ channel, posts: n });
    hackerCounts.set(who, xs);
  };
  const fromCapture = hackerChannels.filter((c) => authorsFiles.has(c));
  const fromExport = hackerChannels.filter((c) => !authorsFiles.has(c) && exp && existsSync(join(dir, c)));
  const unread = hackerChannels.filter((c) => !fromCapture.includes(c) && !fromExport.includes(c));
  let hackerPosters: Set<string> | null = null;
  const hackerSelf: { id: string; sponsor: string; channel: string; ts: number }[] = [];
  let hackerSrc: string;
  if (!hackerChannels.length) hackerSrc = "not checked: no hacker-only channel known";
  else if (unread.length) hackerSrc = `not checked: ${unread.join(", ")} not in an authors-only capture or the export, so no one is likely staff`;
  else {
    for (const c of fromCapture) {
      const a = authorsFiles.get(c)!;
      for (const x of a.authors) count(person(x.id), c, x.posts);
      for (const x of a.self_ids) hackerSelf.push({ id: x.id, sponsor: x.sponsor, channel: c, ts: Date.parse(a.finished_at) / 1000 });
    }
    for (const c of fromExport) {
      const ms = readChannel(exp!, c).filter((m) => m.user && !m.bot_id && m.subtype !== "thread_broadcast");
      for (const m of ms) count(person(m.user!), c, 1);
      // As the page does: 2b's match runs over the text here, and only user ID and sponsor are kept. The time kept
      // is the export's last post in the channel (when the source was read), never the post's own.
      const end = Math.max(...ms.map((m) => Number(m.ts)));
      for (const x of selfIdFlags(ms.map((m) => ({ author_id: m.user, text: m.text ?? "" })), selfIdSponsorList(sponsors))) hackerSelf.push({ id: x.id, sponsor: x.sponsor, channel: c, ts: end });
    }
    hackerPosters = new Set(hackerCounts.keys());
    hackerSrc = [
      fromCapture.length ? `authors-only capture: ${fromCapture.map((c) => { const a = authorsFiles.get(c)!; return `${c} (${a.threads.read} of ${a.threads.parents} threads read to the end${a.unidentified ? `, ${a.unidentified} posts with no sender ID` : ""})`; }).join(", ")}` : "",
      fromExport.length ? `export (${dir}): author IDs only for ${fromExport.join(", ")}` : "",
    ].filter(Boolean).join("; ");
  }
  if (hackerPosters) notes.push(`hacker-only: ${hackerPosters.size} people posted in ${hackerChannels.join(", ")}`);

  // Signal 2b: each person's own posts and replies in sponsor channels.
  const selfId = selfIdReps([...messages, ...replies.values()], sponsors, person, hackerSelf);
  notes.push(`says they work there: ${selfId.length} person-sponsor pairs, ${hackerSelf.length} of the flags from hacker-only channels (no text kept)`);

  const confirmedIds = new Map<string, Set<string>>();
  for (const x of [...email, ...mention.hits]) confirmedIds.set(person(x.id), (confirmedIds.get(person(x.id)) ?? new Set()).add(x.sponsor));
  const role = rolesById(captured, sponsors, organizerIds, person, confirmedIds);
  const selfIdentified = new Set(selfId.map((x) => `${x.person}|${x.sponsor}`));
  const likely = likelyReps({ messages, replies: [...replies.values()], items: readJsonFile<Item[]>(ITEMS_PATH, []), sponsors, role, person, hackerPosters, selfIdentified });

  const file: RepSignalsFile = {
    built_at: new Date().toISOString(),
    sources: { emails: emailsSrc, mentions: mentionsSrc, replies: repliesSrc, hacker_only: hackerSrc },
    hacker_only_channels: hackerChannels,
    rule_notes: notes,
    reps: repEvidence({ email, mention: mention.hits, selfId, likely, hacker: hackerCounts, person }),
  };
  mkdirSync(dirname(REP_SIGNALS_PATH), { recursive: true });
  writeFileSync(REP_SIGNALS_PATH, JSON.stringify(file, null, 2) + "\n");
  for (const [k, v] of Object.entries(file.sources)) console.log(`${k}: ${v}`);
  for (const n of notes) console.log(n);
  const base = rolesById(captured, sponsors, organizerIds, person);
  for (const e of file.reps) {
    const already = captured.some((m) => m.author_id && person(m.author_id) === e.person && sponsors[m.channel_name]?.sponsor === e.sponsor && base(m) === "sponsor-side");
    const name = [...captured].reverse().find((m) => m.author_id && person(m.author_id) === e.person)?.author_name ?? e.person;
    console.log(`${e.sponsor}: ${name} (${e.accounts.join(", ")}) ${e.standing}${already ? ", already sponsor-side by name, title or badge" : ", new"}: ${e.signals.map((s) => (s.kind === "likely staff" ? `likely staff (${s.posts.length} posts, ${s.answers.length} answers)` : s.kind === "self-identified" ? `says they work there (${s.posts.map((p) => (p.phrase ? `“${p.phrase}”` : `in #${p.channel}`)).join("; ")})` : s.kind === "hacker channels" ? `counter-signal: ${s.channels.map((c) => `#${c.channel} ${c.posts}`).join(", ")}` : s.kind)).join("; ")}`);
  }
  console.log(`${file.reps.length} reps with a signal (${file.reps.filter((e) => e.standing === "confirmed").length} confirmed) → ${REP_SIGNALS_PATH}`);
  return 0;
}

/** Changes whenever a file Plan or Ship reads changes (a sync, a canon run, rep signals): the board polls it and,
 *  on a change, rebuilds the plan and shows what's new (D5). File times and sizes only, no contents. */
function dataVersion(): string {
  const parts = [CANON_PATH, CANON_HISTORY_PATH, MESSAGES_PATH, ITEMS_PATH, EVENT_PATH, SPONSORS_PATH, REP_SIGNALS_PATH, BOARD_DATA_PATH].map((p) => (existsSync(p) ? `${p}:${statSync(p).mtimeMs}:${statSync(p).size}` : `${p}:-`));
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** D4's stale state: canon pages the last sync couldn't fetch (refused, login, error) and the extension didn't read
 *  either, so Plan says "Devpost as of <the snapshot's time>". */
function stalePages(): string[] {
  const d = readJsonFile<{ fetch?: { url: string; status: string; role?: string }[]; extension_pages?: { url: string; action: string }[] }>(DISCOVERED_PATH, {});
  const read = new Set((d.extension_pages ?? []).filter((x) => x.action === "saved" || x.action === "same").map((x) => pageKey(x.url)));
  return (d.fetch ?? []).filter((r) => r.role === "canon" && r.status !== "fetched" && !read.has(pageKey(r.url))).map((r) => r.url);
}
