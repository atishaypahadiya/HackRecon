// Hacker-only channels (user 2026-11-07): team formation and introductions. A sync reads them authors-only: sender
// IDs and post counts, never text, so nothing there is stored or classified. Pure, shared with the extension.

/** By name, when event.json lists none. A name proves nothing about who posts there, but the rule only uses it to
 *  read fewer things (authors-only) and as a counter-signal against a rep, never to make one. */
export const HACKER_ONLY = /(^|[-_])(team[-_]?formation|introductions?)$/i;

/** The configured list when there is one, else names matching HACKER_ONLY. */
export function hackerOnlyChannels(names: Iterable<string>, configured?: string[]): string[] {
  return configured?.length ? [...configured] : [...new Set(names)].filter((n) => HACKER_ONLY.test(n)).sort();
}

/** One authors-only capture's content: who posted, how often. `unidentified`: posts whose sender ID the DOM hid. */
export function countAuthors(posts: { author_id?: string; author_kind?: string }[]): { authors: { id: string; posts: number }[]; unidentified: number } {
  const n = new Map<string, number>();
  let unidentified = 0;
  for (const p of posts) {
    if (p.author_kind === "bot") continue;
    if (!p.author_id) unidentified++;
    else n.set(p.author_id, (n.get(p.author_id) ?? 0) + 1);
  }
  return { authors: [...n].sort((a, b) => a[0].localeCompare(b[0])).map(([id, posts]) => ({ id, posts })), unidentified };
}
