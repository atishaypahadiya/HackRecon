import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelApp, PAGE_COLUMNS, resumeIndex } from "./label.ts";
import { COLUMNS, readLabels, type LabelRow } from "./labels.ts";
import { writeSheet } from "./pool.ts";

const row = (n: number, o: Partial<LabelRow> = {}): LabelRow => ({
  ...(Object.fromEntries(COLUMNS.map((c) => [c, ""])) as LabelRow),
  message_id: `C1:179280000${n}.000000`,
  channel: "spons-a",
  sponsor: "A",
  posted_at: "2026-10-24T15:59:22-07:00",
  author: "Ada",
  pool: n === 3 ? "miss_check" : "keyword",
  in_capture: "y",
  permalink: `https://w/archives/C1/p179280000${n}000000`,
  text: `post ${n}: $50 credits <https://a.dev/claim>`,
  ...o,
});

function setup(rows = [row(1, { is_credit: "n", is_dated: "n", exclude: "n" }), row(2), row(3)]) {
  const path = join(mkdtempSync(join(tmpdir(), "hr-label-")), "labels.csv");
  writeSheet(path, rows);
  const app = labelApp(path, "tok");
  const call = (p: string, body?: unknown, token = "tok") =>
    app.fetch(
      new Request(`http://127.0.0.1${p}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-hr-token": token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { path, call };
}

const credit = { is_credit: "y", is_dated: "n", exclude: "n", credits_in_post: "1", amount_text: "$50 credits", amount_usd_per_person: "50", amount_basis: "per_person" };

describe("hr label: blind by construction", () => {
  test("the page gets context and label columns only: no pool, nothing from the classifier", async () => {
    const { call } = setup();
    const body = (await (await call("/api/rows")).json()) as { rows: Record<string, string>[] };
    for (const r of body.rows) expect(Object.keys(r).sort()).toEqual([...PAGE_COLUMNS].sort());
    expect(PAGE_COLUMNS as readonly string[]).not.toContain("pool");
  });

  test("the server can't reach the classifier: classify.ts isn't in its import graph, no code names its files", () => {
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      for (const m of src.matchAll(/from "\.\/([\w.-]+\.ts)"/g)) walk(m[1]!);
    };
    walk("label.ts");
    expect(seen.has("classify.ts")).toBe(false);
    for (const f of ["label.ts", "label.html"]) {
      const code = readFileSync(join(import.meta.dir, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code).not.toMatch(/items\.json|classify_cache|classify_run|classify_errors|"data\//);
    }
  });

  test("API calls need the page's token; the page carries it and a CSP", async () => {
    const { call } = setup();
    expect((await call("/api/rows", undefined, "wrong")).status).toBe(403);
    const page = await call("/");
    expect(await page.text()).toContain('content="tok"');
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("hr label: saving and resuming", () => {
  test("resumes at the first row that isn't labeled", async () => {
    const { call } = setup();
    expect(((await (await call("/api/rows")).json()) as { resume: number }).resume).toBe(1);
    expect(resumeIndex([])).toBe(0);
  });

  test("a save writes that row's label columns only, then resume moves on", async () => {
    const { path, call } = setup();
    const before = readLabels(path);
    const res = await call("/api/save", { message_id: before[1]!.message_id, labels: credit });
    expect(await res.json()).toEqual({ ok: true, done: 2, total: 3 });
    const after = readLabels(path);
    expect(after[1]).toEqual({ ...before[1]!, ...credit, deadline_iso: "", deadline_status: "", window_end: "", notes: "" });
    expect([after[0], after[2]]).toEqual([before[0], before[2]]);
    expect(((await (await call("/api/rows")).json()) as { resume: number }).resume).toBe(2);
  });

  test("edits made elsewhere to other rows survive a save (sheet re-read on every save)", async () => {
    const { path, call } = setup();
    const rows = readLabels(path);
    rows[2]!.notes = "edited in a spreadsheet";
    writeSheet(path, rows);
    await call("/api/save", { message_id: rows[1]!.message_id, labels: credit });
    expect(readLabels(path)[2]!.notes).toBe("edited in a spreadsheet");
  });

  test("an invalid label is refused with its problems and the file is unchanged", async () => {
    const { path, call } = setup();
    const before = readFileSync(path, "utf8");
    const id = readLabels(path)[1]!.message_id;
    const bad = await call("/api/save", { message_id: id, labels: { ...credit, amount_basis: "per_team" } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { problems: string[] }).problems).toEqual(["amount_usd_per_person is set only when amount_basis = per_person"]);
    const half = await call("/api/save", { message_id: id, labels: { is_credit: "n" } });
    expect(((await half.json()) as { problems: string[] }).problems).toContain("is_credit and is_dated must both be y or n");
    expect((await call("/api/save", { message_id: id, labels: { pool: "keyword", is_credit: "n", is_dated: "n" } })).status).toBe(400);
    expect((await call("/api/save", { message_id: "C9:1.1", labels: credit })).status).toBe(404);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a dated row with only a claim window saves with status none", async () => {
    const { path, call } = setup();
    const id = readLabels(path)[1]!.message_id;
    const res = await call("/api/save", {
      message_id: id,
      labels: { ...credit, is_dated: "y", window_end: "2026-10-24T19:00-07:00", deadline_status: "none", notes: "date-only" },
    });
    expect(res.status).toBe(200);
    expect(readLabels(path)[1]).toMatchObject({ window_end: "2026-10-24T19:00-07:00", deadline_status: "none" });
  });
});
