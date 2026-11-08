// Texts to the user's own phone through Twilio's Messages API (user 2026-11-07). Credentials come from the
// environment (.env, gitignored): never written to disk, logs or the outbox, and never in an error.
// One route only: POST /2010-04-01/Accounts/<sid>/Messages.json, to the one number in HACKRECON_SMS_TO.

export interface SmsConfig {
  sid: string;
  token: string;
  from: string;
  to: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** The four settings, or what's missing or malformed (names only, never values). */
export function smsConfig(env: Record<string, string | undefined>): SmsConfig | { missing: string[] } {
  const v = { sid: env.TWILIO_ACCOUNT_SID ?? "", token: env.TWILIO_AUTH_TOKEN ?? "", from: env.TWILIO_FROM ?? "", to: env.HACKRECON_SMS_TO ?? "" };
  const missing = [
    !/^AC[0-9a-f]{32}$/.test(v.sid) && "TWILIO_ACCOUNT_SID",
    !/^\w{32,}$/.test(v.token) && "TWILIO_AUTH_TOKEN",
    !E164.test(v.from) && "TWILIO_FROM",
    !E164.test(v.to) && "HACKRECON_SMS_TO",
  ].filter((x): x is string => !!x);
  return missing.length ? { missing } : v;
}

export type SmsFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function sendSms(cfg: SmsConfig, body: string, f: SmsFetch): Promise<{ sid: string } | { error: string }> {
  const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${cfg.sid}:${cfg.token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: cfg.to, From: cfg.from, Body: body }).toString(),
  }).catch((e: Error) => ({ status: 0, json: async () => ({ message: e.message }) }));
  const out = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
  if (res.status >= 200 && res.status < 300 && out.sid) return { sid: out.sid };
  const why = `Twilio ${res.status || "connection"}${out.code ? ` (code ${out.code})` : ""}: ${out.message ?? "no reason given"}`;
  return { error: why.split(cfg.token).join("[token]") };
}
