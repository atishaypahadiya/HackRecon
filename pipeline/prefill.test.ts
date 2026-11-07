import { describe, expect, test } from "bun:test";
import { checkPrefill, dependencies, fileHeader, prefillFacts, productHits, productOf, withProducts, type PrefillFact, type Product } from "./prefill.ts";
import { builtWithReport, pairedDiffCI, pairedVsBaseline, scoreBuiltWith, tagMatch } from "./prefilleval.ts";

const link = (p: string, n: number) => `https://github.com/o/r/blob/s/${p}#L${n}`;
const repo = { url: "https://github.com/o/r", dir: "/nonexistent", sha: "s" };

describe("Prefill facts", () => {
  test("dependencies from package.json, requirements.txt and pyproject.toml, each with its declaring line", () => {
    const texts = new Map([
      ["web/package.json", '{\n  "dependencies": {\n    "react": "^19"\n  },\n  "devDependencies": { "vite": "^7" }\n}'],
      ["api/requirements.txt", "# comment\nfastapi>=0.1\napify-client==1.0\n"],
      ["agent/pyproject.toml", '[project]\ndependencies = [\n  "anthropic>=2.3.0",\n]\n[tool.poetry.dependencies]\npython = "^3.12"\nhttpx = "*"\n'],
      ["node_modules/x/package.json", '{"dependencies":{"evil":"1"}}'],
    ]);
    const deps = dependencies(texts, link);
    expect(deps.map((d) => [d.name, d.fact.source])).toEqual([
      ["react", "web/package.json:3"],
      ["vite", "web/package.json:5"],
      ["fastapi", "api/requirements.txt:2"],
      ["apify-client", "api/requirements.txt:3"],
      ["anthropic", "agent/pyproject.toml:3"],
      ["httpx", "agent/pyproject.toml:7"],
    ]);
    expect(deps.find((d) => d.name === "apify-client")!.imports).toContain("apify_client");
  });
  test("a file's opening comment or docstring, and where each dependency is imported", () => {
    expect(fileHeader(['"""Campus scans on Apify (PROJECT.md §8.3).', '"""', "import x"])).toEqual({ line: 1, text: "Campus scans on Apify (PROJECT.md §8.3)." });
    expect(fileHeader(['"use client";', "// One Droid run: start a session,", "// hand it the job.", "import x"])).toEqual({ line: 2, text: "One Droid run: start a session, hand it the job." });
    expect(fileHeader(["import x", "// later"])).toBeNull();
    const texts = new Map([
      ["README.md", "# App\n![badge](x)\nWe help students plan terms.\n"],
      ["requirements.txt", "apify-client\n"],
      ["api/scan.py", '"""Campus scans on Apify."""\nfrom apify_client import ApifyClient\n'],
      ["tests/test_scan.py", "from apify_client import ApifyClient\n"],
    ]);
    const facts = prefillFacts(repo, texts);
    expect(facts.map((f) => [f.id, f.kind, f.source, f.text])).toEqual([
      ["F1", "readme", "README.md:1", "# App"],
      ["F2", "readme", "README.md:3", "We help students plan terms."],
      ["F3", "tree", "file tree", "file types: .md 1, .txt 1, .py 1"],
      ["F4", "manifest", "requirements.txt:1", "apify-client"],
      ["F5", "code", "api/scan.py:2", "from apify_client import ApifyClient"],
      ["F6", "code", "api/scan.py:1", "Campus scans on Apify."],
    ]);
  });
});

