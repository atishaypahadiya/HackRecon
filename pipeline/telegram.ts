// Telegram (user 2026-11-07, for Nov 14): a bot the user made with BotFather, talking to the user's own chat only.
// Alerts go out with sendMessage; the user's replies come back through getUpdates (long polling, no webhook, no
// server). Messages from any other chat are dropped unread and never answered. Four Bot API methods, nothing else.
// The token is in every request URL, so it is scrubbed from every error. Setup: docs/discord-bot.md.
import type { Inbound, MessageChannel } from "./channels.ts";

export const TELEGRAM_API = "https://api.telegram.org";
/** Every Bot API method HackRecon may call. */
export const TELEGRAM_METHODS = ["getMe", "getUpdates", "sendMessage", "sendChatAction"] as const;
export type TelegramMethod = (typeof TELEGRAM_METHODS)[number];
/** Telegram's own cap on one message. */
export const TELEGRAM_MAX_CHARS = 4096;
const MAX_TRIES = 3;

export type TelegramFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
export interface TelegramDeps {
  fetch: TelegramFetch;
  sleep(ms: number): Promise<void>;
}

export class TelegramRefused extends Error {}

const TOKEN_RE = /^\d{5,}:[\w-]{30,}$/;

export function telegramConfig(env: Record<string, string | undefined>): { token: string; chatId: string } | { missing: string[] } {
  const token = env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.TELEGRAM_CHAT_ID ?? "";
  // A private chat's id is the user's id: a positive integer. Groups and channels (negative ids) are refused.
  const missing = [!TOKEN_RE.test(token) && "TELEGRAM_BOT_TOKEN", !/^\d{3,}$/.test(chatId) && "TELEGRAM_CHAT_ID"].filter((x): x is string => !!x);
  return missing.length ? { missing } : { token, chatId };
}

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgUpdate {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; from?: TgUser; chat: { id: number; type: string }; reply_to_message?: { message_id: number } };
}

/** The Bot API with the method allowlist, retries on 429, and the token kept out of errors. */
export class TelegramApi {
  readonly #token: string;
  constructor(
    token: string,
    private readonly deps: TelegramDeps,
  ) {
    if (!TOKEN_RE.test(token)) throw new TelegramRefused("TELEGRAM_BOT_TOKEN doesn't look like a bot token (BotFather gives 123456789:ABC...)");
    this.#token = token;
  }

  /** Never the token: Bun and Telegram both echo the request URL in some errors. */
  scrub(s: string): string {
    return s.split(this.#token).join("[token]");
  }

  async call<T>(method: TelegramMethod, params: Record<string, unknown>): Promise<T> {
    if (!(TELEGRAM_METHODS as readonly string[]).includes(method)) throw new TelegramRefused(`${method}: not a method Donna may call`);
    for (let tries = 1; ; tries++) {
      let res: { status: number; json(): Promise<unknown> };
      try {
        res = await this.deps.fetch(`${TELEGRAM_API}/bot${this.#token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
      } catch (e) {
        throw new Error(this.scrub(`Telegram ${method}: connection: ${(e as Error).message}`));
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      if (body.ok) return body.result as T;
      if (res.status === 429 && tries < MAX_TRIES) {
        await this.deps.sleep((body.parameters?.retry_after ?? 2 ** tries) * 1000);
        continue;
      }
      const why =
        res.status === 401 ? "unauthorized: the bot token is wrong or was revoked in BotFather"
        : res.status === 409 ? "conflict: another hr watch, or a webhook, is already reading this bot's updates"
        : (body.description ?? "request failed");
      throw new Error(this.scrub(`Telegram ${method}: ${res.status} ${why}`));
    }
  }
}

/** Who has messaged the bot lately (for TELEGRAM_CHAT_ID): private chats only. Reads without confirming, so the
 *  listener still sees these messages later. */
export async function telegramSenders(api: TelegramApi): Promise<{ bot: string; senders: { chat_id: string; name: string }[] }> {
  const me = await api.call<{ username: string }>("getMe", {});
  const updates = await api.call<TgUpdate[]>("getUpdates", { timeout: 0, allowed_updates: ["message"] });
  const senders = new Map<string, string>();
  for (const u of updates) {
    const m = u.message;
    if (m?.chat.type === "private" && m.from) senders.set(String(m.chat.id), `${m.from.first_name ?? ""}${m.from.username ? ` (@${m.from.username})` : ""}`.trim());
  }
  return { bot: me.username, senders: [...senders].map(([chat_id, name]) => ({ chat_id, name })) };
}

export class TelegramChannel implements MessageChannel {
  readonly kind = "telegram";
  readonly label = "Telegram";
  readonly maxChars = TELEGRAM_MAX_CHARS;
  readonly api: TelegramApi;
  constructor(
    cfg: { token: string; chatId: string },
    deps: TelegramDeps,
    readonly chatId = cfg.chatId,
  ) {
    this.api = new TelegramApi(cfg.token, deps);
  }

  async send(text: string): Promise<{ id: string } | { error: string }> {
    const body = text.length <= TELEGRAM_MAX_CHARS ? text : `${text.slice(0, TELEGRAM_MAX_CHARS - 1)}…`;
    try {
      // Plain text: no parse_mode, so nothing in a post can break the formatting or turn into markup.
      const r = await this.api.call<{ message_id: number }>("sendMessage", { chat_id: this.chatId, text: body, link_preview_options: { is_disabled: true } });
      return { id: String(r.message_id) };
    } catch (e) {
      return { error: this.api.scrub((e as Error).message) };
    }
  }

  async typing(): Promise<void> {
    await this.api.call("sendChatAction", { chat_id: this.chatId, action: "typing" }).catch(() => {});
  }

  /** The user's new messages after `cursor`, waiting up to `waitS` seconds for one. Anything not from the user's own
   *  private chat is counted and dropped, its text never kept. */
  async receive(cursor: string | undefined, waitS: number): Promise<{ messages: Inbound[]; ignored: number; cursor: string | undefined }> {
    const updates = await this.api.call<TgUpdate[]>("getUpdates", { ...(cursor ? { offset: Number(cursor) } : {}), timeout: waitS, allowed_updates: ["message"] });
    const messages: Inbound[] = [];
    let ignored = 0;
    let next = cursor;
    for (const u of updates) {
      next = String(u.update_id + 1);
      const m = u.message;
      const mine = m?.chat.type === "private" && String(m.chat.id) === this.chatId && String(m.from?.id) === this.chatId;
      if (!mine || !m?.text) {
        ignored++;
        continue;
      }
      messages.push({ id: String(m.message_id), text: m.text, at: new Date(m.date * 1000).toISOString(), ...(m.reply_to_message ? { reply_to: String(m.reply_to_message.message_id) } : {}) });
    }
    return { messages, ignored, cursor: next };
  }
}
