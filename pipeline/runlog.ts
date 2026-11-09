// A long-running command's own log (user 2026-11-08): `hr watch` and `hr board` append what they print to the
// event's data/ (data/watch.log, data/board.log), which outlives the terminal or session that started them. A
// shell redirect into a temp folder was deleted while the board was still writing to it.
import { appendFileSync } from "node:fs";
import { format } from "node:util";

/** From now on, console.log, console.warn and console.error also go to `path`, one timestamped line each. */
export function logTo(path: string, now = () => new Date()): void {
  for (const k of ["log", "warn", "error"] as const) {
    const print = console[k].bind(console);
    console[k] = (...a: unknown[]) => {
      print(...a);
      const text = format(...a).replace(/^\n+/, "");
      try {
        appendFileSync(path, `${now().toISOString()} ${k === "log" ? "" : `${k}: `}${text}\n`);
      } catch {
        // A full disk or a removed data/ never stops the alerts; the terminal still has the line.
      }
    };
  }
}