describe("Prefill check", () => {
  const facts: PrefillFact[] = [
    { id: "F1", kind: "readme", source: "README.md:3", url: link("README.md", 3), text: "We help students plan terms." },
    { id: "F2", kind: "manifest", source: "requirements.txt:1", url: link("requirements.txt", 1), text: "apify-client" },
    { id: "F3", kind: "code", source: "api/scan.py:1", url: link("api/scan.py", 1), text: "Campus scans on Apify." },
  ];
  const ok = { description: { text: "A term planner for students.", facts: [{ fact_id: "F1", quote: "plan terms" }] }, stack: [{ name: "Apify", used_for: "scan campus sites", facts: [{ fact_id: "F2", quote: "apify-client" }, { fact_id: "F3", quote: "Campus scans on Apify" }] }] };
  const err = (patch: object) => {
    const r = checkPrefill({ ...ok, ...patch }, facts);
    return "error" in r ? r.error : "";
  };
  test("accepted: every draft carries the lines it came from, with links at the commit", () => {
    const r = checkPrefill(ok, facts);
    if ("error" in r) throw new Error(r.error);
    expect(r.stack[0]).toEqual({ name: "Apify", used_for: "scan campus sites", sources: [{ source: "requirements.txt:1", quote: "apify-client", url: link("requirements.txt", 1) }, { source: "api/scan.py:1", quote: "Campus scans on Apify", url: link("api/scan.py", 1) }] });
  });
  test("refused: a draft with no source line, a quote not in its line, an unknown id, a used-for from a dependency line alone", () => {
    expect(err({ stack: [{ name: "Apify", used_for: "", facts: [] }] })).toContain("cite 1 to 3");
    expect(err({ description: { text: "x", facts: [] } })).toContain("cite 1 to 4");
    expect(err({ stack: [{ name: "Apify", used_for: "", facts: [{ fact_id: "F3", quote: "Campus scans on Algolia" }] }] })).toContain("not in F3");
    expect(err({ stack: [{ name: "Apify", used_for: "", facts: [{ fact_id: "F9", quote: "x" }] }] })).toContain("not a fact id");
    expect(err({ stack: [{ name: "Apify", used_for: "scrape course catalogs", facts: [{ fact_id: "F2", quote: "apify-client" }] }] })).toContain("must cite a README or code fact");
    expect(err({ stack: [ok.stack[0], ok.stack[0]] })).toContain("listed twice");
  });
  test("no used-for stays empty, not invented", () => {
    const r = checkPrefill({ ...ok, stack: [{ name: "Apify", used_for: "", facts: [{ fact_id: "F2", quote: "apify-client" }] }] }, facts);
    if ("error" in r) throw new Error(r.error);
    expect(r.stack[0]!.used_for).toBeNull();
  });
});

describe("Prefill eval scoring", () => {
  test("Built With tags match drafted names by name, then by words; no aliases", () => {
    expect(tagMatch("next.js", "Next.js")).toBe("same");
    expect(tagMatch("nextjs", "Next.js")).toBe("same");
    expect(tagMatch("claude", "Claude API")).toBe("contains");
    expect(tagMatch("anthropic", "Claude API")).toBeNull();
    expect(tagMatch("c", "C++")).toBeNull();
    const s = scoreBuiltWith("p", ["python", "claude", "anthropic", "react"], ["Python", "Claude API", "React", "Vite"]);
    expect([s.same, s.contains, s.missed, s.extra]).toEqual([["python", "react"], ["claude"], ["anthropic"], ["Vite"]]);
    const r = builtWithReport([s, scoreBuiltWith("q", [], ["Go"])]);
    expect([r.projects, r.tags, r.strict.hits, r.loose.hits, r.mean_project_loose]).toEqual([1, 4, 2, 3, 75]);
  });
  test("run C is paired with the baseline's run B on the same pair keys", () => {
    const base = [
      { key: "a|T1", A3: false, B3: true, A5: false, B5: true },
      { key: "b|T1", A3: false, B3: false, A5: false, B5: true },
      { key: "c|T2", A3: false, B3: false, A5: false, B5: false },
    ];
    const C = new Map([
      ["a|T1", { C3: false, C5: true }],
      ["b|T1", { C3: true, C5: true }],
      ["z|T9", { C3: true, C5: true }],
    ]);
    const r = pairedVsBaseline(base, C);
    expect(r.pairs).toBe(2);
    expect(r.not_in_baseline).toEqual(["z|T9"]);
    expect(r.paired.map((p) => [p.k, p.B.hits, p.C.hits, p.lost, p.gained])).toEqual([[3, 1, 1, 1, 1], [5, 2, 2, 0, 0]]);
  });
});

