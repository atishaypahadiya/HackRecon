// Event-local timestamps. Every time the pipeline shows or sends is in the event timezone
// with an explicit offset (design doc, "Classifier input").
import type { Ts } from "./schema.ts";

export const EVENT_TZ = "America/Los_Angeles";

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: EVENT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "long",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

function local(ts: Ts) {
  return localMs(Number(ts.split(".")[0]) * 1000);
}

function localMs(ms: number) {
  const p = Object.fromEntries(parts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName!.slice(3);
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`, weekday: p.weekday! };
}

/** "1792803548.122049" → "2026-10-23T17:59:08-07:00" */
export function tsToEventIso(ts: Ts): string {
  return local(ts).iso;
}

/** "2026-10-23T17:59:08-07:00 (Friday)", for the classifier to resolve "Sunday", "tonight". */
export function tsToEventIsoWithDay(ts: Ts): string {
  const l = local(ts);
  return `${l.iso} (${l.weekday})`;
}

/** Any ISO instant with an offset → the event-local date, e.g. "2026-10-25T16:30:00Z" → "2026-10-25". */
export function eventDate(iso: string): string {
  return localMs(Date.parse(iso)).iso.slice(0, 10);
}

/** ISO 8601 with an explicit offset (Z or ±HH:MM), as items and labels require. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
