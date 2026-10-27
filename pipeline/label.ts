// `hr label`: a local page for labeling review/labels.csv one row at a time.
// Blind by construction: this module reads and writes only the labels sheet. It never imports the
// classifier or reads data/, and it doesn't send the `pool` column (a miss_check row may be a
// classifier-flagged one), so nothing the classifier said can reach the page.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HAND_LABELER, LABEL_COLUMNS, labelProblems, readLabels, type LabelColumn, type LabelRow } from "./labels.ts";
import { writeSheet } from "./pool.ts";

/** What the page gets for a row: context to read, plus the label columns it edits. */
export const PAGE_COLUMNS = [
  "message_id",
  "channel",
  "sponsor",
  "posted_at",
  "author",
  "subtype",
  "in_capture",
  "permalink",
  "text",
  ...LABEL_COLUMNS,
  "labeler",
] as const;

export function pageRow(r: LabelRow): Record<string, string> {
  return Object.fromEntries(PAGE_COLUMNS.map((c) => [c, r[c]]));
}

/** Done = is_credit and is_dated both y/n and nothing malformed (the gate's "labeled"). */
export function isDone(r: LabelRow): boolean {
  return /^[yn]$/.test(r.is_credit.trim()) && /^[yn]$/.test(r.is_dated.trim()) && labelProblems(r).length === 0;
}

/** Where to resume: the first row that isn't done (or the end). */
export function resumeIndex(rows: LabelRow[]): number {
  const i = rows.findIndex((r) => !isDone(r));
  return i < 0 ? rows.length : i;
}

export type SaveResult = { ok: true; done: number; total: number } | { ok: false; status: number; problems: string[] };

/** Re-reads the sheet, replaces one row's label columns, validates, and writes atomically.
 *  Re-reading on every save keeps edits made elsewhere (another tab, `hr pool`) in other rows. */
export function saveRow(path: string, messageId: string, values: Record<string, unknown>): SaveResult {
  const unknown = Object.keys(values).filter((k) => !(LABEL_COLUMNS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, status: 400, problems: [`not a label column: ${unknown.join(", ")}`] };
  const rows = readLabels(path);
  const row = rows.find((r) => r.message_id === messageId);
  if (!row) return { ok: false, status: 404, problems: [`${messageId} is not in ${path}`] };
  const next = { ...row };
  for (const c of LABEL_COLUMNS) {
    const v = values[c] ?? "";
    if (typeof v !== "string") return { ok: false, status: 400, problems: [`${c} must be a string`] };
    next[c as LabelColumn] = v.replace(/[\r\n]+/g, " ").trim();
  }
  const problems = [
    ...(/^[yn]$/.test(next.is_credit) && /^[yn]$/.test(next.is_dated) ? [] : ["is_credit and is_dated must both be y or n"]),
    ...labelProblems(next),
  ];
  if (problems.length) return { ok: false, status: 422, problems };
  // A hand save takes the row over from the Opus judge, even when nothing changed: a person checked it.
  Object.assign(row, next, { labeler: HAND_LABELER });
  writeSheet(path, rows);
  return { ok: true, done: rows.filter(isDone).length, total: rows.length };
}

const PAGE = join(import.meta.dir, "label.html");

/** A fetch handler (Bun.serve) for the page and its two API calls. Every API call must carry the
 *  per-run token from the page, so another site open in the browser can't write the sheet. */
export function labelApp(path: string, token = randomBytes(16).toString("hex")) {
  const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
  return {
    token,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(readFileSync(PAGE, "utf8").replace("__HR_TOKEN__", token), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
          },
        });
      }
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if (req.headers.get("x-hr-token") !== token) return json({ problems: ["bad token: reload the page"] }, 403);
      if (req.method === "GET" && url.pathname === "/api/rows") {
        const rows = readLabels(path);
        return json({ rows: rows.map(pageRow), resume: resumeIndex(rows), done: rows.filter(isDone).length });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        let body: { message_id?: unknown; labels?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ problems: ["body is not JSON"] }, 400);
        }
        if (typeof body.message_id !== "string" || typeof body.labels !== "object" || body.labels === null) {
          return json({ problems: ["expected {message_id, labels}"] }, 400);
        }
        const r = saveRow(path, body.message_id, body.labels as Record<string, unknown>);
        return r.ok ? json(r) : json({ problems: r.problems }, r.status);
      }
      return new Response("not found", { status: 404 });
    },
  };
}

