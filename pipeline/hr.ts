#!/usr/bin/env bun
// hr: HackRecon pipeline CLI. Subcommands land here as tasks ship (compare first).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { captureFiles, loadCapture, type LoadedCapture } from "./captures.ts";
import {
  classifyOne,
  MODEL,
  promptHash,
  readEvent,
  readJsonFile,
  systemPrompt,
  toItems,
  writeJsonFile,
  type Cache,
  type ClassifyError,
  type ClassifyInput,
  type ClassifyRun,
} from "./classify.ts";
import { compareChannel, AUTHOR_MIN, RECALL_MIN, TIME_MAX_S, type ChannelReport } from "./compare.ts";
import { loadExport } from "./export.ts";
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
import { BOARD_FONT_DIR, BOARD_FONTS, BOARD_PAGE, boardData } from "./board.ts";
import { GROUP_EFFORT, GROUP_MODEL, groupHash, groupOffers, groupRequest, groupSystemPrompt, inputHash, withLabelAmounts, type GroupResult } from "./group.ts";
import {
  applyJudge,
  JUDGE_EFFORT,
  JUDGE_MODEL,
  judgeHash,
  judgeOne,
  judgeSystemPrompt,
  rulesSection,
  type JudgeCache,
  type JudgeRun,
  type Labels,
} from "./prelabel.ts";
import { buildOrganizers, loadOrganizerIds, posterRole } from "./roles.ts";
import { buildRun, readMessages, readRuns, saveRun } from "./runs.ts";
import {
  BOARD_DATA_PATH,
  CACHE_PATH,
  CANON_FIXTURES_PATH,
  CANON_JUDGE_FIXTURES_PATH,
  CANON_JUDGE_PATH,
  CANON_PATH,
  CAPTURES_DIR,
  EVENT_PATH,
  DEFAULT_EXPORT_DIR,
  ERRORS_PATH,
  GROUP_PATH,
  ITEMS_PATH,
  JUDGE_CACHE_PATH,
  JUDGE_RUN_PATH,
  LABELS_PATH,
  MESSAGES_PATH,
  ORGANIZERS_PATH,
  PAGE_FIXTURES_DIR,
  PAGES_DIR,
  POOL_META_PATH,
  RULES_PATH,
  RUN_PATH,
  RUNS_PATH,
  SPONSORS_PATH,
  fromCaller,
  takeEventArg,
  useEvent,
} from "./event.ts";
import { loadPages, needsRedaction, pageCoverage, pageKey, redactSnapshot, type LoadedPage } from "./pages.ts";
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
  keyed,
  rematch,
  REMATCH_THRESHOLD,
  type JudgeVerdict,
  type Keyed,
} from "./canon.ts";
import { coverage, type CoverageReport } from "./coverage.ts";
import { callChecked } from "./model.ts";
import { buildNameList, compileRedactor } from "./redact.ts";
import type { Entity, PageSnapshot } from "./schema.ts";
import { PAGE_ACCESS, pageFileName, type Item, type PageAccess } from "./schema.ts";
import { snapshotPage } from "../extension/src/page.ts";

/** slackdump export finished 2026-10-27 03:17 America/Los_Angeles (design doc, D2). */
const EXPORT_CUTOFF = "2026-10-27T03:17:00-07:00";

const USAGE = `usage:
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
  bun run hr prelabel [--dry-run] [--include-hand] [--limit N] [--concurrency N] [--show MESSAGE_ID]
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
  bun run hr group [--dry-run] [--force]
      The Opus grouping pass: claude-opus-5-5 reads every post the judge labeled is_credit = y (same redacted
      input as classify and prelabel, blind to the classifier) and writes the distinct offers with their source
      posts to ${GROUP_PATH}. One streamed request; skipped while the input is unchanged unless --force.
  bun run hr board [--build-only] [--port N]
      Builds ${BOARD_DATA_PATH} from the Opus offers (hr group) and the capture, then serves the board on
      127.0.0.1. Needs a current ${GROUP_PATH}.
  bun run hr pages [--from-html FILE --url URL --access public|authenticated]
      Lists the page snapshots in ${PAGES_DIR} (from the extension's "Capture this page"): url, when, access
      flag, blocks, hash, and any canon_pages / schedule_pages in ${EVENT_PATH} with no snapshot yet.
      --from-html builds a test fixture snapshot from saved HTML into ${PAGE_FIXTURES_DIR} (never canon).
  bun run hr canon [--fixtures] [--judge] [--dry-run] [--force]
      Extracts tracks, prizes, judging criteria and rules from each canon page's latest snapshot (one
      ${CANON_MODEL} call per page; cached by input), verifies every quote, then runs the D15 coverage
      checks. --judge adds the Opus judge ("what's missing or misplaced"). --fixtures reads
      ${PAGE_FIXTURES_DIR} and writes ${CANON_FIXTURES_PATH}, never ${CANON_PATH}. Exit 1 on any failed check.
  bun run hr preview
      Receipt preview from the current data, to pick the board headline: distinct credit offers, priced per
      person, the $ total, offers with a deadline or claim window, sponsors covered, rep candidates. Not the
      receipt: URL merge only, no Opus credit pass, reps unconfirmed; it prints its basis and gaps.
  bun run hr organizers [--export DIR]
      One-time (A5): writes ${ORGANIZERS_PATH} from the baseline's users.json (admins, owners,
      CAL HACKS tags, director/exec/organizer/logistics titles). Used for poster_role.
  bun run hr classify [--labeled-only] [--dry-run] [--limit N] [--concurrency N] [--show MESSAGE_ID]
      Classifies captured messages with ${MODEL} (redacted text only). --labeled-only: just the messages
      in ${LABELS_PATH}. Cached in ${CACHE_PATH}; failures in ${ERRORS_PATH}; items in ${ITEMS_PATH}.
      --dry-run builds every request and prints one, with no API call. Needs ANTHROPIC_API_KEY (.env).`;

