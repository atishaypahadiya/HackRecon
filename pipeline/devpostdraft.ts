// The user's own Devpost submission for this event (user 2026-11-07): read in their browser during "Sync this event",
// never from a page they save. Read-only: the background tab only loads link addresses read from the page it is on
// (GET), in a fixed order: the event page → the user's "My projects" → the project linked to this event → its
// submission for this event, then that submission's steps. Nothing is clicked or submitted, no form is filled, and
// a link that names a destructive action, or carries a non-GET method, is never loaded. One scrubbed sample of the
// submission page is saved; the parser for its selected prizes is written from that sample. Pure, shared with the
// extension's worker.
import { scrubTokens } from "./domscrub.ts";

export interface DraftLink {
  href: string;
  text: string;
  /** Rails' data-method; a link with one other than get is never loaded. */
  method?: string;
}

/** What the worker reads off each page it loads (inside the tab), before deciding the next hop. */
export interface DraftPage {
  url: string;
  links: DraftLink[];
  /** Checkboxes whose label names one of the event's tracks. */
  prize_boxes: number;
  /** Track names anywhere in the page text: the fallback score when the form shows prizes without checkboxes. */
  track_mentions: number;
}

export type DraftStage = "event" | "portfolio" | "project" | "submission";

export interface DraftState {
  /** The event's Devpost subdomain, e.g. cal-hacks-13-0. */
  slug: string;
  stage: DraftStage;
  /** Project pages from the portfolio not tried yet. */
  projects: string[];
  visited: string[];
  hops: number;
  /** The submission page with the best score so far (prize boxes first, then track names). */
  best: { url: string; score: number } | null;
  /** Per page loaded. A page where the visit stopped short also lists the safe Devpost links it had (address and
   *  text, at most 60), so a rule that missed Devpost's real structure can be fixed from one sync. */
  log: { url: string; stage: DraftStage; why: string; prize_boxes: number; track_mentions: number; links?: DraftLink[] }[];
}

export const MAX_HOPS = 8;
const DEVPOST_HOST = /^(?:www\.)?devpost\.com$/;
/** Words in a path or query that name something other than reading: never loaded. */
const DENY = /(delete|destroy|withdraw|remove|unsubmit|leave|cancel|log_?out|sign_?out|invite|reject|accept|publish|transfer|_method|unlike|follow|subscribe)/i;
const PROJECTS_TEXT = /^\s*(?:my\s+)?(?:projects|portfolio)\s*$/i;

export function eventSlug(eventRoot: string): string | null {
  const m = /^https:\/\/([a-z0-9-]+)\.devpost\.com\/?$/.exec(eventRoot);
  return m && !/^(www|help|info|secure|api)$/.test(m[1]!) ? m[1]! : null;
}

