import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { buildInput, checkItems, classifyOne, classifyPlan, eventTimezone, promptHash, readEvent, systemPrompt, toItems, type Cache, type CacheEntry, type EventConfig, type RawItem } from "./classify.ts";
import type { Sponsors } from "./pool.ts";
import type { Message } from "./schema.ts";

const event: EventConfig = {
  event: "Cal Hacks 13.0",
  timezone: "America/Los_Angeles",
  hacking_start: null,
  hacking_end: null,
  schedule: [{ what: "Final Devpost submissions due", at: "2026-10-25T09:00:00-07:00", source: "https://x" }],
};
const msg: Message = {
  id: "C0C72S4D3LL:1792882762.278609",
  channel_id: "C0C72S4D3LL",
  channel_name: "spons-cartesia",
  ts: "1792882762.278609",
  thread_ts: "1792867132.187939",
  subtype: "thread_broadcast",
  author_name: "Grant Tanner",
  text: "More details on credits: Use this link <https://cartesia.ai/claim>",
  links: ["https://cartesia.ai/claim"],
  permalink: "https://w/archives/C0C72S4D3LL/p1792882762278609",
  captured_at: "",
  run_id: "day1",
};
const noRedact = (t: string) => ({ text: t, replaced: 0 });
const rules = "## Columns\n\n| `is_dated` | `y` / `n` | Start times of talks or food are not limits. |";
const hash = promptHash(systemPrompt(event, rules));
const input = (o: Partial<{ role: "organizer" | "sponsor-side" | "other"; hash: string; text: string }> = {}) =>
  buildInput({ ...msg, text: o.text ?? msg.text }, { role: o.role ?? "other", sponsor: "Cartesia", redact: noRedact, promptHash: o.hash ?? hash, tz: "America/Los_Angeles" });

describe("cache key (D9)", () => {
  test("same input, same key", () => expect(input().key).toBe(input().key));
  test("poster_role changes the key (day-3 recompute reclassifies, D17)", () => {
    expect(input({ role: "sponsor-side" }).key).not.toBe(input({ role: "other" }).key);
  });
  test("prompt (schedule) and redacted text change the key", () => {
    const other = promptHash(systemPrompt({ ...event, hacking_start: "2026-10-23T22:00:00-07:00" }, rules));
    expect(other).not.toBe(hash);
    expect(promptHash(systemPrompt(event, rules + " edited"))).not.toBe(hash);
    expect(input({ hash: other }).key).not.toBe(input().key);
    expect(input({ text: "different" }).key).not.toBe(input().key);
  });
  test("key starts with the message id; input carries time, channel, sponsor, role, broadcast note", () => {
    const i = input();
    expect(i.key.startsWith(`${msg.id}:`)).toBe(true);
    expect(i.user).toContain("posted_at: 2026-10-24T15:59:22-07:00 (Saturday)");
    expect(i.user).toContain("channel sponsor: Cartesia");
    expect(i.user).toContain("poster_role: other");
    expect(i.user).toContain("also sent to the channel");
    expect(i.user).not.toContain("Grant Tanner");
  });
});

const item = (o: Partial<RawItem> = {}): RawItem => ({
  kind: "credit",
  sponsor: "Cartesia",
  amount_text: "$50 in credits",
  amount_value: 50,
  amount_unit: "USD",
  amount_basis: "per_person",
  amount_usd_per_person: 50,
  deadline_iso: null,
  deadline_status: "none",
  event_start_iso: null,
  urls: ["https://cartesia.ai/claim"],
  ...o,
});

