import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventConfig } from "./classify.ts";
import { checkGroups, foreignWords, withLabelAmounts, GROUP_EFFORT, GROUP_MODEL, GROUP_SCHEMA, groupHash, groupOffers, groupRequest, groupSystemPrompt, inputHash, type Offer } from "./group.ts";
import { redactedInputs } from "./inputs.ts";
import { rulesSection } from "./labels.ts";
import type { Sponsors } from "./pool.ts";
import { opusGroups } from "./preview.ts";
import type { Message } from "./schema.ts";

const event: EventConfig = { event: "Cal Hacks 13.0", timezone: "America/Los_Angeles", hacking_start: null, hacking_end: null, schedule: [] };
const rules = rulesSection(readFileSync(join(import.meta.dir, "../docs/labeling.md"), "utf8"));
const system = groupSystemPrompt(rules, event);
const sponsors = { "spons-a": { sponsor: "Acme", aliases: [] } } as unknown as Sponsors;
const msg = (ts: string, text: string, links: string[] = []): Message => ({
  id: `C1:${ts}`, channel_id: "C1", channel_name: "spons-a", ts, author_name: "Ann Lee", text, links, permalink: `https://w/p${ts}`, captured_at: "", run_id: "r",
});
const offer = (o: Partial<Offer>): Offer => ({
  sponsor: "Acme", title: "API credits", amount_text: "$50 credits", amount_usd_per_person: "50", amount_basis: "per_person",
  limit_iso: "", limit_status: "none", claim_url: "", promo_code: "", claim_how: "", value_short: "$50 credits", claim_short: "", posts: ["C1:2.0"], reason: "one post", ...o,
});

describe("group prompt and request", () => {
  test("carries the labeling rules verbatim; the hash moves with them", () => {
    expect(system).toContain(`<rules>\n${rules}\n</rules>`);
    expect(groupHash(groupSystemPrompt(rules + "\nx", event))).not.toBe(groupHash(system));
  });

  test("one request, posts oldest first, each under its id, names redacted; the input hash moves with the posts", () => {
    const inputs = redactedInputs([msg("2.0", "Ann Lee here: $50 credits"), msg("1.0", "reminder")], sponsors, groupHash(system), [], new Set());
    const req = groupRequest(inputs);
    expect(req.indexOf('id="C1:1.0"')).toBeLessThan(req.indexOf('id="C1:2.0"'));
    expect(req).not.toContain("Ann Lee");
    expect(inputHash(system, req)).not.toBe(inputHash(system, req + " "));
  });

  test("blind to Haiku: no grouping code reads classifier output", () => {
    const hr = readFileSync(join(import.meta.dir, "hr.ts"), "utf8");
    const code = [readFileSync(join(import.meta.dir, "group.ts"), "utf8"), hr.slice(hr.indexOf("function groupInput("), hr.indexOf("\nfunction receiptPreview("))];
    expect(code[1]!.length).toBeGreaterThan(100);
    for (const c of code) {
      const noComments = c.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(noComments).not.toMatch(/\b(ITEMS_PATH|CACHE_PATH|RUN_PATH|toItems|readPoolMeta)\b|items\.json|classify_cache|classify_run/);
    }
  });
});

describe("checkGroups", () => {
  const ids = ["C1:1.0", "C1:2.0", "C1:3.0"];
  const links = new Set(["https://acme.dev/claim"]);
  test("accepts every post accounted for; sorts each offer's posts oldest first", () => {
    const r = checkGroups({ offers: [offer({ posts: ["C1:2.0", "C1:1.0"], claim_url: "https://acme.dev/claim" })], not_offers: [{ post: "C1:3.0", reason: "a prize track" }] }, ids, links);
    expect("offers" in r && r.offers[0]!.posts).toEqual(["C1:1.0", "C1:2.0"]);
  });
  test("rejects missing, unknown or double-booked posts, invented numbers and links", () => {
    const e = (v: unknown) => ("error" in checkGroups(v, ids, links) ? (checkGroups(v, ids, links) as { error: string }).error : "");
    expect(e({ offers: [offer({ posts: ["C1:1.0", "C1:2.0"] })], not_offers: [] })).toContain("C1:3.0");
    expect(e({ offers: [offer({ posts: ["C1:9.0"] })], not_offers: [] })).toContain("unknown post");
    expect(e({ offers: [offer({ posts: ids })], not_offers: [{ post: "C1:1.0", reason: "x" }] })).toContain("in an offer and in not_offers");
    expect(e({ offers: [offer({ posts: ids, amount_usd_per_person: "about 50" })], not_offers: [] })).toContain("plain number");
    expect(e({ offers: [offer({ posts: ids, amount_basis: "pool" })], not_offers: [] })).toContain("amount_basis");
    expect(e({ offers: [offer({ posts: ids, limit_status: "explicit" })], not_offers: [] })).toContain("no limit_iso");
    expect(e({ offers: [offer({ posts: ids, claim_url: "https://made.up/x" })], not_offers: [] })).toContain("claim_url");
  });
  test("value_short and claim_short: short, and only in the offer's own posts' words", () => {
    const texts = new Map([["C1:1.0", "Get $50 credits! Scan the QR code."], ["C1:2.0", "reminder"], ["C1:3.0", "Free pizza"]]);
    const e = (o: Partial<Offer>) => {
      const r = checkGroups({ offers: [offer({ posts: ["C1:1.0", "C1:2.0"], ...o })], not_offers: [{ post: "C1:3.0", reason: "x" }] }, ids, links, texts);
      return "error" in r ? r.error : "";
    };
    expect(e({ claim_short: "Scan QR code" })).toBe("");
    expect(e({ value_short: "$50 free credits" })).toContain("free");
    expect(e({ value_short: "" })).toContain("1 to 4 words");
    expect(e({ claim_short: "Scan the QR code" })).toContain("at most 3 words");
    expect(foreignWords("Free Pizza!", ["free pizza"])).toEqual([]);
  });
  test("a post can belong to two offers", () => {
    expect("offers" in checkGroups({ offers: [offer({ posts: ids }), offer({ title: "Pro plan", amount_usd_per_person: "", amount_basis: "unknown", posts: ["C1:1.0"] })], not_offers: [] }, ids)).toBe(true);
  });
});

