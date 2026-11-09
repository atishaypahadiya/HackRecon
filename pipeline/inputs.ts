// The redacted request input both models see: `hr classify` (Haiku) and `hr prelabel` (the Opus
// judge) build it here, so the judge reads exactly the text the classifier read (R3-19/OV2).
import { buildInput, eventTimezone, type ClassifyInput } from "./classify.ts";
import type { LabelRow } from "./labels.ts";
import type { Sponsors } from "./pool.ts";
import { buildNameList, compileRedactor } from "./redact.ts";
import { loadPersonKey } from "./people.ts";
import { loadRepIndex } from "./reps.ts";
import { eventOrganizerTag, loadOrganizerIds, rolesById } from "./roles.ts";
import type { Message } from "./schema.ts";

/** One input per message. Names to redact come from the captured authors (bots excluded), as before. */
export function redactedInputs(
  captured: Message[],
  sponsors: Sponsors,
  promptHash: string,
  extra: Message[] = [],
  organizerIds: Set<string> = loadOrganizerIds(),
  tag: RegExp | null = eventOrganizerTag(),
  tz: string = eventTimezone(),
): ClassifyInput[] {
  const redact = compileRedactor(buildNameList(new Set(captured.filter((m) => m.author_kind !== "bot").map((m) => m.author_name)), sponsors));
  // Confirmed reps (reps.ts) are sponsor-side here too; likely staff never is, so it never changes a hint.
  const person = loadPersonKey();
  const role = rolesById([...captured, ...extra], sponsors, organizerIds, tag, person, loadRepIndex(person).confirmed);
  return [...captured, ...extra].map((m) => buildInput(m, { role: role(m), sponsor: sponsors[m.channel_name]?.sponsor ?? "", redact, promptHash, tz }));
}

/** A sheet row the capture missed, as a message: baseline text (Slack mrkdwn), links from its
 *  `<url|label>` markup. Only the judge needs these; the classifier never sees uncaptured messages. */
export function messageFromRow(r: LabelRow): Message {
  const [channelId, ts] = r.message_id.split(":") as [string, string];
  return {
    id: r.message_id,
    channel_id: channelId,
    channel_name: r.channel,
    ts,
    ...(r.subtype === "thread_broadcast" ? { subtype: "thread_broadcast" as const } : {}),
    author_name: r.author,
    text: r.text,
    links: [...r.text.matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!),
    permalink: r.permalink,
    captured_at: "",
    run_id: "",
  };
}
