// Per-event layout (v2 D10). Every path the pipeline reads or writes lives here. Event paths are relative
// to the event's own directory, events/<slug>/, and `hr` changes into that directory before running a
// command (`useEvent`), so one checkout serves any number of events. `--event <slug>` picks one; the
// default is events/current, a gitignored symlink to the event being worked on.
//
// events/<slug>/
//   config/event.json, config/sponsors.json   tracked: hand-written, no workspace text
//   config/organizers.json                    gitignored: names and Slack ids
//   captures/ data/ review/ fixtures/         gitignored: workspace content
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const REPO_ROOT = new URL("..", import.meta.url).pathname;
export const EVENTS_DIR = join(REPO_ROOT, "events");
export const DEFAULT_EVENT = "current";

/** Paths under an event directory that hold workspace content and must never be tracked by git. */
export const UNTRACKED_EVENT_PATHS = ["captures/", "review/", "data/", "fixtures/", "config/organizers.json"] as const;

// Event-relative paths.
export const EVENT_PATH = "config/event.json";
export const SPONSORS_PATH = "config/sponsors.json";
export const ORGANIZERS_PATH = "config/organizers.json";
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
export const CANON_JUDGE_PATH = "review/canon_judge.json";
export const CANON_JUDGE_FIXTURES_PATH = "review/canon_judge.fixtures.json";
/** Idea-fit rankings by input hash (shared by `hr fit-eval` and, later, POST /fit). */
export const FIT_CACHE_PATH = "data/fit_cache.json";
export const GAPS_CACHE_PATH = "data/gaps_cache.json";
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
/** Cal Hacks 13.0's slackdump export (read-only baseline for `hr compare`). Other events pass --export. */
export const DEFAULT_EXPORT_DIR = join(homedir(), "projects/hackrecon-data/calhacks");

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
