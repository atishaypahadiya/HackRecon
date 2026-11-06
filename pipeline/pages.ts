// Page snapshots on disk (v2 D3, D11, D12, OV13): loading, the normalized-text hash, and the `hr pages`
// report. A snapshot's hash covers its text with volatile counters stripped ("3 days left", "1,234
// participants"), so a recapture of an unchanged page is a no-op and only a real edit triggers re-extraction.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePageSnapshot, type PageSnapshot } from "./schema.ts";

const VOLATILE = [
  /\b(?:about\s+)?\d[\d,]*\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+(?:left|ago|remaining)\b/gi,
  /\b\d[\d,]*\s+(?:participants?|registrants?|hackers?|projects?|submissions?|people|likes?|followers?|views?|comments?)\b/gi,
];

/** The snapshot's text in reading order, one block per line, with volatile counters removed. */
export function normalizedText(s: PageSnapshot): string {
  return s.blocks
    .map((b) => VOLATILE.reduce((t, re) => t.replace(re, "<n>"), b.text))
    .join("\n");
}

export function snapshotHash(s: PageSnapshot): string {
  return createHash("sha256").update(normalizedText(s)).digest("hex").slice(0, 16);
}

export interface LoadedPage {
  file: string;
  snapshot: PageSnapshot;
  hash: string;
}

/** Every *.page.json in `dir`, validated, oldest first. Unreadable files are reported, not dropped silently. */
export function loadPages(dir: string): { pages: LoadedPage[]; errors: string[] } {
  if (!existsSync(dir)) return { pages: [], errors: [] };
  const pages: LoadedPage[] = [];
  const errors: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".page.json")).sort()) {
    const file = join(dir, f);
    try {
      const snapshot = parsePageSnapshot(JSON.parse(readFileSync(file, "utf8")), f);
      pages.push({ file, snapshot, hash: snapshotHash(snapshot) });
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  pages.sort((a, b) => a.snapshot.captured_at.localeCompare(b.snapshot.captured_at));
  return { pages, errors };
}

/** Comparable page address: no query, fragment or trailing slash. */
export function pageKey(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.pathname.replace(/\/+$/, "")}`;
}

/** The latest snapshot per page, and which configured canon/schedule pages have none. */
export function pageCoverage(pages: LoadedPage[], wanted: string[]) {
  const latest = new Map<string, LoadedPage>();
  for (const p of pages) latest.set(pageKey(p.snapshot.url), p);
  const missing = wanted.filter((u) => !latest.has(pageKey(u)));
  return { latest, missing };
}

/** D12: a logged-in page's text (access "authenticated", or no flag) is redacted before any model sees it, with
 *  the v1 redactor (poster names) plus emails and phone numbers. Quotes are then checked against this text. */
export function redactSnapshot(s: PageSnapshot, redact: (text: string) => { text: string; replaced: number }): { snapshot: PageSnapshot; replaced: number } {
  let replaced = 0;
  const scrub = (t: string) => {
    const r = redact(t);
    replaced += r.replaced;
    return r.text
      .replace(/[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g, () => (replaced++, "[email]"))
      .replace(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g, () => (replaced++, "[phone]"));
  };
  const blocks = s.blocks.map((b) => ({ ...b, text: scrub(b.text), path: b.path.map(scrub) }));
  return { snapshot: { ...s, blocks, links: s.links.map((l) => ({ ...l, text: scrub(l.text) })) }, replaced };
}

/** D12: only an explicit "public" skips redaction; the domain never decides. */
export const needsRedaction = (s: PageSnapshot) => s.access !== "public";
