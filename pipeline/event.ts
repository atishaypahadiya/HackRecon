// Per-event layout (v2 D10). Every path the pipeline reads or writes lives here. Event paths are relative
// to the event's own directory, events/<slug>/, and `hr` changes into that directory before running a
// command (`useEvent`), so one checkout serves any number of events. `--event <slug>` picks one; the
// default is events/current, a gitignored symlink to the event being worked on.
//
// events/<slug>/
//   config/event.json, config/sponsors.json   tracked: hand-written, no workspace text
//   config/organizers.json                    gitignored: Slack ids
//   config/person_links.json                  gitignored: Slack ids linked as one person, with hashed evidence
//   config/rep_signals.json                   gitignored: sponsor reps beyond A5's signals, with their evidence (reps.ts)
//   captures/ data/ review/ fixtures/         gitignored: workspace content
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const REPO_ROOT = new URL("..", import.meta.url).pathname;
export const EVENTS_DIR = join(REPO_ROOT, "events");
export const DEFAULT_EVENT = "current";

/** Paths under an event directory that hold workspace content and must never be tracked by git. */
export const UNTRACKED_EVENT_PATHS = ["captures/", "review/", "data/", "fixtures/", "config/organizers.json", "config/person_links.json", "config/rep_signals.json"] as const;

// Event-relative paths.
export const EVENT_PATH = "config/event.json";
export const SPONSORS_PATH = "config/sponsors.json";
export const ORGANIZERS_PATH = "config/organizers.json";
/** Same-person links between Slack ids (people.ts, `hr person-links`). */
export const PERSON_LINKS_PATH = "config/person_links.json";
export const REP_SIGNALS_PATH = "config/rep_signals.json";
export const CAPTURES_DIR = "captures";
/** Page snapshots from the extension's "Capture this page" (D11): canon. */
export const PAGES_DIR = "captures/pages";
/** Page snapshots built from saved HTML by tests and dev tools: never canon on a board. */
export const PAGE_FIXTURES_DIR = "fixtures/pages";
export const SLACK_DOM_FIXTURES_DIR = "fixtures/slack-dom";
export const CACHE_PATH = "data/classify_cache.json";
export const ERRORS_PATH = "data/classify_errors.json";
export const ITEMS_PATH = "data/items.json";
/** Which messages data/items.json covers, and under which prompt (scored by `hr gate`). */
export const RUN_PATH = "data/classify_run.json";
export const RUNS_PATH = "data/runs.json";
export const MESSAGES_PATH = "data/messages.json";
/** What `hr discover` found and wrote (autoconfig.ts), with the hash of each config file it wrote. */
export const DISCOVERY_PATH = "data/discovery.json";
/** The user's last Plan (`hr plan` or the board): idea, stack and ranked tracks, for the SMS alerts' "why". */
export const PLAN_PATH = "data/plan.json";
/** Discord (user 2026-11-07): files ingested, the bot's cursors, each channel's server; unread badges; alert state. */
export const DISCORD_STATE_PATH = "data/discord_state.json";
export const DISCORD_UNREAD_PATH = "data/discord_unread.json";
/** hr watch's hourly check of the event's pages (user 2026-11-08): when it last fetched them. */
export const PAGE_CHECK_PATH = "data/page_check.json";
/** Track changes a page re-read found (new tracks, noted lines gone), for alerts. */
export const PAGE_CHANGES_PATH = "data/page_changes.json";
/** Chat writes (told.ts): credits the hacker has claimed, by credit id, with who told and when. */
export const CLAIMS_PATH = "data/claims.json";
/** Every write, from chat or the board: time, source, the hacker's words, the operation and its one-line result. */
export const WRITES_LOG_PATH = "data/writes.jsonl";
/** A destructive write waiting for the hacker's "yes". */
export const PENDING_WRITE_PATH = "data/pending_write.json";
/** Slice 2: the tracks the hacker is entering, by track id, with who told and when. */
export const ENTERED_PATH = "data/entered.json";
/** Slice 2: Ship checklist ticks (entry steps shared with Plan), by item id. */
export const SHIP_TICKS_PATH = "data/ship_ticks.json";
/** Slice 3: requirements and judging criteria a rep told the hacker at a booth, per track. Never canon. */
export const REP_NOTES_PATH = "data/rep_notes.json";
/** Slice 4: the hacker's team and each person's skills, as told to Donna. */
export const TEAM_PATH = "data/team.json";
/** Tracks the Plan's gap check has covered, so one that falls to "possible" stays checked (user, 2026-11-08). */
export const GAP_CHECKED_PATH = "data/gap_checked.json";
export const ALERTS_STATE_PATH = "data/alerts_state.json";
export const ALERTS_LOG_PATH = "data/alerts.jsonl";
export const OUTBOX_PATH = "data/outbox.jsonl";
/** The user's questions from their chat and the agent's answers (agent.ts). */
export const CHAT_LOG_PATH = "data/chat.jsonl";
/** Where each two-way channel left off reading (Telegram's update offset). */
export const CHANNEL_STATE_PATH = "data/channel_state.json";
/** Chat answers' spend per event day (agent.ts ChatBudget). */
export const CHAT_SPEND_PATH = "data/chat_spend.json";
export const BOARD_DATA_PATH = "data/board.json";
export const LABELS_PATH = "review/labels.csv";
export const POOL_META_PATH = "review/pool.json";
export const GROUP_PATH = "review/offers.json";
export const JUDGE_CACHE_PATH = "review/prelabel_cache.json";
export const JUDGE_RUN_PATH = "review/prelabel_run.json";
/** `hr canon`: entities per canon page, from extension snapshots. */
export const CANON_PATH = "data/canon.json";
/** `hr canon --fixtures`: the same from fixture snapshots, kept apart so it never reaches a board. */
export const CANON_FIXTURES_PATH = "data/canon.fixtures.json";
/** Every extraction ever made, keyed by prompt hash + input hash, shared by fixture and real runs. Opus 5.5
 *  rejects temperature, and the same request gave 80 vs 78 prizes (2026-11-06), so canon is made
 *  deterministic by never extracting the same input twice (--force to re-extract). */
