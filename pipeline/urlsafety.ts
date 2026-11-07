// User rule (2026-11-07): never load any URL whose path names an action, on any site, signed in or not. Checked by
// the Node fetcher (every redirect hop, fetch.ts) and the extension's background page capture (background.ts).
// A GET that only shows a form can still create something (Devpost's /software/add was loaded once), so the rule
// reads the words in the path, not the method. Pure; shared with the extension.

export const ACTION_VERBS = ["add", "new", "edit", "delete", "destroy", "submit", "publish", "join"] as const;
const VERBS = new Set<string>(ACTION_VERBS);

/** The path's words: percent-decoded, split on / - _ . ~ + and spaces and at camelCase boundaries, lowercased. */
export function pathWords(pathname: string): string[] {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: read the raw path.
  }
  return p
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[/\-_.~+\s]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Why a URL may not be loaded (its path names an action, or it doesn't parse), or null when it may. */
export function refuseLoad(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  const v = pathWords(u.pathname).find((w) => VERBS.has(w));
  return v ? `its path names an action ("${v}"); never loaded` : null;
}
