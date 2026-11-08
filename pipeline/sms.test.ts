// Twilio (user 2026-11-07): one POST to the Messages API for the user's own number; settings checked by name;
// the auth token never in an error.
import { describe, expect, test } from "bun:test";
import { sendSms, smsConfig, type SmsFetch } from "./sms.ts";

const env = { TWILIO_ACCOUNT_SID: `AC${"0123456789abcdef".repeat(2)}`, TWILIO_AUTH_TOKEN: "f".repeat(32), TWILIO_FROM: "+15005550006", HACKRECON_SMS_TO: "+14155550123" };

describe("smsConfig", () => {
  test("all four, well formed; else their names only", () => {
    expect(smsConfig(env)).toEqual({ sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM, to: env.HACKRECON_SMS_TO });
    expect(smsConfig({ ...env, TWILIO_FROM: "5550006", TWILIO_AUTH_TOKEN: undefined })).toEqual({ missing: ["TWILIO_AUTH_TOKEN", "TWILIO_FROM"] });
  });
});

describe("sendSms", () => {
  const cfg = smsConfig(env) as Exclude<ReturnType<typeof smsConfig>, { missing: string[] }>;
  test("POSTs To, From and Body with basic auth to the account's Messages endpoint", async () => {
    const seen: Parameters<SmsFetch>[] = [];
    const r = await sendSms(cfg, "HackRecon: hi", async (...a) => (seen.push(a), { status: 201, json: async () => ({ sid: "SM123" }) }));
    expect(r).toEqual({ sid: "SM123" });
    expect(seen[0]![0]).toBe(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`);
    expect(seen[0]![1].method).toBe("POST");
    expect(seen[0]![1].headers.Authorization).toBe(`Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`);
    expect(Object.fromEntries(new URLSearchParams(seen[0]![1].body))).toEqual({ To: env.HACKRECON_SMS_TO, From: env.TWILIO_FROM, Body: "HackRecon: hi" });
  });
  test("an error says why, never with the token", async () => {
    const r = await sendSms(cfg, "x", async () => ({ status: 401, json: async () => ({ code: 20003, message: `Authenticate ${env.TWILIO_AUTH_TOKEN}` }) }));
    expect(r).toEqual({ error: "Twilio 401 (code 20003): Authenticate [token]" });
    expect(await sendSms(cfg, "x", async () => Promise.reject(new Error("offline")))).toEqual({ error: "Twilio connection: offline" });
  });
});
