// The board's draft list (board/prefill.js), in a DOM: drafts reach the input only through Use all, minus the rows
// skipped, and the module never touches storage.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { BOARD_PAGE } from "./board.ts";

type Item = { key: string; kind: string; name?: string; text?: string; used_for?: string };
let HR: {
  draftItems: (d: unknown) => Item[];
  applyItem: (f: { idea: string; stack: { name: string; used_for: string }[] }, it: Item) => { idea: string; stack: { name: string; used_for: string }[] };
  mountDrafts: (root: unknown, items: Item[], o: { head?: string; onUse: (it: Item) => void; onSkip?: (it: Item) => void; onDone?: () => void }) => void;
};
beforeAll(async () => {
  await import("../board/prefill.js");
  HR = (globalThis as unknown as { HRPrefill: typeof HR }).HRPrefill;
});

const draft = {
  description: { text: "A transfer planner.", sources: [{ source: "README.md:15", quote: "A transfer planner", url: "https://github.com/o/r/blob/s/README.md#L15" }] },
  stack: [
    { name: "Claude API", used_for: "parse transcripts", sources: [{ source: "api/t.py:1", quote: "Transcript parsing", url: "https://github.com/o/r/blob/s/api/t.py#L1" }] },
    { name: "Fetch.ai", used_for: null, sources: [{ source: "agents/requirements.txt:1", quote: "uagents==0.26.1", url: "javascript:alert(1)" }], origin: "sponsor_pass" },
  ],
};

describe("Board drafts from a repo", () => {
  test("nothing reaches the input until Use all; Skip drops one row; Use all hands over every row left, once", () => {
    const { document } = parseHTML('<div id="root"></div>');
    const used: Item[] = [];
    const skipped: Item[] = [];
    let done = 0;
    const root = document.getElementById("root")!;
    const click = (sel: string) => (root.querySelector(sel) as unknown as { click(): void }).click();
    HR.mountDrafts(root, HR.draftItems(draft), { head: "From o/r @ abc1234", onUse: (it) => used.push(it), onSkip: (it) => skipped.push(it), onDone: () => done++ });
    expect(root.querySelectorAll(".dr").length).toBe(3);
    expect(root.querySelectorAll(".dr button.use").length).toBe(0);
    expect(root.querySelector(".useall")!.textContent).toBe("Use all 3");
    expect(used).toEqual([]);
    // Every draft shows its source lines; a non-GitHub link is shown as text, not a link.
    expect([...root.querySelectorAll(".dsrc a")].map((a) => a.getAttribute("href"))).toEqual(["https://github.com/o/r/blob/s/README.md#L15", "https://github.com/o/r/blob/s/api/t.py#L1"]);
    expect(root.querySelector('[data-k="s1"] .dt')!.textContent).toBe("Found in the code; no line says what it does.");
    click('[data-k="d"] button.skip');
    expect([used, skipped.map((x) => x.key), done, root.querySelector(".useall")!.textContent]).toEqual([[], ["d"], 0, "Use all 2"]);
    click(".useall");
    expect([used.map((x) => x.key), done, root.innerHTML]).toEqual([["s0", "s1"], 1, ""]);
  });
  test("skipping every draft uses none", () => {
    const { document } = parseHTML('<div id="root"></div>');
    const root = document.getElementById("root")!;
    const used: Item[] = [];
    let done = 0;
    HR.mountDrafts(root, HR.draftItems({ description: { text: "x", sources: [] }, stack: [] }), { onUse: (it) => used.push(it), onDone: () => done++ });
    expect(root.querySelector(".useall")!.textContent).toBe("Use this draft");
    (root.querySelector("button.skip") as unknown as { click(): void }).click();
    expect([used, done, root.innerHTML]).toEqual([[], 1, ""]);
  });
  test("a used draft fills the form: the description replaces it, a stack item fills its row or a blank one, a typed use stays", () => {
    const items = HR.draftItems(draft);
    let f = { idea: "old", stack: [{ name: "claude api", used_for: "my words" }, { name: "", used_for: "" }] };
    f = HR.applyItem(f, items[0]!);
    f = HR.applyItem(f, items[1]!);
    f = HR.applyItem(f, items[2]!);
    expect(f).toEqual({ idea: "A transfer planner.", stack: [{ name: "claude api", used_for: "my words" }, { name: "Fetch.ai", used_for: "" }] });
  });
  test("draft text is escaped", () => {
    const { document } = parseHTML('<div id="root"></div>');
    const root = document.getElementById("root")!;
    HR.mountDrafts(root, HR.draftItems({ description: { text: "<img src=x onerror=alert(1)>", sources: [] }, stack: [] }), { head: "<b>x</b>", onUse: () => {} });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
  });
  test("the module never reads or writes browser storage, and the page saves the input only on submit or from the event's stored input", () => {
    const src = readFileSync(new URL("../board/prefill.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|store\./);
    const page = readFileSync(BOARD_PAGE, "utf8");
    expect(page).toContain("<!-- prefill.js -->");
    // Chat writes (told.ts): the other saves copy the event's stored input from /plan/meta, never a draft.
    expect(page.match(/store\.set\(planKey\(\)/g)?.length).toBe(3);
    expect(page.match(/P\.input = m\.input;\s*store\.set\(planKey\(\), JSON\.stringify\(P\.input\)\)/g)?.length).toBe(2);
    const submit = page.slice(page.indexOf('$("pf").onsubmit'));
    expect(submit.slice(0, submit.indexOf("\n  };")).includes("store.set(planKey()")).toBe(true);
  });
});
