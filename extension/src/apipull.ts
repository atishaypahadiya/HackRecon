// The background API pull (user 2026-11-07): the event's channels through SlackApi's read-only methods, on a timer,
// with no tab or window. Same channel choice as "Sync this event" (config channels, prefix-discovered ones, then
// hacker-only channels). Incremental: each channel asks only for posts after its cursor, less THREAD_LOOKBACK_S so
// recent parents show their current reply count; a thread's replies are fetched again only when that count grew.
// Never calls anything that marks read: conversations.history and .replies don't.
import type { ExportMessage } from "../../pipeline/export.ts";
import type { ApiChannelFile, ApiUser } from "../../pipeline/apiconvert.ts";
import type { SlackApi } from "./slackapi.ts";
import { ApiError } from "./slackapi.ts";
import { syncTargets, type SidebarChannel, type SyncConfig } from "./thread.ts";

/** D17's 48 h thread lookback: parents posted this recently are re-listed so new replies are seen. */
export const THREAD_LOOKBACK_S = 48 * 3600;
export const PAGE_LIMIT = "200";

export interface ChannelState {
  /** Newest top-level ts read. */
  newest?: string;
  /** reply_count last read, per parent ts. */
  threads: Record<string, number>;
}
/** Kept in chrome.storage.local between pulls: ts cursors and counts only, never text or the token. */
export interface PullState {
  channels: Record<string, ChannelState>;
}

export interface PullLog {
  started_at: string;
  finished_at: string;
  full: boolean;
  calls: number;
  retries: number;
  missing: string[];
  discovered: string[];
  channels: { id: string; name: string; oldest: string | null; history: number; threads_read: number; replies: number; error?: string }[];
}

export interface PullIO {
  /** Saves one file of this pull (`api/<name>`); returns an error message or null. */
  save(name: string, value: unknown): Promise<string | null>;
  /** Called after each channel is saved, with the state to keep (also what keeps a service worker awake). */
  progress(state: PullState): Promise<void>;
  now(): number;
}

const maxTs = (a: string | undefined, b: string) => (!a || Number(b) > Number(a) ? b : a);

export async function pull(api: SlackApi, config: SyncConfig, prev: PullState, io: PullIO): Promise<{ state: PullState; log: PullLog }> {
  const started = new Date(io.now()).toISOString();
  const state: PullState = { channels: { ...prev.channels } };
  const full = !Object.keys(prev.channels).length;
  const found = (await api.all<SidebarChannel & { is_archived?: boolean }>("conversations.list", { types: "public_channel", exclude_archived: "true", limit: "1000" }, "channels")).map((c) => ({ id: c.id, name: c.name }));
  const sel = syncTargets(found, config.channels, config.authors_only ?? []);
  const log: PullLog = { started_at: started, finished_at: started, full, calls: 0, retries: 0, missing: sel.missing, discovered: sel.discovered, channels: [] };

  const fail = (e: unknown) => (e instanceof ApiError ? e.code : (e as Error).message);
  let wrote = 0;
  for (const ch of sel.targets) {
    const st: ChannelState = { threads: { ...(state.channels[ch.id]?.threads ?? {}) }, newest: state.channels[ch.id]?.newest };
    const oldest = st.newest ? String(Math.min(Number(st.newest), io.now() / 1000 - THREAD_LOOKBACK_S)) : null;
    const row: PullLog["channels"][number] = { id: ch.id, name: ch.name, oldest, history: 0, threads_read: 0, replies: 0 };
    log.channels.push(row);
    const t0 = new Date(io.now()).toISOString();
    try {
      const history = await api.all<ExportMessage>("conversations.history", { channel: ch.id, limit: PAGE_LIMIT, ...(oldest ? { oldest } : {}) }, "messages");
      const replies: Record<string, ExportMessage[]> = {};
      for (const m of history) {
        if (!m.reply_count || m.reply_count <= (st.threads[m.ts] ?? 0)) continue;
        replies[m.ts] = (await api.all<ExportMessage>("conversations.replies", { channel: ch.id, ts: m.ts, limit: PAGE_LIMIT }, "messages")).filter((r) => r.ts !== m.ts);
        st.threads[m.ts] = m.reply_count;
        row.threads_read++;
        row.replies += replies[m.ts]!.length;
      }
      for (const m of history) if (!m.thread_ts || m.thread_ts === m.ts) st.newest = maxTs(st.newest, m.ts);
      row.history = history.length;
      const fresh = history.filter((m) => !prev.channels[ch.id]?.newest || Number(m.ts) > Number(prev.channels[ch.id]!.newest));
      if (fresh.length || Object.keys(replies).length) {
        const file: ApiChannelFile = { kind: "api-channel", channel_id: ch.id, channel_name: ch.name, started_at: t0, finished_at: new Date(io.now()).toISOString(), oldest, history, replies };
        const err = await io.save(`${ch.id}.json`, file);
        if (err) {
          row.error = err;
          continue; // the cursor stays where it was, so the next pull reads this channel again
        }
        wrote++;
      }
      state.channels[ch.id] = st;
      await io.progress(state);
    } catch (e) {
      row.error = fail(e);
    }
  }

  // Who's who for the converter and discovery (admin and owner flags); only when this pull saved posts.
  if (wrote || full) {
    try {
      await io.save("users.json", await api.all<ApiUser>("users.list", { limit: PAGE_LIMIT }, "members"));
      await io.save("channels.json", found);
    } catch (e) {
      log.channels.push({ id: "", name: "users.list", oldest: null, history: 0, threads_read: 0, replies: 0, error: fail(e) });
    }
  }
  log.finished_at = new Date(io.now()).toISOString();
  log.calls = api.calls;
  log.retries = api.retries;
  return { state, log };
}
