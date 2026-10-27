import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventConfig } from "./classify.ts";
import { messageFromRow, redactedInputs } from "./inputs.ts";
import { COLUMNS, LABEL_COLUMNS, type LabelRow } from "./labels.ts";
import type { Sponsors } from "./pool.ts";
import {
  applyJudge,
  checkLabels,
  costUsd,
  JUDGE_EFFORT,
  JUDGE_MODEL,
  JUDGE_SCHEMA,
  judgeHash,
  judgeOne,
  judgeSystemPrompt,
  rulesSection,
  type Labels,
} from "./prelabel.ts";
import type { Message } from "./schema.ts";

const event: EventConfig = {
  event: "Cal Hacks 13.0",
  timezone: "America/Los_Angeles",
  hacking_start: null,
  hacking_end: null,
  schedule: [{ what: "Final Devpost submissions due", at: "2026-10-25T09:00:00-07:00", source: "https://x" }],
};
const sponsors: Sponsors = { "spons-a": { sponsor: "Acme", aliases: [] } } as unknown as Sponsors;
const msg = (o: Partial<Message> = {}): Message => ({
  id: "C1:1792882762.278609",
  channel_id: "C1",
  channel_name: "spons-a",
  ts: "1792882762.278609",
  author_name: "Grant Tanner",
  text: "Grant Tanner here: $50 credits for every hacker <https://acme.dev/claim>",
  links: ["https://acme.dev/claim"],
  permalink: "https://w/archives/C1/p1792882762278609",
  captured_at: "",
  run_id: "day1",
  ...o,
});
const row = (o: Partial<LabelRow> = {}): LabelRow => ({ ...(Object.fromEntries(COLUMNS.map((c) => [c, ""])) as LabelRow), message_id: "C1:1.1", ...o });
const empty = Object.fromEntries(LABEL_COLUMNS.map((c) => [c, ""])) as Labels;
const credit: Labels = { ...empty, is_credit: "y", is_dated: "n", exclude: "n", credits_in_post: "1", amount_text: "$50 credits", amount_usd_per_person: "50", amount_basis: "per_person" };

const rules = rulesSection(readFileSync(join(import.meta.dir, "../docs/labeling.md"), "utf8"));
const system = judgeSystemPrompt(rules, event);
const hash = judgeHash(system);

describe("judge prompt", () => {
  test("carries the Columns section of docs/labeling.md verbatim, and nothing after it", () => {
    expect(rules.startsWith("## Columns\n")).toBe(true);
    expect(rules).toContain("| `is_credit` | `y` / `n` |");
    expect(rules).not.toContain("## What the gate reads");
    expect(system).toContain(`<rules>\n${rules}\n</rules>`);
    expect(() => rulesSection("# no columns here")).toThrow();
  });

  test("the hash moves with the rules", () => {
    expect(judgeHash(judgeSystemPrompt(rules + "\nextra rule", event))).not.toBe(hash);
  });
});

describe("blind to Haiku", () => {
  test("the judge reads exactly the classifier's redacted input (only the cache key differs)", () => {
    const [haiku] = redactedInputs([msg()], sponsors, "haiku-prompt", [], new Set());
    const [opus] = redactedInputs([msg()], sponsors, hash, [], new Set());
    expect(opus!.user).toBe(haiku!.user);
    expect(opus!.user).not.toContain("Grant Tanner");
    expect(opus!.key).not.toBe(haiku!.key);
  });

  test("no judge code reads classifier output, miss-check membership or the pool column", () => {
    const hr = readFileSync(join(import.meta.dir, "hr.ts"), "utf8");
    const command = hr.slice(hr.indexOf("async function prelabel("), hr.indexOf("\nfunction gate("));
    expect(command.length).toBeGreaterThan(100);
    for (const code of [readFileSync(join(import.meta.dir, "prelabel.ts"), "utf8"), readFileSync(join(import.meta.dir, "inputs.ts"), "utf8"), command]) {
      const noComments = code.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(noComments).not.toMatch(/\b(ITEMS_PATH|CACHE_PATH|RUN_PATH|ERRORS_PATH|POOL_META_PATH|readPoolMeta|toItems|predictions)\b|items\.json|classify_cache|classify_run|pool\.json|\.pool\b/);
    }
  });

  test("a row the capture missed becomes a message from its baseline text", () => {
    const m = messageFromRow(row({ message_id: "C9:1792800000.000100", channel: "spons-a", subtype: "thread_broadcast", text: "claim <https://a.dev/x|here> or <https://b.dev>" }));
    expect(m).toMatchObject({ channel_id: "C9", ts: "1792800000.000100", subtype: "thread_broadcast", links: ["https://a.dev/x", "https://b.dev"] });
  });
});

