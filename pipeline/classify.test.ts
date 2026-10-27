import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { buildInput, checkItems, classifyOne, promptHash, systemPrompt, toItems, type EventConfig, type RawItem } from "./classify.ts";
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
const hash = promptHash(systemPrompt(event));
const input = (o: Partial<{ role: "organizer" | "sponsor-side" | "other"; hash: string; text: string }> = {}) =>
  buildInput({ ...msg, text: o.text ?? msg.text }, { role: o.role ?? "other", sponsor: "Cartesia", redact: noRedact, promptHash: o.hash ?? hash });

describe("cache key (D9)", () => {
  test("same input, same key", () => expect(input().key).toBe(input().key));
  test("poster_role changes the key (day-3 recompute reclassifies, D17)", () => {
    expect(input({ role: "sponsor-side" }).key).not.toBe(input({ role: "other" }).key);
  });
  test("prompt (schedule) and redacted text change the key", () => {
    const other = promptHash(systemPrompt({ ...event, hacking_start: "2026-10-23T22:00:00-07:00" }));
    expect(other).not.toBe(hash);
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
  urls: ["https://cartesia.ai/claim"],
  ...o,
});

describe("checkItems (rules the JSON schema can't express)", () => {
  test("accepts a priced per-person credit; drops URLs that aren't in the post", () => {
    expect(checkItems({ items: [item({ urls: ["https://cartesia.ai/claim", "https://made.up/"] })] }, msg.links)).toEqual({ items: [item()] });
  });
  test("amount_usd_per_person only for USD per person (no invented numbers)", () => {
    expect(checkItems({ items: [item({ amount_basis: "per_team" })] }, msg.links)).toEqual({ error: "items[0]: amount_usd_per_person set with USD/per_team" });
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
    let n = 0;
    const client = { messages: { create: async () => replies[Math.min(n++, replies.length - 1)] } } as unknown as Anthropic;
    return { client, calls: () => n };
  };
  const reply = (text: string, stop_reason = "end_turn") => ({ stop_reason, stop_details: null, content: [{ type: "text", text }] });

  test("an invalid output is retried, then the valid one is cached", async () => {
    const f = fake([reply("not json"), reply(JSON.stringify({ items: [item()] }))]);
    const r = await classifyOne(f.client, "sys", hash, input(), 0);
    expect(f.calls()).toBe(2);
    expect("entry" in r && r.entry.items).toEqual([item()]);
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
