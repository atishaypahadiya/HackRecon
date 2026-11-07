// Slack DOM samples (fixtures/slack-dom/) are saved with copy(document.body.outerHTML), which can carry the web
// client's session: xoxc- API tokens in boot data, the xoxd- cookie value, signed file URLs. They're gitignored,
// but they're read by tests and could be pasted anywhere, so `hr scrub-dom` strips them in place before use.
// Reports counts only, never the values. Devpost samples (fixtures/devpost/, user 2026-11-07) add Rails' session
// values: the csrf-token meta, authenticity_token form fields and link params, and session cookies.

const RULES: { name: string; re: RegExp; to: string | ((m: string, ...g: string[]) => string) }[] = [
  { name: "slack_token", re: /xox[a-z]-[A-Za-z0-9%._-]{8,}/g, to: "xox?-REDACTED" },
  { name: "slack_app_token", re: /xapp-[A-Za-z0-9-]{8,}/g, to: "xapp-REDACTED" },
  { name: "token_field", re: /("?(?:api_token|token|access_token|session_token|d_cookie|csrf_token|csrfToken|authenticity_token|session_id|sessionId|xsrf_token)"?\s*[:=]\s*")(?!REDACTED")[^"]{12,}(")/gi, to: (_m, a, b) => `${a}REDACTED${b}` },
  { name: "csrf_meta", re: /(<meta\b[^>]*\bname="csrf-token"[^>]*\bcontent=")(?!REDACTED")[^"]+(")/gi, to: (_m, a, b) => `${a}REDACTED${b}` },
  { name: "csrf_meta_rev", re: /(<meta\b[^>]*\bcontent=")(?!REDACTED")[^"]+("[^>]*\bname="csrf-token")/gi, to: (_m, a, b) => `${a}REDACTED${b}` },
  { name: "form_token", re: /(<input\b[^>]*\bname="[^"]*(?:authenticity_token|csrf|xsrf|session)[^"]*"[^>]*\bvalue=")(?!REDACTED")[^"]+(")/gi, to: (_m, a, b) => `${a}REDACTED${b}` },
  { name: "form_token_rev", re: /(<input\b[^>]*\bvalue=")(?!REDACTED")[^"]+("[^>]*\bname="[^"]*(?:authenticity_token|csrf|xsrf|session)[^"]*")/gi, to: (_m, a, b) => `${a}REDACTED${b}` },
  { name: "token_param", re: /([?&](?:amp;)?(?:authenticity_token|csrf_token|_csrf|session_id)=)(?!REDACTED)[^&"'\s<]+/gi, to: (_m, a) => `${a}REDACTED` },
  { name: "session_cookie", re: /(\b_[a-z0-9_]*session=)(?!REDACTED)[^;"'\s&<]+/gi, to: (_m, a) => `${a}REDACTED` },
  { name: "bearer", re: /\bBearer\s+(?!REDACTED)[A-Za-z0-9._~+/-]{20,}=*/gi, to: "Bearer REDACTED" },
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, to: "JWT-REDACTED" },
  { name: "signed_url_param", re: /([?&](?:t|token|pub_secret)=)(?!REDACTED)[A-Za-z0-9._%-]{16,}/gi, to: (_m, a) => `${a}REDACTED` },
];

export type ScrubCounts = Record<string, number>;

export function findTokens(html: string): ScrubCounts {
  return Object.fromEntries(RULES.map((r) => [r.name, html.match(r.re)?.length ?? 0]));
}

export function scrubTokens(html: string): { html: string; found: ScrubCounts } {
  const found = findTokens(html);
  let out = html;
  for (const r of RULES) out = out.replace(r.re, r.to as never);
  return { html: out, found };
}

export const total = (c: ScrubCounts) => Object.values(c).reduce((a, b) => a + b, 0);
