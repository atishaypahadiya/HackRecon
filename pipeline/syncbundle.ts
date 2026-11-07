// "Sync this event" bundles (extension/src/sync.ts): ~/Downloads/hackrecon/sync/<stamp>/ with captures/, slack-dom/
// and sync.json. Files over the data: URL limit arrive split as `<name>.part-<i>-of-<n>` (extension/src/ui.ts).
// Pure helpers; hr.ts does the I/O.

const PART = /^(.+)\.part-(\d+)-of-(\d+)$/;

/** Groups a directory's names into whole files: `{ name, parts }` in order, or `missing` when a part is absent. */
export function wholeFiles(names: string[]): { name: string; parts: string[]; missing?: number[] }[] {
  const split = new Map<string, { n: number; got: Map<number, string> }>();
  const out: { name: string; parts: string[]; missing?: number[] }[] = [];
  for (const f of names) {
    const m = PART.exec(f);
    if (!m) {
      out.push({ name: f, parts: [f] });
      continue;
    }
    const g = split.get(m[1]!) ?? { n: Number(m[3]), got: new Map() };
    g.got.set(Number(m[2]), f);
    split.set(m[1]!, g);
  }
  for (const [name, g] of split) {
    const idx = Array.from({ length: g.n }, (_, i) => i + 1);
    const missing = idx.filter((i) => !g.got.has(i));
    out.push(missing.length ? { name, parts: [], missing } : { name, parts: idx.map((i) => g.got.get(i)!) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bundle directory names are the sync's start time with ":" and "." replaced: newest sorts last. */
export const BUNDLE_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export interface SyncLogLite {
  stamp: string;
  stopped_by_user: boolean;
  targets: string[];
  config?: { event: string | null; channels: number; missing: string[]; discovered: string[]; authors_only?: string[] };
  channels: { name: string; mode?: "authors"; authors?: number; self_ids?: number; opened: boolean; error?: string; messages?: number; threads?: { stop: string; replies: number; pane_how?: string; close?: string; loading_left?: number; note?: string }[] }[];
  samples: { file: string; why: string }[];
  save_errors: string[];
}

/** One line per fact worth reading after a sync: channels, thread stops, how the pane was found, samples. */
export function summarizeSync(log: SyncLogLite): string[] {
  const opened = log.channels.filter((c) => c.opened && c.mode !== "authors");
  const threads = log.channels.flatMap((c) => c.threads ?? []);
  const tally = (xs: (string | undefined)[]) => Object.entries(xs.reduce<Record<string, number>>((a, k) => ((a[k ?? "none"] = (a[k ?? "none"] ?? 0) + 1), a), {})).map(([k, n]) => `${k} ${n}`).join(", ");
  const lines = [
    `channels: ${opened.length}/${log.targets.length} opened${log.stopped_by_user ? " (stopped by the user)" : ""}`,
    `threads: ${threads.length} tried, ${threads.reduce((n, t) => n + t.replies, 0)} replies read; stops: ${tally(threads.map((t) => t.stop)) || "none"}`,
    `pane found by: ${tally(threads.filter((t) => t.stop !== "not_opened").map((t) => t.pane_how)) || "never"}`,
    `pane closed by: ${tally(threads.filter((t) => t.stop !== "not_opened").map((t) => t.close)) || "not logged"}`,
  ];
  const left = threads.filter((t) => t.loading_left);
  if (left.length) lines.push(`replies Slack never loaded: ${left.reduce((n, t) => n + t.loading_left!, 0)} in ${left.length} threads (saved as blanks)`);
  if (log.config) {
    lines.unshift(`selection: ${log.config.channels} config channels${log.config.missing.length ? `; not in the sidebar: ${log.config.missing.join(", ")}` : ""}${log.config.discovered.length ? `; found by prefix, not in config: ${log.config.discovered.join(", ")}` : ""}`);
  } else lines.unshift("selection: prefixes only (no sync-config.json; rebuild with bun run build:ext)");
  for (const c of log.channels.filter((c) => c.mode === "authors" && c.opened)) lines.push(`authors only: #${c.name}, ${c.authors ?? 0} posters in ${c.messages ?? 0} posts and ${(c.threads ?? []).length} threads, ${c.self_ids ?? 0} saying they work for a sponsor (no text kept)`);
  for (const c of log.channels.filter((c) => c.error)) lines.push(`  #${c.name}: ${c.error}`);
  const notes = tally(threads.map((t) => t.note).filter(Boolean));
  if (notes) lines.push(`thread notes: ${notes}`);
  for (const s of log.samples) lines.push(`sample ${s.file}: ${s.why}`);
  for (const e of log.save_errors) lines.push(`save failed: ${e}`);
  return lines;
}
