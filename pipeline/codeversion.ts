// What code a long-running process is on (user 2026-11-08). A board left running from Oct 28 kept serving the new
// page from disk, which asked for routes the old server didn't have, and Plan said "Couldn't load this event's canon".
// Now the board and watch fingerprint their own code at start and compare it each minute: `hr board` exits when it
// changes (restart it knowingly), `hr watch` keeps its alerts going on the code it started with and says so, on the
// board and in its log.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["pipeline", "board"];
const isCode = (f: string) => /\.(ts|js|html)$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");

/** The code files a running board or watch is built from, relative to the repo, in a fixed order. */
export function codeFiles(root = ROOT): string[] {
  return DIRS.flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).filter(isCode).map((f) => `${d}/${f}`) : [])).sort();
}

/** A short fingerprint of those files' contents. */
export function codeVersion(root = ROOT): string {
  const h = createHash("sha256");
  for (const f of codeFiles(root)) h.update(f).update("\0").update(readFileSync(join(root, f))).update("\0");
  return h.digest("hex").slice(0, 12);
}

export interface CodeState {
  /** The fingerprint this process started with. */
  build: string;
  started_at: string;
  /** When the code on disk was first seen to differ from `build`; null while it matches. */
  changed_at: string | null;
}

/** Fingerprints the code now; `check()` re-reads it only when a file's size or time changed, and reports whether
 *  the code on disk still matches what this process started with. A change back to the same content matches again. */
export function codeWatcher(root = ROOT, now = () => new Date()): { state: CodeState; check(): boolean } {
  const stamp = () => codeFiles(root).map((f) => { const s = statSync(join(root, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join("|");
  let seen = stamp();
  const state: CodeState = { build: codeVersion(root), started_at: now().toISOString(), changed_at: null };
  return {
    state,
    check() {
      const s = stamp();
      if (s !== seen) {
        seen = s;
        const same = codeVersion(root) === state.build;
        state.changed_at = same ? null : (state.changed_at ?? now().toISOString());
      }
      return state.changed_at === null;
    },
  };
}
