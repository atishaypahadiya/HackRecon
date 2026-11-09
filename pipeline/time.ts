// Event-local timestamps. Every time the pipeline shows or sends is in the event timezone
// with an explicit offset (design doc, "Classifier input").
import type { Ts } from "./schema.ts";

/** The zone used when event.json names none (audit 2026-11-08): UTC, said aloud wherever times are shown; never a
 *  zone borrowed from another event. */
export const NO_TZ = "UTC";

const formats = new Map<string, Intl.DateTimeFormat>();
const format = (tz: string) => {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
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
    formats.set(tz, f);
  }
  return f;
};

function local(ts: Ts, tz: string) {
  return localMs(Number(ts.split(".")[0]) * 1000, tz);
}

function localMs(ms: number, tz: string) {
  const p = Object.fromEntries(format(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName!.slice(3);
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`, weekday: p.weekday!, off };
}

/** The zone's offset at an instant: "UTC-07:00" (Pacific in October), "UTC-08:00" (in mid-November), "UTC+00:00". */
export function utcOffset(tz: string, ms: number): string {
  return `UTC${localMs(ms, tz).off}`;
}

/** " UTC" after a shown time when the event names no zone, so a reader knows which clock it is; "" otherwise. */
export const zoneMark = (tz: string) => (tz === NO_TZ ? " UTC" : "");

/** "1792803548.122049" → "2026-10-23T17:59:08-07:00" */
export function tsToEventIso(ts: Ts, tz: string): string {
  return local(ts, tz).iso;
}

/** "2026-10-23T17:59:08-07:00 (Friday)", for the classifier to resolve "Sunday", "tonight". */
export function tsToEventIsoWithDay(ts: Ts, tz: string): string {
  const l = local(ts, tz);
  return `${l.iso} (${l.weekday})`;
}

/** Any ISO instant with an offset → the event-local date, e.g. "2026-10-25T16:30:00Z" → "2026-10-25". */
export function eventDate(iso: string, tz: string): string {
  return localMs(Date.parse(iso), tz).iso.slice(0, 10);
}

/** ISO 8601 with an explicit offset (Z or ±HH:MM), as items and labels require. */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
