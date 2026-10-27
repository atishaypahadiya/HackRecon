import { TS_RE, type Ts } from "../../pipeline/schema.ts";

const PERMALINK_RE = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:[?#/]|$)/;

/** `.../archives/C0C7TCNCR1N/p1791591648310369` → `1791591648.310369` */
export function tsFromPermalink(href: string): Ts | null {
  const m = PERMALINK_RE.exec(href);
  return m ? `${m[2]}.${m[3]}` : null;
}

export function channelFromPermalink(href: string): string | null {
  return PERMALINK_RE.exec(href)?.[1] ?? null;
}

/** Accepts a bare ts (`data-ts`, `data-item-key`) only when it has Slack's exact shape. */
export function tsFromAttr(v: string | null | undefined): Ts | null {
  return v && TS_RE.test(v) ? v : null;
}

export function permalinkFor(workspaceOrigin: string, channelId: string, ts: Ts): string {
  return `${workspaceOrigin}/archives/${channelId}/p${ts.replace(".", "")}`;
}
