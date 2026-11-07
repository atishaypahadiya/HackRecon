// A linked project repository, read as data (Plan's gap check, P1b's prefill; user 2026-11-06). Public GitHub only.
// The clone lives in ~/.cache/hackrecon/repos, outside this project, so no tool here (bun test, tsc, the bundler)
// picks up its files: a clone inside the tree once had `bun test` load Hindsight's own test files. It is a partial
// clone with no working tree: depth 1, blobs over 300 kB left on the server, nothing checked out. So nothing from it
// is ever on disk as a file to run, and a symlink is only a blob holding a path, which is skipped. Text is read from
// git's object store and reaches a model only as quoted lines with their path.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectFact } from "./gaps.ts";

export const REPOS_DIR = join(homedir(), ".cache", "hackrecon", "repos");
// http:// and www. links are read over https: the same repo, and git never talks to GitHub unencrypted.
const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
/** Skipped: dependencies, build output, lockfiles, tests (they restate code), env files and binary-ish assets. */
const SKIP = /(^|\/)(node_modules|dist|build|vendor|\.venv|__pycache__|tests?|__tests__|fixtures)\/|\.(lock|min\.js|map|png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|zip)$|(^|\/)(package-lock\.json|uv\.lock|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$|(^|\/)\.env|\.test\.|_test\.|\.spec\./i;
const SECRET = /(?:key|token|secret|password|passwd)\s*[:=]/i;
const PER_FILE = 4;
const PER_TERM = 24;
const MAX_LINE = 240;

export interface Repo {
  url: string;
  dir: string;
  sha: string;
}

export function parseRepoUrl(url: string): { owner: string; name: string } | null {
  const m = GITHUB.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

// GIT_NO_LAZY_FETCH: a read never fetches a blob the partial clone left out.
const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_NO_LAZY_FETCH: "1" };
const git = (args: string[], cwd?: string, input?: string) => execFileSync("git", args, { cwd, input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 }).trim();
export const BLOB_LIMIT = 300_000;
const remote = (p: { owner: string; name: string }) => `https://github.com/${p.owner}/${p.name}.git`;

/** The git commands that clone once (partial, no checkout) or, with `latest`, move the clone to the default branch's
 *  newest commit (Ship's recheck): fetch that commit the same way and point HEAD at it. */
function checkoutSteps(url: string, opts: { latest?: boolean }): { url: string; dir: string; steps: [string[], string?][] } | { error: string } {
  const p = parseRepoUrl(url);
  if (!p) return { error: "only public https://github.com/<owner>/<repo> links are read" };
  const dir = join(REPOS_DIR, `${p.owner}__${p.name}`);
  const filter = `--filter=blob:limit=${BLOB_LIMIT}`;
  const steps: [string[], string?][] = !existsSync(join(dir, ".git"))
    ? [[["clone", "--quiet", "--depth", "1", "--no-tags", "--single-branch", "--no-checkout", filter, remote(p), dir]]]
    : opts.latest
      ? [[["fetch", "--quiet", "--depth", "1", "--no-tags", filter, "origin", "HEAD"], dir], [["update-ref", "HEAD", "FETCH_HEAD"], dir]]
      : [];
  return { url: `https://github.com/${p.owner}/${p.name}`, dir, steps };
}

export function checkoutRepo(url: string, opts: { latest?: boolean } = {}): Repo | { error: string } {
  const c = checkoutSteps(url, opts);
  if ("error" in c) return c;
  try {
    for (const [args, cwd] of c.steps) git(args, cwd);
    return { url: c.url, dir: c.dir, sha: git(["rev-parse", "HEAD"], c.dir) };
  } catch (e) {
    return { error: `couldn't read ${url}: ${(e as Error).message.split("\n")[0]}` };
  }
}

const gitAsync = (args: string[], cwd?: string) =>
  new Promise<string>((ok, fail) => execFile("git", args, { cwd, encoding: "utf8", env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => (e ? fail(e) : ok(out.trim()))));

/** checkoutRepo without blocking the server: Plan's stream clones while the tracks are ranked (P2). */
export async function checkoutRepoAsync(url: string, opts: { latest?: boolean } = {}): Promise<Repo | { error: string }> {
  const c = checkoutSteps(url, opts);
  if ("error" in c) return c;
  try {
    for (const [args, cwd] of c.steps) await gitAsync(args, cwd);
    return { url: c.url, dir: c.dir, sha: await gitAsync(["rev-parse", "HEAD"], c.dir) };
  } catch (e) {
    return { error: `couldn't read ${url}: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** The default branch's newest commit on GitHub, without fetching anything (one ls-remote). */
export function remoteHead(url: string): string | { error: string } {
  const p = parseRepoUrl(url);
  if (!p) return { error: "only public https://github.com/<owner>/<repo> links are read" };
  try {
    const sha = git(["ls-remote", remote(p), "HEAD"]).split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : { error: `no HEAD commit at ${url}` };
  } catch (e) {
    return { error: `couldn't reach ${url}: ${(e as Error).message.split("\n")[0]}` };
  }
}

const rank = (path: string) => (/(^|\/)readme\.md$/i.test(path) ? (path.includes("/") ? 1 : 0) : /\.(py|ts|tsx|js|jsx|go|rs|rb|java|kt|swift)$/.test(path) ? 2 : 3);

/** Lines naming any of the terms (whole word, any case): root README first, then other READMEs, code, the rest;
 *  at most PER_FILE lines a file and PER_TERM a term. Each keeps its path:line and a link at the commit. */
export function repoFacts(repo: Repo, terms: string[], texts = repoTexts(repo)): ProjectFact[] {
  const out: ProjectFact[] = [];
  const seen = new Set<string>();
  const ordered = [...texts.keys()].filter((f) => !SKIP.test(f)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const term of [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 2))]) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    let n = 0;
    for (const f of ordered) {
      if (n >= PER_TERM) break;
      const text = texts.get(f);
      if (!text || !re.test(text)) continue;
      let k = 0;
      for (const [i, line] of text.split("\n").entries()) {
        if (k >= PER_FILE || n >= PER_TERM) break;
        const t = line.trim();
        if (!re.test(t) || SECRET.test(t) || t.length < 6) continue;
        const key = `${f}:${i + 1}`;
        k++;
        n++;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: "", kind: "repo", source: key, url: `${repo.url}/blob/${repo.sha}/${f}#L${i + 1}`, text: t.length > MAX_LINE ? `${t.slice(0, MAX_LINE)}…` : t });
      }
    }
  }
  return out;
}

