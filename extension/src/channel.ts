// Captures the channel open in the message pane by scrolling it, as the web client renders it. Shared by
// "Capture this channel" (content.ts) and "Sync this event" (sync.ts). No Slack API calls, no profile cards.
import { SCHEMA_VERSION, messageId, type CaptureFile, type Message, type StopReason } from "../../pipeline/schema.ts";
import { Accumulator, STEP_WAIT_MS, StopRule } from "./accumulate.ts";
import { parseRows } from "./parse.ts";
import { SEL, TEXT } from "./selectors.ts";

const MAX_STEPS = 3000;
const STEP_FRACTION = 0.8;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function channelIdFromUrl(): string | null {
  return /\/client\/[A-Z0-9]+\/([CG][A-Z0-9]+)/.exec(location.pathname)?.[1] ?? null;
}

/** true: Slack shows a "who can post" notice; false: a composer and no notice; null: neither found. */
function postingRestricted(): boolean | null {
  const footer = document.querySelector(SEL.footer);
  if (!footer) return null;
  if (TEXT.postingRestricted.test(footer.textContent ?? "")) return true;
  return document.querySelector(SEL.composer) ? false : null;
}

export function channelName(): string {
  const fromHeader = document.querySelector(SEL.channelName)?.textContent?.trim();
  if (fromHeader) return fromHeader.replace(/^#\s*/, "");
  // Title looks like "spons-convex (Channel) - Cal Hacks - Slack".
  return document.title.split(" (")[0]?.replace(/^[*!]\s*/, "").trim() ?? "";
}

async function scrollToNewest(scroller: Element): Promise<void> {
  let last = -1;
  for (let i = 0; i < 10 && scroller.scrollHeight !== last; i++) {
    last = scroller.scrollHeight;
    scroller.scrollTop = scroller.scrollHeight;
    await sleep(STEP_WAIT_MS);
  }
}

/** deletedParents: threads whose parent was deleted; not posts, but their replies are (UNVERIFIED: that Slack
 *  renders a reply bar on the "This message was deleted." row; the export has 2 such threads in the locked 25). */
export type ChannelResult =
  | { file: CaptureFile; summary: string; deletedParents: { ts: string; count: number; last?: string }[]; error?: undefined }
  | { file: null; error: string; summary?: undefined; deletedParents?: undefined };

export async function captureChannelFile(status: (msg: string) => void, stopped: () => boolean, nameHint?: string): Promise<ChannelResult> {
  const channelId = channelIdFromUrl();
  const scroller = document.querySelector(SEL.scroller);
  if (!channelId || !scroller) return { file: null, error: !channelId ? "open a channel in app.slack.com first" : "message pane not found (selectors.ts needs updating)" };
  const started = new Date();
  const runId = `${channelId}-${started.getTime()}`;
  const acc = new Accumulator();
  const rule = new StopRule();
  const ingest = () => acc.ingest(parseRows(document, location.href));

  const listEl = document.querySelector(SEL.list) ?? scroller;
  const observer = new MutationObserver(ingest);
  observer.observe(listEl, { childList: true, subtree: true });

  status("HackRecon: jumping to the newest message…");
  await scrollToNewest(scroller);

  let steps = 0;
  let stop: StopReason | null = null;
  while (!stop) {
    ingest();
    stop = stopped() ? "user_stopped" : steps >= MAX_STEPS ? "max_steps" : rule.step(acc.size, acc.sawChannelStart);
    if (stop) break;
    status(`HackRecon: ${nameHint ? `#${nameHint}: ` : ""}${acc.size} messages · step ${steps} · scrolling up…`);
    scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * STEP_FRACTION);
    steps++;
    await sleep(STEP_WAIT_MS);
  }
  observer.disconnect();
  ingest();

  const finished = new Date();
  const name = channelName();
  const { messages, systemRowsSkipped, nonPostsSkipped, unresolvedAuthors, deletedParents } = acc.finalize();
  const file: CaptureFile = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    source: "extension",
    channel_id: channelId,
    channel_name: name,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    stop_reason: stop,
    scroll_steps: steps,
    system_rows_skipped: systemRowsSkipped,
    non_posts_skipped: nonPostsSkipped,
    unresolved_authors: unresolvedAuthors,
    posting_restricted: postingRestricted(),
    messages: messages.map((m): Message => {
      const out: Message = {
        id: messageId(channelId, m.ts),
        channel_id: channelId,
        channel_name: name,
        ts: m.ts,
        author_name: m.sender.name,
        text: m.text,
        links: m.links,
        permalink: m.permalink,
        captured_at: finished.toISOString(),
        run_id: runId,
      };
      if (m.threadTs) {
        out.thread_ts = m.threadTs;
        out.subtype = "thread_broadcast";
      }
      if (m.sender.title) out.author_title = m.sender.title;
      if (m.sender.id) out.author_id = m.sender.id;
      out.author_kind = m.sender.bot ? "bot" : "user";
      if (m.sender.external) out.author_external = true;
      if (m.replies) {
        out.reply_count = m.replies.count;
        if (m.replies.last) out.latest_reply = m.replies.last;
      }
      return out;
    }),
  };
  const secs = Math.round((finished.getTime() - started.getTime()) / 1000);
  const summary =
    `${messages.length} messages in ${secs}s, stop: ${stop}, system rows skipped: ${systemRowsSkipped}` + (unresolvedAuthors.length ? `, ${unresolvedAuthors.length} without an author` : "") + ".";
  return { file, summary, deletedParents };
}
