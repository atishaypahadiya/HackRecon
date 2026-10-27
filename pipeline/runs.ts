// The `runs` and `messages` tables (data/, gitignored: workspace content).
// A run groups the per-channel capture files of one capture session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoadedCapture } from "./captures.ts";
import type { Message, Run } from "./schema.ts";

export const RUNS_PATH = "data/runs.json";
export const MESSAGES_PATH = "data/messages.json";

/** Builds the run record and the run's messages (re-stamped with its run_id), channels in `channelOrder`. */
export function buildRun(runId: string, loaded: LoadedCapture[], channelOrder: string[]): { run: Run; messages: Message[] } {
  const rank = (name: string) => {
    const i = channelOrder.indexOf(name);
    return i < 0 ? channelOrder.length : i;
  };
  const sorted = [...loaded].sort((a, b) => rank(a.capture.channel_name) - rank(b.capture.channel_name));
  const messages = sorted.flatMap((l) => l.capture.messages.map((m) => ({ ...m, run_id: runId })));
  const started = sorted.map((l) => l.capture.started_at).sort()[0];
  if (!started) throw new Error("no captures");
  return {
    run: {
      run_id: runId,
      started_at: started,
      channels: sorted.map((l) => l.capture.channel_name),
      message_count: messages.length,
      source: "extension",
    },
    messages,
  };
}

export function readRuns(path = RUNS_PATH): Run[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Run[]) : [];
}

/** Adds or replaces (same run_id) a run, and replaces that run's rows in the messages table. */
export function saveRun(run: Run, messages: Message[], runsPath = RUNS_PATH, messagesPath = MESSAGES_PATH): void {
  const runs = readRuns(runsPath).filter((r) => r.run_id !== run.run_id);
  runs.push(run);
  const old = existsSync(messagesPath) ? (JSON.parse(readFileSync(messagesPath, "utf8")) as Message[]) : [];
  const kept = old.filter((m) => m.run_id !== run.run_id);
  for (const p of [runsPath, messagesPath]) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(runsPath, JSON.stringify(runs, null, 2));
  writeFileSync(messagesPath, JSON.stringify([...kept, ...messages], null, 2));
}

/** All messages, latest run wins per message id. */
export function readMessages(path = MESSAGES_PATH): Message[] {
  if (!existsSync(path)) throw new Error(`${path} not found: run \`bun run hr record-run --id <run_id> captures/\` first`);
  const order = new Map(readRuns().map((r, i) => [r.run_id, i]));
  const byId = new Map<string, Message>();
  for (const m of JSON.parse(readFileSync(path, "utf8")) as Message[]) {
    const prev = byId.get(m.id);
    if (!prev || (order.get(m.run_id) ?? -1) >= (order.get(prev.run_id) ?? -1)) byId.set(m.id, m);
  }
  return [...byId.values()];
}
