// Loads extension capture files and applies pipeline/rows.ts, so captures made before the parser
// learned those rules are read exactly like new ones. Idempotent on new captures.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { broadcastParent, nonPostMessage, type NonPost } from "./rows.ts";
import { parseCaptureFile, type CaptureFile, type Message, type Ts } from "./schema.ts";

export interface LoadedCapture {
  file: string;
  capture: CaptureFile;
  /** Non-posts removed on load (only present in captures made before the parser skipped them). */
  dropped: { ts: Ts; reason: NonPost }[];
}

export function captureFiles(paths: string[]): string[] {
  return paths.flatMap((p) => {
    if (!existsSync(p)) return [];
    if (!statSync(p).isDirectory()) return [p];
    return readdirSync(p)
      .filter((f) => /^[CG][A-Z0-9]+\.json$/.test(f))
      .sort()
      .map((f) => join(p, f));
  });
}

/** Step 1's `<channel_id>.threads.json` files in the given paths (directories are listed, files kept). */
export function threadCaptureFiles(paths: string[]): string[] {
  return paths.flatMap((p) => {
    if (!existsSync(p)) return [];
    if (!statSync(p).isDirectory()) return /\.threads\.json$/.test(p) ? [p] : [];
    return readdirSync(p)
      .filter((f) => /^[CG][A-Z0-9]+\.threads\.json$/.test(f))
      .sort()
      .map((f) => join(p, f));
  });
}

export function loadCapture(file: string): LoadedCapture {
  const capture = parseCaptureFile(JSON.parse(readFileSync(file, "utf8")), file);
  return { file, ...normalizeCapture(capture) };
}

export function normalizeCapture(capture: CaptureFile): { capture: CaptureFile; dropped: LoadedCapture["dropped"] } {
  const dropped: LoadedCapture["dropped"] = [];
  const messages: Message[] = [];
  for (const m of capture.messages) {
    const reason = nonPostMessage(m);
    if (reason) {
      dropped.push({ ts: m.ts, reason });
      continue;
    }
    const parent = m.thread_ts ?? broadcastParent(m.permalink, m.ts);
    messages.push(parent && !m.subtype ? { ...m, thread_ts: parent, subtype: "thread_broadcast" } : m);
  }
  const skipped = { ...capture.non_posts_skipped };
  for (const d of dropped) skipped[d.reason] = (skipped[d.reason] ?? 0) + 1;
  const unresolved = new Set(dropped.map((d) => d.ts));
  return {
    capture: {
      ...capture,
      messages,
      system_rows_skipped: capture.system_rows_skipped + dropped.length,
      non_posts_skipped: skipped,
      unresolved_authors: capture.unresolved_authors.filter((t) => !unresolved.has(t)),
    },
    dropped,
  };
}
