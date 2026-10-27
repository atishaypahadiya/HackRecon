#!/usr/bin/env bun
// hr: HackRecon pipeline CLI. Subcommands land here as tasks ship (compare first).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareChannel, AUTHOR_MIN, RECALL_MIN, TIME_MAX_S, type ChannelReport } from "./compare.ts";
import { DEFAULT_EXPORT_DIR, loadExport } from "./export.ts";
import { parseCaptureFile, type CaptureFile } from "./schema.ts";

/** slackdump export finished 2026-10-27 03:17 America/Los_Angeles (design doc, D2). */
const EXPORT_CUTOFF = "2026-10-27T03:17:00-07:00";

const USAGE = `usage:
  bun run hr compare [capture.json | dir ...] [--export DIR] [--json OUT] [--cutoff ISO]
      Checks each captured channel against the slackdump export: keyed recall by ts
      (pass >= ${RECALL_MIN * 100}%), author match (pass >= ${AUTHOR_MIN * 100}%), time (<= ${TIME_MAX_S}s, recorded only).
      Default input: captures/. Exit 1 if any channel's keyed recall fails.`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "compare") return compare(rest);
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
    let cap: CaptureFile;
    try {
      cap = parseCaptureFile(JSON.parse(readFileSync(f, "utf8")), f);
    } catch (e) {
      console.error(`skip ${f}: ${(e as Error).message}`);
      continue;
    }
    reports.push(compareChannel(cap, exp, cutoff));
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

function captureFiles(paths: string[]): string[] {
  return paths.flatMap((p) => {
    if (!existsSync(p)) return [];
    if (!statSync(p).isDirectory()) return [p];
    return readdirSync(p)
      .filter((f) => /^[CG][A-Z0-9]+\.json$/.test(f))
      .sort()
      .map((f) => join(p, f));
  });
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
    `${r.extras.length}`,
    r.stop_reason,
    `${r.duration_s}s${r.pass.time ? "" : " (>2min)"}`,
    `${r.system_rows_skipped}/${r.export_top_level.system}`,
  ]);
  const head = ["channel", "real found", "keyed recall", "author match", "bot", "extra", "stop", "time", "system skip/export"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  rows.forEach((r) => console.log(line(r)));
}

function printDetails(r: ChannelReport): void {
  if (!r.missed.length && !r.extras.length && !r.author.mismatches.length && !r.author.unverifiable.length && !r.unresolved_authors) return;
  console.log(`\n## ${r.channel_name} (${r.channel_id})`);
  if (r.missed.length) {
    console.log(`missed ${r.missed.length}:`);
    for (const m of r.missed) console.log(`  ${m.permalink}  ${m.author}: ${m.text}`);
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

process.exit(main(process.argv.slice(2)));
