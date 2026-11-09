import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveExportDir } from "./export.ts";

describe("resolveExportDir (audit 2026-11-08: no command reads another event's export by default)", () => {
  test("--export wins, then event.json's slack_export", () => {
    expect(resolveExportDir("/data/iterate", "~/elsewhere")).toBe("/data/iterate");
    expect(resolveExportDir(undefined, "~/projects/hackrecon-data/iterate")).toBe(join(homedir(), "projects/hackrecon-data/iterate"));
    expect(resolveExportDir(undefined, "data/export")).toBe(resolve("data/export"));
  });
  test("neither: an error naming both ways to give one, never a fallback path", () => {
    expect(() => resolveExportDir(undefined, undefined)).toThrow(/pass --export DIR, or set "slack_export"/);
    expect(() => resolveExportDir("", "")).toThrow(/slack_export/);
  });
});
