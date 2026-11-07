// Page snapshot (v2 D3, D11, D12): the text of the page the user has open, as rendered, in reading order.
// Pure DOM walk, shared by the injected script (content-page.ts) and the tests, which run it on saved HTML.
// Every block keeps its heading path (h1–h6) and the id of its nearest ancestor with one (Devpost's
// `prize_106857`), which entity ids are anchored to (D7). Nothing is sent anywhere.
import { PAGE_SCHEMA_VERSION, type PageAccess, type PageBlock, type PageLink, type PageSnapshot } from "../../pipeline/schema.ts";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "SELECT", "OPTION", "BUTTON", "INPUT", "TEXTAREA"]);
/** Elements whose text reads as part of the surrounding line, not a block of its own. */
const INLINE = new Set(["A", "ABBR", "B", "BDI", "BDO", "CITE", "CODE", "DATA", "DFN", "EM", "I", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR", "WBR", "LABEL", "FONT"]);
const HEADING = /^H([1-6])$/;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** Stands in for <br> while whitespace collapses, then becomes a real line break. */
const BR = "\u0000";
const cleanLines = (s: string) =>
  clean(s)
    .split(BR)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

function hidden(el: Element): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  const style = (el.getAttribute("style") ?? "").replace(/\s/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** Text of an element's own line: its text nodes plus inline descendants, stopping at block descendants.
 *  Whitespace is collapsed once at the end, so spaces at inline edges ("8<span> AM </span>PST") survive;
 *  <br> stays a line break ("<strong>Application</strong><br>Projects should…" keeps the name on its own line). */
function ownText(el: Element): string {
  const raw = (e: Element): string => {
    let out = "";
    for (const n of Array.from(e.childNodes)) {
      if (n.nodeType === 3) out += n.textContent ?? "";
      else if (n.nodeType === 1) {
        const c = n as Element;
        if (SKIP.has(c.tagName.toUpperCase()) || hidden(c)) continue;
        if (c.tagName.toUpperCase() === "BR") out += BR;
        else if (INLINE.has(c.tagName.toUpperCase())) out += raw(c);
      }
    }
    return out;
  };
  return cleanLines(raw(el));
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

export function snapshotPage(doc: Document, o: { url: string; captured_at: string; access: PageAccess | null; captured_by: PageSnapshot["captured_by"] }): PageSnapshot {
  const blocks: PageBlock[] = [];
  const links: PageLink[] = [];
  const path: string[] = [];
  const embeds = { iframes: 0, pdfs: 0 };

  const walk = (el: Element, anchor: string | undefined) => {
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(el)) return;
    if (tag === "IFRAME") return void embeds.iframes++;
    if ((tag === "EMBED" || tag === "OBJECT") && /pdf/i.test(el.getAttribute("type") ?? el.getAttribute("src") ?? el.getAttribute("data") ?? "")) return void embeds.pdfs++;
    const id = el.getAttribute("id") || undefined;
    const here = id ?? anchor;
    const h = HEADING.exec(tag);
    if (h) {
      const level = Number(h[1]);
      const text = clean(el.textContent ?? "");
      if (text) {
        path.length = level - 1; // a heading replaces its level and everything deeper
        path[level - 1] = text;
        blocks.push({ i: blocks.length, path: path.slice(0, level - 1).filter(Boolean), heading: level, text, ...(here ? { anchor: here } : {}) });
      }
      return;
    }
    if (!INLINE.has(tag)) {
      const text = ownText(el);
      if (text) blocks.push({ i: blocks.length, path: path.filter(Boolean), text, ...(here ? { anchor: here } : {}) });
    }
    if (tag === "A" && el.getAttribute("href")) {
      const text = clean(el.textContent ?? "") || clean(el.getAttribute("title") ?? "") || clean(el.querySelector("img")?.getAttribute("alt") ?? "");
      links.push({ text, href: absolute(el.getAttribute("href")!, o.url), block: Math.max(0, blocks.length - 1) });
    }
    for (const c of Array.from(el.children)) walk(c, here);
  };

  if (doc.body) walk(doc.body, undefined);
  const snap: PageSnapshot = {
    schema_version: PAGE_SCHEMA_VERSION,
    kind: "page",
    url: o.url,
    title: clean(doc.title ?? ""),
    captured_at: o.captured_at,
    captured_by: o.captured_by,
    access: o.access,
    blocks,
    links,
    embeds,
  };
  if (!blocks.some((b) => !b.heading)) snap.no_text = embeds.iframes || embeds.pdfs ? `no text captured: the page shows ${embeds.iframes} iframe(s) and ${embeds.pdfs} PDF(s)` : "no text captured";
  return snap;
}
