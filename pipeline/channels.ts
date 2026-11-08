// The user's message channel (user 2026-11-07): where alerts go and, for two-way channels, where the user's questions
// come from. One channel at a time, picked by HACKRECON_CHANNEL in .env (default telegram). Telegram is built and
// two-way; SMS (Twilio) is built one-way; iMessage and WhatsApp are planned. A new channel implements MessageChannel
// and gets a case in channelFromEnv: alerts (watch.ts) and the agent (agent.ts) only see this interface.
import { sendSms, smsConfig } from "./sms.ts";
import { TelegramChannel, telegramConfig, type TelegramFetch } from "./telegram.ts";

export const CHANNEL_KINDS = ["telegram", "sms", "imessage", "whatsapp"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** A message the user sent us. */
export interface Inbound {
  id: string;
  text: string;
  at: string;
}

export interface MessageChannel {
  readonly kind: ChannelKind;
  /** For logs: "Telegram". */
  readonly label: string;
  readonly maxChars: number;
  send(text: string): Promise<{ id: string } | { error: string }>;
  /** Two-way channels only: the user's messages after `cursor`, waiting up to `waitS` seconds; the new cursor. */
  receive?(cursor: string | undefined, waitS: number): Promise<{ messages: Inbound[]; ignored: number; cursor: string | undefined }>;
  /** Two-way channels only: shows the user an answer is coming. */
  typing?(): Promise<void>;
}

/** Twilio SMS, one-way: alerts only (replies would need a public webhook). */
class SmsChannel implements MessageChannel {
  readonly kind = "sms";
  readonly label = "SMS";
  readonly maxChars = 1600;
  constructor(
    private readonly cfg: Exclude<ReturnType<typeof smsConfig>, { missing: string[] }>,
    private readonly f: typeof fetch,
  ) {}
  async send(text: string) {
    const r = await sendSms(this.cfg, text, (u, i) => this.f(u, i));
    return "sid" in r ? { id: r.sid } : r;
  }
}

export type ChannelChoice = MessageChannel | { kind: string; missing: string[] } | { kind: string; unavailable: string };

export function channelFromEnv(env: Record<string, string | undefined>, deps: { fetch: typeof fetch; sleep(ms: number): Promise<void> } = { fetch, sleep: Bun.sleep }): ChannelChoice {
  const kind = (env.HACKRECON_CHANNEL ?? "telegram").toLowerCase();
  if (kind === "telegram") {
    const cfg = telegramConfig(env);
    return "missing" in cfg ? { kind, ...cfg } : new TelegramChannel(cfg, { fetch: deps.fetch as unknown as TelegramFetch, sleep: deps.sleep });
  }
  if (kind === "sms") {
    const cfg = smsConfig(env);
    return "missing" in cfg ? { kind, ...cfg } : new SmsChannel(cfg, deps.fetch);
  }
  if (kind === "imessage" || kind === "whatsapp") return { kind, unavailable: `${kind} isn't built yet; use telegram or sms` };
  return { kind, unavailable: `HACKRECON_CHANNEL=${kind}: not a channel (${CHANNEL_KINDS.join(", ")})` };
}

/** One line for a channel that can't send: what's missing, by name only. */
export function whyNoChannel(c: Exclude<ChannelChoice, MessageChannel>): string {
  return "missing" in c ? `${c.kind} not set up (${c.missing.join(", ")} missing or malformed in .env)` : c.unavailable;
}

export const isChannel = (c: ChannelChoice): c is MessageChannel => "send" in c;