describe("checkLabels", () => {
  test("accepts a row that passes the sheet's rules; trims and flattens newlines", () => {
    expect(checkLabels({ ...credit, notes: " two\nlines " })).toEqual({ labels: { ...credit, notes: "two lines" } });
  });
  test("rejects what hr pool --check rejects", () => {
    expect(checkLabels({ ...credit, credits_in_post: "" })).toEqual({ error: "is_credit = y needs credits_in_post 1 or more" });
    expect(checkLabels({ ...credit, is_dated: "" })).toEqual({ error: "is_credit and is_dated must be y or n" });
    expect(checkLabels({ ...credit, notes: 3 })).toEqual({ error: "notes is not a string" });
  });
});

describe("judgeOne", () => {
  const usage = { input_tokens: 300, output_tokens: 900, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
  const reply = (text: string, stop_reason = "end_turn") => ({ stop_reason, stop_details: null, usage, content: [{ type: "thinking", thinking: "" }, { type: "text", text }] });
  const fake = (replies: object[]) => {
    const calls: Record<string, unknown>[] = [];
    const client = { messages: { create: async (req: Record<string, unknown>) => (calls.push(req), replies[Math.min(calls.length - 1, replies.length - 1)]) } } as unknown as Anthropic;
    return { client, calls };
  };
  const [input] = redactedInputs([msg()], sponsors, hash, [], new Set());

  test("request: Opus 5.5, effort set, no thinking param, cached system prompt, the redacted input only", async () => {
    const f = fake([reply(JSON.stringify(credit))]);
    const r = await judgeOne(f.client, system, hash, input!, 0);
    expect("entry" in r && r.entry).toMatchObject({ message_id: msg().id, prompt_hash: hash, model: JUDGE_MODEL, labels: credit });
    const req = f.calls[0]!;
    expect(req).toMatchObject({
      model: "claude-opus-5-5",
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: JUDGE_EFFORT, format: { type: "json_schema", schema: JUDGE_SCHEMA } },
      messages: [{ role: "user", content: input!.user }],
    });
    expect("thinking" in req).toBe(false);
  });

  test("output that breaks the sheet's rules is retried; usage adds up over attempts", async () => {
    const f = fake([reply(JSON.stringify({ ...credit, amount_basis: "per_team" })), reply(JSON.stringify(credit))]);
    const r = await judgeOne(f.client, system, hash, input!, 0);
    expect(f.calls.length).toBe(2);
    expect("entry" in r).toBe(true);
    expect(r.usage).toEqual({ input: 600, output: 1800, cache_read: 4000, cache_write: 0 });
  });

  test("a refusal is not retried; repeated bad output ends with the last reason", async () => {
    const refused = fake([reply("", "refusal")]);
    expect(await judgeOne(refused.client, system, hash, input!, 0)).toMatchObject({ error: "refusal" });
    expect(refused.calls.length).toBe(1);
    const bad = fake([reply("not json")]);
    expect(await judgeOne(bad.client, system, hash, input!, 0)).toMatchObject({ error: "output is not JSON" });
    expect(bad.calls.length).toBe(3);
  });

  test("cost at list price: $4 in, $20 out, $0.20 cache read, $5 cache write per MTok", () => {
    expect(costUsd({ input: 1e6, output: 1e6, cache_read: 1e6, cache_write: 1e6 })).toBeCloseTo(29.2, 6);
  });
});

describe("applyJudge", () => {
  test("Opus answers get labeler opus-5-5; hand rows are kept; stale Opus rows with no answer are cleared", () => {
    const hand = row({ message_id: "C1:1", ...credit, labeler: "hand" });
    const legacy = row({ message_id: "C1:2", is_credit: "n", is_dated: "n" }); // labeled before the column existed
    const fresh = row({ message_id: "C1:3" });
    const stale = row({ message_id: "C1:4", ...credit, labeler: "opus-5-5" });
    const answers = new Map<string, Labels>([
      ["C1:1", { ...credit, amount_usd_per_person: "999" }],
      ["C1:2", credit],
      ["C1:3", credit],
    ]);
    const r = applyJudge([hand, legacy, fresh, stale], answers);
    expect(r.rows[0]).toEqual(hand);
    expect(r.rows[1]).toEqual(legacy);
    expect(r.rows[2]).toEqual({ ...fresh, ...credit, labeler: "opus-5-5" });
    expect(r.rows[3]).toEqual({ ...stale, ...empty, labeler: "" });
    expect([r.opus, r.hand, r.unlabeled]).toEqual([1, 2, 1]);
    const all = applyJudge([hand, legacy, fresh], answers, true);
    expect(all.rows.map((x) => x.labeler)).toEqual(["opus-5-5", "opus-5-5", "opus-5-5"]);
    expect(all.rows[0]!.amount_usd_per_person).toBe("999");
  });
});
