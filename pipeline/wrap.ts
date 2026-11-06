// CLI text wrapping at word boundaries (user 2026-11-06). The plan printer's lines ran to ~290 characters and the
// terminal soft-wrapped them; copied out of a wrapped terminal, the space at a break can vanish ("actorfor"). Breaking
// lines ourselves, at spaces, keeps every word and every space: a break replaces exactly one space.

/** Wraps one line to `width` columns. Continuation lines get the line's own indent plus `hang` spaces. A word
 *  longer than the room left (a URL) stays whole on its own line. */
export function wrapLine(line: string, width: number, hang = 2): string {
  const indent = /^\s*/.exec(line)![0];
  const words = line.slice(indent.length).split(" ");
  if (width <= 0 || line.length <= width) return line;
  const cont = indent + " ".repeat(hang);
  const out: string[] = [];
  let cur = indent;
  let empty = true;
  for (const w of words) {
    const add = empty ? w : ` ${w}`;
    if (!empty && cur.length + add.length > width) {
      out.push(cur);
      cur = cont + w;
    } else cur += add;
    empty = false;
  }
  out.push(cur);
  return out.join("\n");
}

/** Every line of `text`, wrapped. */
export function wrapText(text: string, width: number, hang = 2): string {
  return text
    .split("\n")
    .map((l) => wrapLine(l, width, hang))
    .join("\n");
}

/** The terminal's width when printing to one, else 100. */
export function cliWidth(): number {
  return process.stdout.isTTY && process.stdout.columns ? Math.max(40, process.stdout.columns - 1) : 100;
}