/** Every text file at HEAD as path → content, from git's objects: regular files (mode 100644/100755) only, so
 *  symlinks and submodules are skipped; blobs the partial clone left on the server (over BLOB_LIMIT) and binary
 *  blobs (a NUL byte) are skipped. Cached per commit for this process. */
const textsCache = new Map<string, Map<string, string>>();
export function repoTexts(repo: Repo): Map<string, string> {
  const hit = textsCache.get(`${repo.dir}@${repo.sha}`);
  if (hit) return hit;
  const missing = new Set(
    git(["rev-list", "--objects", "--missing=print", "HEAD"], repo.dir)
      .split("\n")
      .filter((l) => l.startsWith("?"))
      .map((l) => l.slice(1).trim()),
  );
  const entries = git(["ls-tree", "-r", "HEAD"], repo.dir)
    .split("\n")
    .map((l) => /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && (m[1] === "100644" || m[1] === "100755") && !missing.has(m[2]!));
  const out = new Map<string, string>();
  if (entries.length) {
    // One cat-file --batch for every blob: "<sha> blob <size>\n<content>\n" each, in order.
    const raw = execFileSync("git", ["cat-file", "--batch"], { cwd: repo.dir, input: entries.map((m) => m[2]).join("\n") + "\n", env, maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
    let at = 0;
    for (const m of entries) {
      const nl = raw.indexOf(10, at);
      const size = Number(raw.subarray(at, nl).toString("utf8").split(" ")[2]);
      const body = raw.subarray(nl + 1, nl + 1 + size);
      at = nl + 1 + size + 1;
      if (size > BLOB_LIMIT || body.includes(0)) continue;
      out.set(m[3]!, body.toString("utf8"));
    }
  }
  textsCache.set(`${repo.dir}@${repo.sha}`, out);
  return out;
}
