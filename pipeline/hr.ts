#!/usr/bin/env bun
// hr: HackRecon pipeline CLI. Subcommands land here as tasks ship (compare first).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { captureFiles, loadCapture, type LoadedCapture } from "./captures.ts";
import {
  buildInput,
  CACHE_PATH,
  classifyOne,
  ERRORS_PATH,
  ITEMS_PATH,
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
} from "./classify.ts";
import { compareChannel, AUTHOR_MIN, RECALL_MIN, TIME_MAX_S, type ChannelReport } from "./compare.ts";
import { DEFAULT_EXPORT_DIR, loadExport } from "./export.ts";
import { labelProblems, LABELS_PATH, POOL_META_PATH, readLabels } from "./labels.ts";
import { buildRows, candidatesFromExport, DEFAULT_SEED, KEYWORD_RE, lockedChannels, RANDOM_N, readSponsors, selectPool, writeSheet } from "./pool.ts";
import { buildNameList, compileRedactor } from "./redact.ts";
import { buildOrganizers, loadOrganizerIds, ORGANIZERS_PATH, posterRole } from "./roles.ts";
import { buildRun, MESSAGES_PATH, readMessages, readRuns, RUNS_PATH, saveRun } from "./runs.ts";

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
  bun run hr pool [--seed N] [--export DIR] [--check]
      Writes the day-2 labeling sheet ${LABELS_PATH}: every keyword hit in the locked channels'
      baseline (top-level, plus replies also sent to the channel) and ${RANDOM_N} random top-level
      non-hits. Re-running keeps every label column. --check only validates the labels entered so far.
      Labeling rules: docs/labeling.md
  bun run hr organizers [--export DIR]
      One-time (A5): writes ${ORGANIZERS_PATH} from the baseline's users.json (admins, owners,
      CAL HACKS tags, director/exec/organizer/logistics titles). Used for poster_role.
  bun run hr classify [--labeled-only] [--dry-run] [--limit N] [--concurrency N] [--show MESSAGE_ID]
      Classifies captured messages with ${MODEL} (redacted text only). --labeled-only: just the messages
      in ${LABELS_PATH}. Cached in ${CACHE_PATH}; failures in ${ERRORS_PATH}; items in ${ITEMS_PATH}.
      --dry-run builds every request and prints one, with no API call. Needs ANTHROPIC_API_KEY (.env).`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "compare") return compare(rest);
  if (cmd === "record-run") return recordRun(rest);
  if (cmd === "pool") return pool(rest);
  if (cmd === "organizers") return organizers(rest);
  if (cmd === "classify") return classify(rest);
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
      sponsors: { type: "string", default: "config/sponsors.json" },
    },
  });
  const files = captureFiles(positionals.length ? positionals : ["captures"]);
  if (!files.length) {
    console.error("No capture files found. Pass paths, e.g. bun run hr compare ~/Downloads/C0C7TCNCR1N.json");
    return 2;
  }
  const exp = loadExport(values.export);
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
    writeFileSync(values.json, JSON.stringify(reports, null, 2));
    console.log(`\nwrote ${values.json}`);
  }
  return reports.some((r) => !r.pass.recall) ? 1 : 0;
}

function recordRun(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { id: { type: "string" }, sponsors: { type: "string", default: "config/sponsors.json" } },
  });
  if (!values.id) {
    console.error("record-run needs --id, e.g. --id day1-2026-10-27");
    return 2;
  }
  const files = captureFiles(positionals.length ? positionals : ["captures"]);
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
      sponsors: { type: "string", default: "config/sponsors.json" },
      check: { type: "boolean", default: false },
    },
  });
  const existing = readLabels();
  if (values.check) return printLabelProblems(existing) ? 1 : 0;

  const sponsors = readSponsors(values.sponsors!);
  const channels = lockedChannels(sponsors);
  const cands = candidatesFromExport(loadExport(values.export), channels);
  const seed = Number(values.seed);
  const sel = selectPool(cands, seed, RANDOM_N, new Set(existing.filter((r) => r.pool === "random").map((r) => r.message_id)));
  const messages = readMessages();
  const captured = new Map(messages.map((m) => [m.id, m]));
  const workspace = new URL(messages[0]!.permalink).origin;
  const { rows, orphans } = buildRows(sel, { sponsors, captured, workspace, existing });
  writeSheet(LABELS_PATH, [...rows, ...orphans]);

  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  const counts = {
    keyword_top_level: count((r) => r.pool === "keyword" && r.subtype === ""),
    keyword_broadcast: count((r) => r.pool === "keyword" && r.subtype === "thread_broadcast"),
    random: count((r) => r.pool === "random"),
    in_capture: count((r) => r.in_capture === "y"),
    not_in_capture: count((r) => r.in_capture === "n"),
    kept_outside_pool: orphans.length,
  };
  const meta = {
    built_at: new Date().toISOString(),
    runs: readRuns().map((r) => r.run_id),
    channels,
    keyword_regex: KEYWORD_RE.source,
    keyword_flags: KEYWORD_RE.flags,
    seed,
    random_n: RANDOM_N,
    counts,
  };
  writeFileSync(POOL_META_PATH, JSON.stringify(meta, null, 2) + "\n");
  console.log(
    `wrote ${LABELS_PATH}: ${rows.length + orphans.length} rows from ${channels.length} channels: ` +
      `${counts.keyword_top_level} top-level keyword hits, ${counts.keyword_broadcast} broadcast keyword hits ` +
      `(subtype thread_broadcast), ${counts.random} random (seed ${seed}); ${counts.in_capture} in the capture, ${counts.not_in_capture} not`,
  );
  for (const r of orphans) console.log(`kept (labeled or flagged, no longer in the pool): ${r.message_id} ${r.pool}`);
  console.log(`wrote ${POOL_META_PATH}`);
  printLabelProblems([...rows, ...orphans]);
  return 0;
}

function organizers(args: string[]): number {
  const { values } = parseArgs({ args, options: { export: { type: "string", default: DEFAULT_EXPORT_DIR } } });
  const orgs = buildOrganizers(loadExport(values.export));
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
      sponsors: { type: "string", default: "config/sponsors.json" },
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

  const redact = compileRedactor(buildNameList(new Set(messages.filter((m) => m.author_kind !== "bot").map((m) => m.author_name)), sponsors));
  const organizerIds = loadOrganizerIds();
  const system = systemPrompt(readEvent());
  const hash = promptHash(system);
  const inputs = selected.map((m) =>
    buildInput(m, { role: posterRole(m, sponsors[m.channel_name], organizerIds, Object.values(sponsors)), sponsor: sponsors[m.channel_name]?.sponsor ?? "", redact, promptHash: hash }),
  );
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
  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let i: ClassifyInput | undefined; (i = queue.shift()); ) {
      const r = await classifyOne(client, system, hash, i);
      if ("entry" in r) cache[i.key] = r.entry;
      else errors.push(r.error);
      if (++done % 20 === 0) writeJsonFile(CACHE_PATH, cache), console.log(`  ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
  writeJsonFile(CACHE_PATH, cache);
  writeJsonFile(ERRORS_PATH, errors);

  const items = inputs.flatMap((i) => (cache[i.key] ? toItems(cache[i.key]!, sponsors) : []));
  writeJsonFile(ITEMS_PATH, items);
  const flagged = (k: (it: (typeof items)[number]) => boolean) => new Set(items.filter(k).map((it) => it.message_id)).size;
  console.log(
    `wrote ${ITEMS_PATH}: ${items.length} items from ${inputs.length - errors.length} messages; ` +
      `credit in ${flagged((it) => it.kind === "credit")} messages, dated in ${flagged((it) => it.deadline_status !== "none")}; ` +
      `${errors.length} errors` + (errors.length ? ` (see ${ERRORS_PATH})` : ""),
  );
  for (const e of errors) console.log(`  error ${e.message_id}: ${e.reason}`);
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

process.exit(await main(process.argv.slice(2)));
