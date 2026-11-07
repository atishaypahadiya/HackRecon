// The spend guard (user 2026-11-07): estimates printed first, nothing over $1 without --yes, and no client in hr
// that bypasses it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { callOf, CHARS_PER_TOKEN, COST_LIMIT_USD, CostGuard, CostRefused, describeCalls, estimateUsd, guardClient, plannedCall } from "./costguard.ts";

const opus = (input_chars: number, max_tokens = 64000) => ({ model: "claude-opus-5-5", input_chars, max_tokens });

describe("estimate", () => {
  test("input at CHARS_PER_TOKEN uncached plus the whole output budget, at list price", () => {
    // Opus 5.5: $4 in, $20 out per million. 25,536 chars (the Devpost canon request) and a 64,000-token budget.
    expect(estimateUsd([opus(25_536)])).toBeCloseTo((Math.ceil(25_536 / CHARS_PER_TOKEN) * 4 + 64_000 * 20) / 1e6, 10);
    expect(estimateUsd([opus(25_536)])).toBeGreaterThan(COST_LIMIT_USD); // one canon page alone needs --yes
    expect(estimateUsd([{ model: "claude-sonnet-5-5", input_chars: 40_000, max_tokens: 16_000 }])).toBeLessThan(COST_LIMIT_USD);
  });
  test("an unpriced model is never estimated low", () => {
    expect(estimateUsd([{ model: "some-new-model", input_chars: 1, max_tokens: 1 }])).toBe(Infinity);
    expect(describeCalls([{ model: "some-new-model", input_chars: 1, max_tokens: 1 }])).toContain("an unpriced amount");
  });
  test("a request body is measured the way plannedCall measures the same parts", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const body = { model: "claude-opus-5-5", max_tokens: 100, system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "hello" }], output_config: { format: { type: "json_schema", schema } } };
    expect(callOf(body)).toEqual(plannedCall("claude-opus-5-5", "sys", "hello", schema, 100));
  });
});

describe("the guard", () => {
  const run = (yes: boolean) => {
    const lines: string[] = [];
    return { g: new CostGuard("canon", yes, (l) => lines.push(l)), lines };
  };
  test("over $1: the estimate is printed and the run refused before anything is sent; --yes lets it run", () => {
    const a = run(false);
    expect(a.g.preflight([opus(25_536), opus(4_000)])).toBe(false);
    expect(a.lines[0]).toMatch(/^canon: 2 model calls \(claude-opus-5-5 ×2\): estimated at most \$\d+\.\d\d$/);
    expect(a.lines[1]).toContain("rerun with --yes");
    const b = run(true);
    expect(b.g.preflight([opus(25_536)])).toBe(true);
    expect(b.lines).toHaveLength(1);
  });
  test("under $1 runs; nothing to call says so", () => {
    const a = run(false);
    expect(a.g.preflight([{ model: "claude-haiku-5-5", input_chars: 3000, max_tokens: 8000 }])).toBe(true);
    expect(a.g.preflight([])).toBe(true);
    expect(a.lines.at(-1)).toBe("canon: no model calls");
  });

  const fake = (output_tokens: number) => {
    const sent: string[] = [];
    const usage = { input_tokens: 1000, output_tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const client = {
      messages: {
        create: async (p: { model: string }) => (sent.push(p.model), { usage }),
        stream: (p: { model: string }) => (sent.push(p.model), { finalMessage: async () => ({ usage }) }),
      },
    } as unknown as Anthropic;
    return { client, sent };
  };
  const body = (max_tokens: number) => ({ model: "claude-sonnet-5-5", max_tokens, system: "s", messages: [{ role: "user" as const, content: "x" }] });

  test("per call: each call is estimated before it's sent; spend so far plus the next past $1 is refused unsent", async () => {
    const { g, lines } = run(false);
    const { client, sent } = fake(40_000); // $0.40 each at Sonnet's $10 per million out
    const c = guardClient(client, g);
    await c.messages.create(body(16_000));
    await c.messages.create(body(16_000));
    expect(lines[0]).toMatch(/^canon: 1 model call \(claude-sonnet-5-5 ×1\): estimated at most \$0\.16$/);
    expect(g.spentUsd).toBeCloseTo(0.804, 3); // 2 × (1,000 in at $2 + 40,000 out at $10 per million)
    await c.messages.create(body(1_000)); // $0.804 + at most $0.01: still under
    expect(g.spentUsd).toBeCloseTo(1.206, 3); // that call used 40,000 out: spend can pass $1, the next call can't start
    expect(() => c.messages.create(body(1_000))).toThrow(CostRefused);
    expect(sent).toHaveLength(3);
  });
  test("streamed calls count too, and --yes lifts the limit", async () => {
    const { g } = run(true);
    const { client, sent } = fake(80_000);
    const c = guardClient(client, g);
    for (let i = 0; i < 3; i++) await c.messages.stream(body(16_000)).finalMessage();
    expect(g.spentUsd).toBeGreaterThan(COST_LIMIT_USD);
    expect(sent).toHaveLength(3);
  });
});

describe("hr's wiring", () => {
  const hr = readFileSync(join(import.meta.dir, "hr.ts"), "utf8");
  test("the only Anthropic client hr makes is wrapped in a guard", () => {
    expect(hr.match(/new Anthropic\(/g)).toHaveLength(1);
    expect(hr).toContain("return guardClient(new Anthropic({ maxRetries: 2 }), guard);");
    expect(hr).not.toMatch(/anthropicClient\(\)/);
  });
  test("hr sync reaches canon only behind --canon, passing --yes through", () => {
    const sync = hr.slice(hr.indexOf("async function sync("), hr.indexOf("interface FitCached"));
    expect(sync.match(/canon\(\[/g)).toHaveLength(1);
    expect(sync).toContain('if (!values.canon || values.offline || !changed.length) {');
    expect(sync).toContain('return canon(["--judge", ...(values.yes ? ["--yes"] : [])]);');
    expect(sync).not.toMatch(/callChecked|anthropicClient/);
  });
});