describe("classify prompt", () => {
  test("carries the labeling rules verbatim and keeps start times out of deadlines", () => {
    const sys = systemPrompt(event, rules);
    expect(sys).toContain(`<rules>\n${rules}\n</rules>`);
    expect(sys).toContain("Start times of talks, workshops, food or other events are not limits: they go in event_start_iso, never here.");
  });
  test("the zone's offset is the event's own, at its first known time (audit 2026-11-08)", () => {
    const at = (iso: string) => ({ ...event, timezone: "America/Los_Angeles", hacking_start: null, schedule: [{ what: "Kickoff", at: iso }] }) as EventConfig;
    expect(systemPrompt(at("2026-10-24T10:00:00-07:00"), rules)).toContain("(timezone America/Los_Angeles, UTC-07:00 during the event)");
    expect(systemPrompt(at("2026-11-14T10:00:00-08:00"), rules)).toContain("(timezone America/Los_Angeles, UTC-08:00 during the event)");
    expect(systemPrompt({ ...at("2026-11-14T10:00:00-05:00"), timezone: "America/New_York" }, rules)).toContain("UTC-05:00 during the event");
  });
});

describe("no zone in event.json (audit 2026-11-08)", () => {
  test("UTC, never Los Angeles or the machine's zone; no event.json at all is UTC too", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-tz-"));
    try {
      writeFileSync(join(dir, "event.json"), JSON.stringify({ event: "Somewhere Hacks", schedule: [] }));
      expect(readEvent(join(dir, "event.json")).timezone).toBe("UTC");
      expect(eventTimezone(join(dir, "event.json"))).toBe("UTC");
      expect(eventTimezone(join(dir, "missing.json"))).toBe("UTC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkItems (rules the JSON schema can't express)", () => {
  test("accepts a priced per-person credit; drops URLs that aren't in the post", () => {
    expect(checkItems({ items: [item({ urls: ["https://cartesia.ai/claim", "https://made.up/"] })] }, msg.links)).toEqual({ items: [item()] });
  });
  test("amount_usd_per_person only for USD per person (no invented numbers)", () => {
    expect(checkItems({ items: [item({ amount_basis: "per_team" })] }, msg.links)).toEqual({ error: "items[0]: amount_usd_per_person set with USD/per_team" });
  });
  test("USD per person requires amount_usd_per_person", () => {
    expect(checkItems({ items: [item({ amount_usd_per_person: null })] }, msg.links)).toEqual({
      error: "items[0]: amount_unit USD and amount_basis per_person, so amount_usd_per_person is required (the stated number)",
    });
    expect("items" in checkItems({ items: [item({ amount_usd_per_person: null, amount_basis: "unknown" })] }, msg.links)).toBe(true);
  });
  test("event_start_iso needs an offset; a start time alone leaves the item undated", () => {
    expect("error" in checkItems({ items: [item({ kind: "workshop", event_start_iso: "2026-10-24T18:00:00" })] }, [])).toBe(true);
    const ok = checkItems({ items: [item({ kind: "workshop", event_start_iso: "2026-10-24T18:00:00-07:00" })] }, []);
    expect("items" in ok && ok.items[0]!.deadline_status).toBe("none");
  });
  test("deadline_iso needs an offset and a resolved status, and vice versa", () => {
    expect("error" in checkItems({ items: [item({ deadline_iso: "2026-10-25T09:00:00", deadline_status: "explicit" })] }, [])).toBe(true);
    expect("error" in checkItems({ items: [item({ deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "unresolved" })] }, [])).toBe(true);
    expect("error" in checkItems({ items: [item({ deadline_status: "resolved_relative" })] }, [])).toBe(true);
    expect("items" in checkItems({ items: [item({ deadline_iso: "2026-10-25T09:00:00-07:00", deadline_status: "resolved_relative" })] }, [])).toBe(true);
  });
});

describe("toItems", () => {
  test("normalizes sponsor aliases and leaves unset optionals out", () => {
    const sponsors: Sponsors = { "spons-microsoft": { sponsor: "Microsoft", kind: "sponsor", aliases: ["Azure"] } };
    const [it] = toItems(
      { message_id: msg.id, prompt_hash: hash, model: "m", classified_at: "t", items: [item({ sponsor: "azure", amount_usd_per_person: null, amount_basis: "pool" })] },
      sponsors,
    );
    expect(it).toMatchObject({ message_id: msg.id, item_index: 0, sponsor: "Microsoft", offer_key: "" });
    expect("amount_usd_per_person" in it!).toBe(false);
    expect("deadline_iso" in it!).toBe(false);
  });
});

describe("classifyOne retries (D10)", () => {
  const fake = (replies: object[]) => {
    const reqs: { messages: unknown[] }[] = [];
    const client = {
      messages: { create: async (req: { messages: unknown[] }) => (reqs.push(req), replies[Math.min(reqs.length - 1, replies.length - 1)]) },
    } as unknown as Anthropic;
    return { client, calls: () => reqs.length, reqs };
  };
  const reply = (text: string, stop_reason = "end_turn") => ({
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
  });

  test("an invalid output is retried, then the valid one is cached", async () => {
    const f = fake([reply("not json"), reply(JSON.stringify({ items: [item()] }))]);
    const r = await classifyOne(f.client, "sys", hash, input(), 0);
    expect(f.calls()).toBe(2);
    expect("entry" in r && r.entry.items).toEqual([item()]);
    expect(r.usage).toEqual({ input: 2000, output: 400, cache_read: 0, cache_write: 0 });
  });

  test("a validation error goes back with the model's own output, thinking included", async () => {
    const bad = reply(JSON.stringify({ items: [item({ amount_usd_per_person: null })] }));
    const f = fake([bad, reply(JSON.stringify({ items: [item()] }))]);
    const r = await classifyOne(f.client, "sys", hash, input(), 0);
    expect("entry" in r).toBe(true);
    expect(f.reqs[0]!.messages).toHaveLength(1);
    expect(f.reqs[1]!.messages).toEqual([
      { role: "user", content: input().user },
      { role: "assistant", content: bad.content },
      {
        role: "user",
        content: "That output failed validation: items[0]: amount_unit USD and amount_basis per_person, so amount_usd_per_person is required (the stated number). Return the corrected JSON for the same post.",
      },
    ]);
  });

  test("a truncated reply is retried fresh, not sent back", async () => {
    const f = fake([reply("{", "max_tokens"), reply(JSON.stringify({ items: [item()] }))]);
    await classifyOne(f.client, "sys", hash, input(), 0);
    expect(f.reqs[1]!.messages).toHaveLength(1);
  });

  test("after 2 retries the message goes to errors with the last reason", async () => {
    const f = fake([reply(JSON.stringify({ items: [item({ amount_basis: "pool" })] }))]);
    const r = await classifyOne(f.client, "sys", hash, input(), 0);
    expect(f.calls()).toBe(3);
    expect("error" in r && r.error).toMatchObject({ message_id: msg.id, attempts: 3, reason: "items[0]: amount_usd_per_person set with USD/pool" });
  });

  test("a refusal is not retried", async () => {
    const f = fake([reply("", "refusal")]);
    const r = await classifyOne(f.client, "sys", hash, input(), 0);
    expect(f.calls()).toBe(1);
    expect("error" in r && r.error.reason).toBe("refusal");
  });
});

describe("classify --new", () => {
  const entry = (message_id: string, prompt_hash: string, classified_at: string): CacheEntry => ({ message_id, prompt_hash, model: "m", items: [], classified_at });
  const cache: Cache = {
    "old:a": entry("a", "old", "2026-11-01T00:00:00Z"),
    "older:a": entry("a", "older", "2026-10-01T00:00:00Z"),
    "new:b": entry("b", "new", "2026-11-02T00:00:00Z"),
  };
  const inputs = ["a", "b", "c"].map((id) => ({ key: `new:${id}`, message: { id } }));
  test("normally everything without an answer under this prompt is sent", () => {
    const p = classifyPlan(inputs, cache, false);
    expect(p.todo.map((i) => i.message.id)).toEqual(["a", "c"]);
    expect(p.answer(inputs[0]!)).toBeUndefined();
  });
  test("--new sends only posts never classified; the rest keep their newest answer", () => {
    const p = classifyPlan(inputs, cache, true);
    expect(p.todo.map((i) => i.message.id)).toEqual(["c"]);
    expect(p.answer(inputs[0]!)?.prompt_hash).toBe("old");
    expect(p.answer(inputs[1]!)?.prompt_hash).toBe("new");
  });
});
