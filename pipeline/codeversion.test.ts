import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFiles, codeVersion, codeWatcher } from "./codeversion.ts";
import { logTo } from "./runlog.ts";

let root = "";
const repo = () => {
  root = mkdtempSync(join(tmpdir(), "hr-code-"));
  for (const d of ["pipeline", "board"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "pipeline", "hr.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "pipeline", "hr.test.ts"), "test\n");
  writeFileSync(join(root, "board", "index.html"), "<p>board</p>\n");
  writeFileSync(join(root, "board", "live.d.ts"), "declare\n");
  return root;
};
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what code a running board or watch is on (user 2026-11-08)", () => {
  test("the pipeline and board code, not tests or type declarations", () => {
    expect(codeFiles(repo())).toEqual(["board/index.html", "pipeline/hr.ts"]);
  });

  test("a test file changing isn't a code change; a source file changing is, from the first time it's seen", () => {
    let clock = Date.parse("2026-11-14T09:00:00Z");
    const w = codeWatcher(repo(), () => new Date(clock));
    const v = w.state.build;
    expect([w.check(), w.state.changed_at]).toEqual([true, null]);
    writeFileSync(join(root, "pipeline", "hr.test.ts"), "test changed\n");
    expect(w.check()).toBe(true);
    clock += 60_000;
    writeFileSync(join(root, "pipeline", "hr.ts"), "export const a = 2;\n");
    expect([w.check(), w.state.changed_at]).toEqual([false, "2026-11-14T09:01:00.000Z"]);
    clock += 60_000;
    writeFileSync(join(root, "board", "index.html"), "<p>board 2</p>\n");
    expect([w.check(), w.state.changed_at, w.state.build]).toEqual([false, "2026-11-14T09:01:00.000Z", v]);
  });

  test("touched but the same content (a branch switch and back) still matches", () => {
    const w = codeWatcher(repo());
    const f = join(root, "pipeline", "hr.ts");
    writeFileSync(f, "export const a = 2;\n");
    expect(w.check()).toBe(false);
    writeFileSync(f, "export const a = 1;\n");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect([w.check(), w.state.changed_at, codeVersion(root)]).toEqual([true, null, w.state.build]);
  });
});

describe("a long-running command's log", () => {
  test("every console line also lands in the file, timestamped", () => {
    const file = join(repo(), "watch.log");
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const shown: string[] = [];
    console.log = (...a: unknown[]) => shown.push(a.join(" "));
    console.error = (...a: unknown[]) => shown.push(a.join(" "));
    try {
      logTo(file, () => new Date("2026-11-14T09:00:00Z"));
      console.log("\nwatch %s", "9:00:00 AM");
      console.error("pages: %d failed", 2);
    } finally {
      Object.assign(console, saved);
    }
    expect(shown).toEqual(["\nwatch %s 9:00:00 AM", "pages: %d failed 2"]);
    expect(readFileSync(file, "utf8")).toBe("2026-11-14T09:00:00.000Z watch 9:00:00 AM\n2026-11-14T09:00:00.000Z error: pages: 2 failed\n");
  });
});
