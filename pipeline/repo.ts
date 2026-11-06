// A linked project repository, read as data for Plan's gap check (user 2026-11-06). Public GitHub only: a shallow
// clone into ~/.cache/hackrecon/repos, outside this project, so no tool here (bun test, tsc, the bundler) ever picks
// up its files: a clone inside the tree once had `bun test` load Hindsight's own test files. Nothing in it is run,
// and its text reaches the model only as quoted lines with their path. Which lines: those naming a checked track's products, found in code, not by a model.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProjectFact } from "./gaps.ts";

export const REPOS_DIR = join(homedir(), ".cache", "hackrecon", "repos");
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
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

/** Clone once (depth 1, no tags, LFS skipped); reuse the checkout after that. */
export function checkoutRepo(url: string): Repo | { error: string } {
  const p = parseRepoUrl(url);
  if (!p) return { error: "only public https://github.com/<owner>/<repo> links are read" };
  const dir = join(REPOS_DIR, `${p.owner}__${p.name}`);
  const git = (args: string[], cwd?: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }, timeout: 120_000 }).trim();
  try {
    if (!existsSync(join(dir, ".git"))) git(["clone", "--quiet", "--depth", "1", "--no-tags", "--single-branch", `https://github.com/${p.owner}/${p.name}.git`, dir]);
    return { url: `https://github.com/${p.owner}/${p.name}`, dir, sha: git(["rev-parse", "HEAD"], dir) };
  } catch (e) {
    return { error: `couldn't clone ${url}: ${(e as Error).message.split("\n")[0]}` };
  }
}

const rank = (path: string) => (/(^|\/)readme\.md$/i.test(path) ? (path.includes("/") ? 1 : 0) : /\.(py|ts|tsx|js|jsx|go|rs|rb|java|kt|swift)$/.test(path) ? 2 : 3);

/** Lines naming any of the terms (whole word, any case): root README first, then other READMEs, code, the rest;
 *  at most PER_FILE lines a file and PER_TERM a term. Each keeps its path:line and a link at the commit. */
export function repoFacts(repo: Repo, terms: string[], files = listFiles(repo.dir)): ProjectFact[] {
  const out: ProjectFact[] = [];
  const seen = new Set<string>();
  const ordered = files.filter((f) => !SKIP.test(f)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const term of [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 2))]) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    let n = 0;
    for (const f of ordered) {
      if (n >= PER_TERM) break;
      const text = readText(join(repo.dir, f));
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

function listFiles(dir: string): string[] {
  return execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);
}

function readText(path: string): string | null {
  try {
    // lstat: a symlink in someone else's repo can point anywhere on this machine, so it's never followed.
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 300_000) return null;
    const s = readFileSync(path, "utf8");
    return s.includes("\0") ? null : s;
  } catch {
    return null;
  }
}