describe("withLabelAmounts", () => {
  test("the earliest source post's labeled per-person amount wins; the grouping pass's own amount never does", () => {
    const L = (usd: string) => ({ amount_usd_per_person: usd, amount_basis: usd ? "per_person" : "" });
    const labels = new Map([["C1:1.0", L("")], ["C1:2.0", L("20")], ["C1:3.0", L("25")]]);
    const [a, b] = withLabelAmounts(
      [offer({ amount_usd_per_person: "", amount_basis: "unknown", posts: ["C1:1.0", "C1:2.0", "C1:3.0"] }), offer({ posts: ["C1:1.0"] })],
      labels,
    );
    expect(a).toMatchObject({ amount_usd_per_person: "20", amount_basis: "per_person" });
    expect(b).toMatchObject({ amount_usd_per_person: "", amount_basis: "unknown" });
  });
});

describe("groupOffers", () => {
  const usage = { input_tokens: 1000, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const reply = (v: unknown) => ({ stop_reason: "end_turn", usage, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(v) }] });
  const fake = (replies: object[]) => {
    const calls: Record<string, any>[] = [];
    const client = { messages: { stream: (req: Record<string, unknown>) => (calls.push(structuredClone(req)), { finalMessage: async () => replies[Math.min(calls.length - 1, replies.length - 1)] }) } } as unknown as Anthropic;
    return { client, calls };
  };
  test("streams one Opus request; a failed check goes back to the model with the error; usage adds up", async () => {
    const bad = { offers: [offer({ posts: ["C1:2.0"] })], not_offers: [] };
    const good = { offers: [offer({ posts: ["C1:1.0", "C1:2.0"] })], not_offers: [] };
    const f = fake([reply(bad), reply(good)]);
    const r = await groupOffers(f.client, system, "REQ", ["C1:1.0", "C1:2.0"], new Set());
    expect("offers" in r && r.offers).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ model: GROUP_MODEL, system: [{ text: system, cache_control: { type: "ephemeral" } }], output_config: { effort: GROUP_EFFORT, format: { schema: GROUP_SCHEMA } }, messages: [{ role: "user", content: "REQ" }] });
    expect("thinking" in f.calls[0]!).toBe(false);
    expect(f.calls[1]!.messages.at(-1).content).toContain("C1:1.0");
    expect(r.usage).toEqual({ input: 2000, output: 6000, cache_read: 0, cache_write: 0 });
  });
});

describe("opusGroups", () => {
  test("one member per source post; only a stated per-person amount is priced", () => {
    const m = new Map([["C1:1.0", msg("1.0", "x")]]);
    const [g] = opusGroups([offer({ posts: ["C1:1.0", "C1:2.0"], limit_iso: "2026-10-24T19:00:00-07:00", limit_status: "explicit" })], m, new Map([["C1:2.0", "https://w/row"]]));
    expect(g).toMatchObject({ sponsor: "Acme", title: "API credits", usd_per_person: 50, has_limit: true });
    expect(g!.offers.map((o) => o.permalink)).toEqual(["https://w/p1.0", "https://w/row"]);
    const [u] = opusGroups([offer({ amount_usd_per_person: "", amount_basis: "unknown", limit_status: "unresolved" })], m);
    expect(u!.usd_per_person).toBeUndefined();
    expect(u!.limit_unresolved_only).toBe(true);
  });
});
