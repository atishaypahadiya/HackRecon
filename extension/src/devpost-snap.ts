// Injected by the background worker into the background tab that reads the user's own Devpost submission ("Sync
// this event", user 2026-11-07). Read-only: it reads links and form state and copies the page; it never clicks,
// focuses, types, submits or changes anything on the page. The copy is scrubbed here, before it leaves the tab:
// script, style and template bodies go, hidden and token-like inputs lose their values, the csrf meta is blanked,
// and inline handlers are dropped. The worker scrubs the string again (pipeline/devpostdraft.ts).
import type { DraftLink, DraftPage } from "../../pipeline/devpostdraft.ts";

declare global {
  interface Window {
    __hackreconDevpost?: { inspect: (tracks: string[]) => DraftPage; sample: () => string };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** A track's name and its name without the "[Sponsor] " prefix canon keeps. */
const forms = (t: string) => [norm(t), norm(t.replace(/^\[[^\]]+\]\s*/, ""))].filter((x) => x.length > 3);

function labelOf(i: HTMLInputElement): string {
  const l = i.labels?.[0] ?? i.closest("label");
  return norm((l ?? i.parentElement)?.textContent ?? "");
}

window.__hackreconDevpost = {
  inspect(tracks) {
    const f = tracks.map(forms);
    const links: DraftLink[] = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => ({ href: a.href, text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80), ...(a.dataset.method ? { method: a.dataset.method } : {}) }));
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((i) => f.some((ns) => ns.some((n) => labelOf(i).includes(n))));
    const text = norm(document.body?.innerText ?? "");
    return { url: location.href, links, prize_boxes: boxes.length, track_mentions: f.filter((ns) => ns.some((n) => text.includes(n))).length };
  },
  sample() {
    const live = [...document.querySelectorAll("input, option, textarea")];
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    const copy = [...root.querySelectorAll("input, option, textarea")];
    // The form's state as the page shows it (a property can differ from its attribute), so the sample says what's ticked.
    live.forEach((el, k) => {
      const c = copy[k];
      if (!c) return;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) c.toggleAttribute("checked", el.checked);
      if (el instanceof HTMLOptionElement) c.toggleAttribute("selected", el.selected);
    });
    for (const el of root.querySelectorAll("script, style, noscript, template, iframe")) el.textContent = "";
    for (const el of root.querySelectorAll("iframe")) el.removeAttribute("src");
    for (const m of root.querySelectorAll('meta[name="csrf-token"]')) m.setAttribute("content", "REDACTED");
    for (const i of root.querySelectorAll<HTMLInputElement>("input")) if (i.type === "hidden" || i.type === "password" || /token|csrf|xsrf|session|secret|password|key/i.test(i.name)) i.setAttribute("value", "REDACTED");
    for (const el of root.querySelectorAll("*")) for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    return `<!doctype html>\n${root.outerHTML}`;
  },
};
