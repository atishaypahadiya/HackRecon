// Automatic session handoff (user 2026-11-07): when a Slack tab for a workspace the user already synced loads, its
// session goes to the service worker, so pulls resume after an extension reload or a browser restart with no click.
// The content script asks first whether the workspace is known and sends the session only if it is. The session
// lives in chrome.storage.session (memory) only; the known list holds team IDs and origins, never a token.
import { WORKSPACE_ORIGIN } from "./slackapi.ts";

export interface SlackSession {
  token: string;
  origin: string;
  team: string;
  workspace: string;
}
export interface KnownWorkspace {
  team: string;
  origin: string;
}

export const SLACK_CLIENT = /^https:\/\/app\.slack\.com\/client\//;

/** The open Slack client's own session for the team in its URL (localConfig_v2), or null. */
export function readSlackSession(loc: { pathname: string }, storage: { getItem(key: string): string | null }): SlackSession | null {
  try {
    const team = loc.pathname.split("/")[2] ?? "";
    if (!/^[TE][A-Z0-9]+$/.test(team)) return null;
    const t = (JSON.parse(storage.getItem("localConfig_v2") ?? "null") as { teams?: Record<string, { token?: string; url?: string; name?: string }> } | null)?.teams?.[team];
    if (!t?.token || !t.url) return null;
    const origin = new URL(t.url).origin;
    return WORKSPACE_ORIGIN.test(origin) ? { token: t.token, origin, team, workspace: t.name ?? "" } : null;
  } catch {
    return null;
  }
}

/** A message from this extension's own content script in a Slack client tab (not the popup, not another page). */
export function fromSlackTab(sender: { id?: string; origin?: string; tab?: { url?: string } }, extensionId: string): boolean {
  return sender.id === extensionId && !!sender.tab && SLACK_CLIENT.test(sender.tab.url ?? "") && (sender.origin === undefined || sender.origin === "https://app.slack.com");
}

export function isKnown(known: KnownWorkspace[], team: string, origin: string): boolean {
  return known.some((k) => k.team === team && k.origin === origin);
}

export function remember(known: KnownWorkspace[], s: { team: string; origin: string }): KnownWorkspace[] {
  return isKnown(known, s.team, s.origin) ? known : [...known, { team: s.team, origin: s.origin }];
}

/** Milliseconds until the next pull is due; 0: now (never pulled, or the last one is a full period old). */
export function pullDue(lastPullAt: number | undefined, now: number, everyMs: number): number {
  return lastPullAt === undefined ? 0 : Math.max(0, lastPullAt + everyMs - now);
}
