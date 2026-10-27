// Minimal RFC 4180 CSV for the hand-edited sheets in review/ (labels.csv, later credits.csv).
// Written with a UTF-8 BOM so spreadsheet apps keep emoji and accents intact.

const BOM = "﻿";

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v);
  return BOM + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function parseCsv(s: string): string[][] {
  if (s.startsWith(BOM)) s = s.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c !== '"') cur += c;
      else if (s[i + 1] === '"') (cur += '"'), i++;
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cur), (cur = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cur), rows.push(row), (row = []), (cur = "");
    } else cur += c;
  }
  if (quoted) throw new Error("CSV ends inside a quoted cell");
  if (cur !== "" || row.length) row.push(cur), rows.push(row);
  return rows;
}

/** Rows as objects keyed by the header row. Throws if a required column is missing. */
export function readTable(s: string, required: readonly string[] = []): Record<string, string>[] {
  const [head, ...body] = parseCsv(s);
  if (!head) return [];
  const missing = required.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`missing columns: ${missing.join(", ")}`);
  return body.filter((r) => r.some((v) => v !== "")).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