export const CANON_STORE_PATH = "data/canon_extractions.json";
/** Canon page records a later snapshot replaced, oldest first: merge reads page changes from them (§3 rule 2). */
export const CANON_HISTORY_PATH = "data/canon_history.json";
export const CANON_JUDGE_PATH = "review/canon_judge.json";
export const CANON_JUDGE_FIXTURES_PATH = "review/canon_judge.fixtures.json";
/** Idea-fit rankings by input hash (shared by `hr fit-eval` and, later, POST /fit). */
export const FIT_CACHE_PATH = "data/fit_cache.json";
export const GAPS_CACHE_PATH = "data/gaps_cache.json";
/** One line per Plan request: time to the first section and to each section, cache or model (P2, D4's 8 s target). */
export const PLAN_TIMINGS_PATH = "data/plan_timings.jsonl";
export const SHIP_GAPS_PATH = "data/ship_gaps.json";
export const PREFILL_CACHE_PATH = "data/prefill_cache.json";
/** Sponsor products and their names, packages, hosts and code terms (P1b's sponsor-product pass). */
export const PRODUCTS_PATH = "config/products.json";
/** P1b's eval: the winners' GitHub links, read from their public Devpost project pages ({slug: url}). */
export const PREFILL_REPOS_PATH = "fixtures/fit/repos13.json";
export const PREFILL_EVAL_PATH = "review/prefill_eval.json";
/** The fit eval set: public winners, descriptions and Built With lists (gitignored like all fixtures). */
export const FIT_EVAL_SET_PATH = "fixtures/fit/eval13.json";
export const FIT_EVAL_PATH = "review/fit_eval.json";
/** The fit gate's fixed baseline: per-pair hits of the run it was set from (`hr fit-eval --set-baseline`). */
export const FIT_BASELINE_PATH = "review/fit_baseline.json";
/** `hr sync`: what discovery found this sync (URLs, fetch results, sponsor and organizer drafts). */
export const DISCOVERED_PATH = "data/discovered.json";

// Repo paths (shared by every event).
/** The labeling rules. Their Columns section goes verbatim into both prompts: the Opus judge's
 *  (D21) and the classifier's, so both read the same rules. */
export const RULES_PATH = join(REPO_ROOT, "docs/labeling.md");

// Machine-local paths (outside the repo).
/** Cal Hacks 13.0's slackdump export: the baseline the real-export tests compare their fixtures with. Never a
 *  command's default (audit 2026-11-08): a command reads the export `--export` or event.json's `slack_export` names. */
export const CALHACKS_EXPORT_DIR = join(homedir(), "projects/hackrecon-data/calhacks");

/** The directory for an event slug (or a path to one). Throws with the fix when it doesn't exist. */
export function eventDir(slug = DEFAULT_EVENT): string {
  const dir = slug.includes("/") ? slug : join(EVENTS_DIR, slug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const hint = slug === DEFAULT_EVENT ? `create it with \`ln -s <slug> ${join("events", DEFAULT_EVENT)}\`, or pass --event <slug>` : "pass an existing events/<slug>";
    throw new Error(`event directory ${dir} not found: ${hint}`);
  }
  return dir;
}

/** Splits a global `--event <slug>` (or `--event=<slug>`) out of the CLI args. */
export function takeEventArg(argv: string[]): { slug: string; rest: string[] } {
  const rest: string[] = [];
  let slug = DEFAULT_EVENT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--event") slug = argv[++i] ?? "";
    else if (a.startsWith("--event=")) slug = a.slice("--event=".length);
    else rest.push(a);
  }
  if (!slug) throw new Error("--event needs a slug, e.g. --event calhacks-13");
  return { slug, rest };
}

let callerDir = process.cwd();

/** Makes the event directory the working directory, so every event-relative path above resolves in it. */
export function useEvent(slug = DEFAULT_EVENT): string {
  const dir = eventDir(slug);
  callerDir = process.cwd();
  process.chdir(dir);
  return dir;
}

/** A path the user typed (capture files, --json OUT), resolved against where `hr` was run, not the event dir. */
export function fromCaller(p: string): string {
  return isAbsolute(p) ? p : resolve(callerDir, p);
}