const COMMANDS = ["compare", "record-run", "pool", "organizers", "classify", "gate", "label", "prelabel", "preview", "group", "board", "pages", "canon"];

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "compare") return compare(rest);
  if (cmd === "record-run") return recordRun(rest);
  if (cmd === "pool") return pool(rest);
  if (cmd === "organizers") return organizers(rest);
  if (cmd === "classify") return classify(rest);
  if (cmd === "gate") return gate(rest);
  if (cmd === "label") return label(rest);
  if (cmd === "prelabel") return prelabel(rest);
  if (cmd === "preview") return receiptPreview(rest);
  if (cmd === "group") return group(rest);
  if (cmd === "board") return board(rest);
  if (cmd === "pages") return pages(rest);
  if (cmd === "canon") return canon(rest);
  if (cmd) {
    // Name the bad command first (a stray "board." used to print only the usage), and suggest the near miss.
    const near = COMMANDS.find((c) => cmd.replace(/[^a-z-]/g, "") === c);
    console.error(`Unknown command: ${JSON.stringify(cmd)}${near ? `. Did you mean \`bun run hr ${near}\`?` : ""}\n`);
  }
  console.error(USAGE);
  return cmd ? 2 : 0;
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
  const files = captureFiles(positionals.length ? positionals.map(fromCaller) : [CAPTURES_DIR]);
  if (!files.length) {
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

  printTable(reports);
  for (const r of reports) printDetails(r);
  printLockedCoverage(values.sponsors!, reports);
  if (values.json) {
    writeFileSync(fromCaller(values.json), JSON.stringify(reports, null, 2));
    console.log(`\nwrote ${fromCaller(values.json)}`);
  }
  return reports.some((r) => !r.pass.recall) ? 1 : 0;
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

  let client: Anthropic;
  try {
    client = new Anthropic({ maxRetries: 2 });
  } catch (e) {
    console.error(`No Anthropic credentials: add ANTHROPIC_API_KEY=... to .env (Bun loads it; .env is gitignored). ${(e as Error).message}`);
    return 2;
  }
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
    options: { "dry-run": { type: "boolean", default: false }, force: { type: "boolean", default: false }, sponsors: { type: "string", default: SPONSORS_PATH } },
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
  let client: Anthropic;
  try {
    client = new Anthropic({ maxRetries: 2 });
  } catch (e) {
    console.error(`No Anthropic credentials: add ANTHROPIC_API_KEY=... to .env (Bun loads it; .env is gitignored). ${(e as Error).message}`);
    return 2;
  }
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
    options: { "build-only": { type: "boolean", default: false }, port: { type: "string", default: "0" }, sponsors: { type: "string", default: SPONSORS_PATH } },
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
  const all = Object.values(sponsors);
  const labels = readLabels();
  const data = boardData({
    event: event.event,
    timezone: event.timezone,
    schedule: event.schedule,
    run_id: last?.run_id ?? "",
    channels: last?.channels ?? [],
    messages: readMessages(),
    sponsors,
    offers: withLabelAmounts(grouped.offers, new Map(labels.map((r) => [r.message_id, r]))),
    role: (m) => posterRole(m, sponsors[m.channel_name], organizerIds, all),
    basis: { grouping: grouped.input_hash, model: grouped.model, written_at: grouped.written_at },
    permalinks: new Map(labels.map((r) => [r.message_id, r.permalink])),
  });
  writeJsonFile(BOARD_DATA_PATH, data);
  console.log(`wrote ${BOARD_DATA_PATH}: ${data.offers.length} offers, ${data.posts.length} posts, ${data.frames.length} frames, ${data.reps.length} sponsor channels`);
  if (values["build-only"]) return 0;
  const headers = { "Cache-Control": "no-store" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (path === "/")
        return new Response(readFileSync(BOARD_PAGE, "utf8"), {
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
  captured_by: "extension" | "fixture";
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

function anthropicClient(): Anthropic | null {
  try {
    return new Anthropic({ maxRetries: 2 });
  } catch (e) {
    console.error(`No Anthropic credentials: add ANTHROPIC_API_KEY=... to .env (Bun loads it; .env is gitignored). ${(e as Error).message}`);
    return null;
  }
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

async function canon(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { fixtures: { type: "boolean", default: false }, judge: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, force: { type: "boolean", default: false } },
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
  const out: CanonPage[] = [];
  let client: Anthropic | null = null;
  let failed = errors.length > 0 || missing.length > 0;
  for (const p of todo) {
    const c = canonInput(p, event);
    const key = pageKey(p.snapshot.url);
    console.log(`\n${p.snapshot.url}  ${p.snapshot.captured_by}, ${p.snapshot.access ?? "no access flag"}${c.redacted !== null ? `, redacted (${c.redacted} replaced)` : ""}; ${p.snapshot.blocks.length} blocks, request ${c.request.length} chars, prompt ${c.prompt_hash}, input ${c.input_hash}`);
    if (values["dry-run"]) {
      console.log(`--- system prompt (${c.system.length} chars) ---\n${c.system}\n--- request (first 2000 chars) ---\n${c.request.slice(0, 2000)}`);
      continue;
    }
    let page = prev.get(key);
    if (!page || page.input_hash !== c.input_hash || values.force) {
      client ??= anthropicClient();
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
      const { entities, gone } = carryIds(page, r.value.entities, c.snap);
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
        match_keys: keyed(entities, c.snap),
        usage: r.usage,
        cost_usd: Number(costUsd(r.usage, CANON_MODEL).toFixed(4)),
        written_at: new Date().toISOString(),
      };
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
  for (const [k, c] of prev) if (!out.some((o) => pageKey(o.url) === k)) out.push(c); // pages no longer listed stay until removed by hand
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
        client ??= anthropicClient();
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
  const all = Object.values(sponsors);
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
    role: (m) => posterRole(m, sponsors[m.channel_name], organizerIds, all),
  });
  const current = promptHash(systemPrompt(readEvent(), readRules()));
  const stale = run.prompt_hash !== current ? " (STALE: config now gives a different prompt; rerun hr classify)" : "";
  const basis = fresh ? `Opus grouping ${grouped.input_hash} (${grouped.posts} credit posts)` : `classifier prompt ${run.prompt_hash}${stale}, ${run.classified.length} messages classified`;
  console.log(formatPreview(p, `${basis}, run ${last?.run_id ?? "none"}`));
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
      "dry-run": { type: "boolean", default: false },
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
  const todo = inputs.filter((i) => !cache[i.key]);
  const roles: Record<string, number> = {};
  for (const i of inputs) roles[i.role] = (roles[i.role] ?? 0) + 1;
  console.log(
    `${inputs.length} messages, ${inputs.length - todo.length} cached, ${todo.length} to classify; model ${MODEL}, prompt ${hash}; ` +
      `poster_role ${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join(", ")}; ` +
      `${inputs.reduce((n, i) => n + i.redactions, 0)} redactions (${inputs.filter((i) => i.redactions).length} messages)`,
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

  let client: Anthropic;
  try {
    client = new Anthropic({ maxRetries: 2 });
  } catch (e) {
    console.error(`No Anthropic credentials: add ANTHROPIC_API_KEY=... to .env (Bun loads it; .env is gitignored). ${(e as Error).message}`);
    return 2;
  }
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

  // Every captured message cached under the current prompt and input, not only this run's selection.
  // Counts only: what the classifier said is shown by `hr gate`, and only for labeled rows.
  const classified = allInputs.filter((i) => cache[i.key]);
  writeJsonFile(ITEMS_PATH, classified.flatMap((i) => toItems(cache[i.key]!, sponsors)));
  const run: ClassifyRun = {
    prompt_hash: hash,
    model: MODEL,
    written_at: new Date().toISOString(),
    classified: classified.map((i) => i.message.id),
    errors: errors.map((e) => e.message_id),
    usage: sumUsage(usages),
    cost_usd: Number(costUsd(sumUsage(usages), MODEL).toFixed(4)),
  };
  writeJsonFile(RUN_PATH, run);
  console.log(
    `wrote ${ITEMS_PATH} and ${RUN_PATH}: ${classified.length} of ${messages.length} captured messages classified under prompt ${hash}; ` +
      `${errors.length} errors` + (errors.length ? ` (see ${ERRORS_PATH})` : ""),
  );
  for (const e of errors) console.log(`  error ${e.message_id}: ${e.reason}`);
  console.log(formatUsage(usages.length, run.usage!, MODEL));
  return errors.length ? 1 : 0;
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
    !r.unresolved_authors
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
}

function printLockedCoverage(sponsorsPath: string, rs: ChannelReport[]): void {
  if (!existsSync(sponsorsPath)) return;
  const sponsors = JSON.parse(readFileSync(sponsorsPath, "utf8")) as Record<string, { stretch?: boolean }>;
  const locked = Object.entries(sponsors).filter(([, v]) => !v.stretch).map(([k]) => k);
  const passed = new Set(rs.filter((r) => r.pass.recall).map((r) => r.channel_name));
  const todo = locked.filter((c) => !passed.has(c));
  console.log(`\nlocked ${locked.length}: ${locked.length - todo.length} pass keyed recall` + (todo.length ? `; not yet: ${todo.join(", ")}` : ""));
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
process.exit(await main(args));