/** A link the worker may load: https on devpost.com (or the event's own host), a GET, no destructive word. */
export function safeHop(l: DraftLink, slug: string): URL | null {
  if (l.method && l.method.toLowerCase() !== "get") return null;
  let u: URL;
  try {
    u = new URL(l.href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (!DEVPOST_HOST.test(u.hostname) && u.hostname !== `${slug}.devpost.com`) return null;
  if (DENY.test(u.pathname) || DENY.test(u.search)) return null;
  u.hash = "";
  return u;
}

const submissionPath = (slug: string) => new RegExp(`^/submit-to/\\d+-${slug}/manage/submissions(?:/\\d+[\\w-]*(?:/[\\w-]+)?)?/?$`);
const projectPath = /^\/software\/[a-z0-9-]+\/?$/;

export function startDraft(eventRoot: string): DraftState | null {
  const slug = eventSlug(eventRoot);
  return slug ? { slug, stage: "event", projects: [], visited: [eventRoot], hops: 1, best: null, log: [] } : null;
}

/** One step: given the page just read, where to go next (or null: done). Pure; the worker does the loading. */
export function draftStep(s: DraftState, page: DraftPage): { state: DraftState; go: string | null; why: string } {
  const st: DraftState = { ...s, projects: [...s.projects], visited: [...s.visited], log: [...s.log] };
  const hops = page.links.map((l) => ({ l, u: safeHop(l, s.slug) })).filter((x): x is { l: DraftLink; u: URL } => !!x.u);
  const fresh = (u: URL) => !st.visited.includes(u.href);
  const note = (why: string) => st.log.push({ url: page.url, stage: s.stage, why, prize_boxes: page.prize_boxes, track_mentions: page.track_mentions });
  const go = (u: string, stage: DraftStage, why: string) => {
    note(why);
    st.stage = stage;
    st.visited.push(u);
    st.hops++;
    return { state: st, go: u, why };
  };
  const stop = (why: string, short = true) => {
    note(why);
    if (short) st.log[st.log.length - 1]!.links = hops.map((x) => ({ href: x.u.href, text: x.l.text.slice(0, 60) })).slice(0, 60);
    return { state: st, go: null, why };
  };

  if (s.stage === "submission") {
    const score = page.prize_boxes * 1000 + page.track_mentions;
    if (score > 0 && (!st.best || score > st.best.score)) st.best = { url: page.url, score };
    if (page.prize_boxes > 0) return stop("prize checkboxes found", false);
  }
  if (st.hops >= MAX_HOPS) return stop(`stopped after ${MAX_HOPS} pages`);

  const sub = hops.find((x) => DEVPOST_HOST.test(x.u.hostname) && submissionPath(s.slug).test(x.u.pathname) && fresh(x.u));
  if (s.stage === "event") {
    const p = hops.find((x) => DEVPOST_HOST.test(x.u.hostname) && PROJECTS_TEXT.test(x.l.text) && fresh(x.u));
    return p ? go(p.u.href, "portfolio", `"${p.l.text.trim()}" link`) : stop("no My projects link (not signed in to Devpost?)");
  }
  if (s.stage === "portfolio") {
    st.projects = [...new Set(hops.filter((x) => DEVPOST_HOST.test(x.u.hostname) && projectPath.test(x.u.pathname) && fresh(x.u)).map((x) => x.u.href))];
    const next = st.projects.shift();
    return next ? go(next, "project", "a project in My projects") : stop("no projects in My projects");
  }
  if (s.stage === "project") {
    // Only a project that is this event's: its page links the submission for this event's slug.
    if (sub) return go(sub.u.href, "submission", "this project's submission for the event");
    const next = st.projects.shift();
    return next ? go(next, "project", "previous project has no submission for this event") : stop("no project has a submission for this event");
  }
  // In the submission: its other steps (same submission path), until one shows the prize checkboxes.
  const base = /^(\/submit-to\/\d+-[\w-]+\/manage\/submissions\/\d+[\w-]*)/.exec(new URL(page.url).pathname)?.[1];
  const step = hops.find((x) => DEVPOST_HOST.test(x.u.hostname) && submissionPath(s.slug).test(x.u.pathname) && fresh(x.u) && (!base || x.u.pathname.startsWith(base)));
  return step ? go(step.u.href, "submission", `submission step "${step.l.text.trim().slice(0, 40)}"`) : stop(st.best ? "no more submission steps" : "no submission page names a track");
}

/** Strips what a signed-in Devpost page carries about the session: script, style and template bodies, every hidden
 *  input's value and any input named like a token, session or secret; then domscrub.ts's rules, which include the
 *  csrf-token meta, authenticity_token fields and link params, and session cookies. The in-tab copy has already
 *  stripped the same; this runs again on the worker's side and on ingest. Counts only, never values. */
export function scrubDevpostHtml(html: string): { html: string; stripped: number } {
  let n = 0;
  html = html.replace(/(<(script|style|noscript|template)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (_m, open, _t, body, close) => (body.trim() && n++, `${open}${close}`));
  html = html.replace(/<input\b[^>]*>/gi, (tag) => {
    if (!/\btype="hidden"/i.test(tag) && !/\bname="[^"]*(token|csrf|xsrf|session|secret|password|key)[^"]*"/i.test(tag)) return tag;
    return tag.replace(/\bvalue="(?!REDACTED")[^"]+"/i, () => (n++, 'value="REDACTED"'));
  });
  const t = scrubTokens(html);
  return { html: t.html, stripped: n + Object.values(t.found).reduce((a, b) => a + b, 0) };
}