const PRODUCTS: Product[] = [
  { product: "Claude API", sponsor: "Anthropic", names: ["Claude API", "Claude", "Anthropic"], packages: ["anthropic", "@anthropic-ai/sdk"], hosts: ["api.anthropic.com"], code_terms: ["anthropic"] },
  { product: "Fetch.ai", sponsor: "Fetch.ai", names: ["Fetch.ai", "uAgents"], packages: ["uagents"], hosts: ["agentverse.ai"], code_terms: ["uagents"] },
  { product: "Elasticsearch", sponsor: "Elastic", names: ["Elasticsearch", "Elastic"], packages: ["@elastic/elasticsearch", "elasticsearch"], hosts: [], code_terms: ["elasticsearch"] },
  { product: "Factory Droid SDK", sponsor: "Factory", names: ["Factory Droid SDK"], packages: ["@factory/droid-sdk"], hosts: [], code_terms: [] },
  { product: "Vultr", sponsor: "MLH", names: ["Vultr"], packages: [], hosts: ["api.vultr.com"], code_terms: ["vultr"] },
];

describe("Sponsor-product pass", () => {
  const texts = new Map([
    ["agents/requirements.txt", "uagents==0.26.1\n"],
    ["web/search.ts", 'import { Client } from "@elastic/elasticsearch";\n'],
    ["api/llm.py", "import anthropic\nfrom . import util\n"],
    ["api/other.py", '"""Data from Vultr\'s metadata."""\nfrom . import x\n'],
    ["web/icons.ts", "import jira from './apps/jira.svg';\n"],
    ["frontend/src/mock/booths.ts", 'const B = ["Vultr", "Elasticsearch"];\n'],
    ["README.md", "We deploy on Vultr and use Factory Droid.\n"],
    [".claude/settings.json", '{"note": "anthropic"}\n'],
  ]);
  test("dependency, import, host and term hits with file:line; README, mock data, tool settings and relative imports don't count", () => {
    const hits = productHits(repo, texts, PRODUCTS);
    expect(Object.fromEntries([...hits].map(([p, hs]) => [p, hs.map((h) => `${h.how} ${h.source}`)]))).toEqual({
      "Claude API": ["import api/llm.py:1"],
      "Fetch.ai": ["dependency agents/requirements.txt:1"],
      Elasticsearch: ["import web/search.ts:1"],
      Vultr: ["term api/other.py:1"],
    });
    expect(hits.get("Fetch.ai")![0]!.url).toBe("https://github.com/o/r/blob/s/agents/requirements.txt#L1");
  });
  test("found products the draft lacks are added with their lines and no used-for; ones it has are left alone", () => {
    const draft = { description: { text: "x", sources: [] }, stack: [{ name: "Anthropic", used_for: "answer questions", sources: [] }] };
    const w = withProducts(draft, productHits(repo, texts, PRODUCTS), PRODUCTS);
    expect(w.added).toEqual(["Fetch.ai", "Elasticsearch", "Vultr"]);
    expect(w.draft.stack.map((s) => [s.name, s.used_for, s.origin ?? "model"])).toEqual([["Anthropic", "answer questions", "model"], ["Fetch.ai", null, "sponsor_pass"], ["Elasticsearch", null, "sponsor_pass"], ["Vultr", null, "sponsor_pass"]]);
  });
  test("the alias table maps Built With tags and drafted names to one product", () => {
    expect(["anthropic", "Claude", "@anthropic-ai/sdk", "uagents", "elastic", "react"].map((n) => productOf(n, PRODUCTS))).toEqual(["Claude API", "Claude API", "Claude API", "Fetch.ai", "Elasticsearch", null]);
    const s = scoreBuiltWith("p", ["anthropic", "fetch.ai", "react"], ["Claude API", "uAgents", "Python"], PRODUCTS);
    expect([s.alias, s.missed, s.extra]).toEqual([["anthropic", "fetch.ai"], ["react"], ["Python"]]);
    expect(builtWithReport([s]).aliased.hits).toBe(2);
  });
  test("the paired 95% interval (Agresti–Min) for C − B", () => {
    const r = pairedDiffCI(6, 3, 81);
    expect(r.est).toBeCloseTo((100 * -3) / 81, 6);
    expect(r.lo).toBeCloseTo(-11.04, 1);
    expect(r.hi).toBeCloseTo(3.81, 1);
    expect(pairedDiffCI(0, 0, 50).lo).toBeLessThan(0);
  });
});
