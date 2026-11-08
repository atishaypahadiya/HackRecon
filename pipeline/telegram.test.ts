// Telegram (user 2026-11-07): the user's own chat only, four Bot API methods, the token never in an error; the
// channel is pluggable (HACKRECON_CHANNEL), with iMessage and WhatsApp named but not built.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { channelFromEnv, isChannel, whyNoChannel } from "./channels.ts";
import { TELEGRAM_METHODS, TelegramApi, TelegramChannel, TelegramRefused, telegramConfig, telegramSenders, type TelegramFetch } from "./telegram.ts";

const TOKEN = "7123456789:AAFakeTokenForTests_abcdefghijklmnopq";
const ME = "555111222";
type Call = { method: string; params: Record<string, unknown> };

function fake(reply: (method: string, params: Record<string, unknown>) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const f: TelegramFetch = async (url, init) => {
    const method = url.split("/").at(-1)!;
    const params = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, params });
    const r = reply(method, params);
    return { status: r.status ?? 200, json: async () => r.body };
  };
  return { calls, sleeps, deps: { fetch: f, sleep: async (ms: number) => void sleeps.push(ms) } };
}
const ok = (result: unknown) => ({ body: { ok: true, result } });
const msg = (update_id: number, from: number, text: string | undefined, type = "private", chat = from) => ({ update_id, message: { message_id: update_id * 10, date: 1_763_136_000, text, from: { id: from, first_name: "A" }, chat: { id: chat, type } } });

describe("config and channel choice", () => {
  test("telegram needs a BotFather token and a private chat id; names only when missing", () => {
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: ME })).toEqual({ token: TOKEN, chatId: ME });
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: "nope", TELEGRAM_CHAT_ID: "-100123" })).toEqual({ missing: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] });
  });
  test("HACKRECON_CHANNEL picks the channel: telegram by default, sms one-way, imessage and whatsapp not built", () => {
    const tg = channelFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: ME });
    expect(isChannel(tg) && [tg.kind, !!tg.receive]).toEqual(["telegram", true]);
    const sms = channelFromEnv({ HACKRECON_CHANNEL: "sms", TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_AUTH_TOKEN: "f".repeat(32), TWILIO_FROM: "+15005550006", HACKRECON_SMS_TO: "+14155550123" });
    expect(isChannel(sms) && [sms.kind, !!sms.receive]).toEqual(["sms", false]);
    expect(whyNoChannel(channelFromEnv({}) as never)).toBe("telegram not set up (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID missing or malformed in .env)");
    expect(whyNoChannel(channelFromEnv({ HACKRECON_CHANNEL: "whatsapp" }) as never)).toBe("whatsapp isn't built yet; use telegram or sms");
  });
});

describe("TelegramApi", () => {
  test("only the four allowlisted methods, and the source calls no other", () => {
    const { deps } = fake(() => ok(true));
    expect(new TelegramApi(TOKEN, deps).call("deleteMessage" as never, {})).rejects.toBeInstanceOf(TelegramRefused);
    const src = readFileSync(join(import.meta.dir, "telegram.ts"), "utf8");
    const used = [...src.matchAll(/call(?:<[^>]*>)?\("(\w+)"/g)].map((m) => m[1]);
    expect(used.every((m) => (TELEGRAM_METHODS as readonly string[]).includes(m!))).toBe(true);
    expect(() => new TelegramApi("x", deps)).toThrow(TelegramRefused);
  });
  test("errors never carry the token, even when the transport echoes the URL; 429 waits retry_after", async () => {
    const leak: TelegramFetch = async (url) => Promise.reject(new Error(`fetch failed: ${url}`));
    const e = await new TelegramApi(TOKEN, { fetch: leak, sleep: async () => {} }).call("getMe", {}).catch((x: Error) => x.message);
    expect(e).toBe("Telegram getMe: connection: fetch failed: https://api.telegram.org/bot[token]/getMe");
    let n = 0;
    const { deps, sleeps } = fake(() => (n++ ? ok({ username: "hr_bot" }) : { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 3 } } }));
    expect(await new TelegramApi(TOKEN, deps).call("getMe", {})).toEqual({ username: "hr_bot" });
    expect(sleeps).toEqual([3000]);
    const bad = fake(() => ({ status: 401, body: { ok: false, description: `Unauthorized ${TOKEN}` } }));
    expect(await new TelegramApi(TOKEN, bad.deps).call("getMe", {}).catch((x: Error) => x.message)).toBe("Telegram getMe: 401 unauthorized: the bot token is wrong or was revoked in BotFather");
  });
});

describe("TelegramChannel", () => {
  test("sends plain text to the user's chat only, links unexpanded, capped at Telegram's limit", async () => {
    const { calls, deps } = fake(() => ok({ message_id: 42 }));
    const ch = new TelegramChannel({ token: TOKEN, chatId: ME }, deps);
    expect(await ch.send("x".repeat(5000))).toEqual({ id: "42" });
    expect(calls[0]).toMatchObject({ method: "sendMessage", params: { chat_id: ME, link_preview_options: { is_disabled: true } } });
    expect((calls[0]!.params.text as string).length).toBe(4096);
    expect(calls[0]!.params.parse_mode).toBeUndefined();
  });
  test("receives only the user's own private text messages; others are dropped unread; the cursor moves past all", async () => {
    const updates = [msg(1, Number(ME), "what's next?"), msg(2, 999, "hi bot"), msg(3, Number(ME), "in a group", "group", -100), msg(4, Number(ME), undefined), msg(5, Number(ME), "and judging?")];
    const { calls, deps } = fake(() => ok(updates));
    const r = await new TelegramChannel({ token: TOKEN, chatId: ME }, deps).receive("1", 25);
    expect(r.messages.map((m) => [m.id, m.text])).toEqual([["10", "what's next?"], ["50", "and judging?"]]);
    expect([r.ignored, r.cursor]).toEqual([3, "6"]);
    expect(calls[0]!.params).toEqual({ offset: 1, timeout: 25, allowed_updates: ["message"] });
    expect(JSON.stringify(r)).not.toContain("hi bot");
  });
  test("chat-id helper lists private senders without confirming their messages", async () => {
    const { calls, deps } = fake((m) => (m === "getMe" ? ok({ username: "hr_bot" }) : ok([msg(7, Number(ME), "/start"), msg(8, 1, "x", "group", -5)])));
    expect(await telegramSenders(new TelegramApi(TOKEN, deps))).toEqual({ bot: "hr_bot", senders: [{ chat_id: ME, name: "A" }] });
    expect(calls[1]!.params.offset).toBeUndefined();
  });
});
