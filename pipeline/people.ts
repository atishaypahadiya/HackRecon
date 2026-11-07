// Same-person links (user 2026-11-07). The Slack user ID stays the key everywhere. Two IDs count as one rep only on
// strong evidence from one users.json snapshot, checked in this order:
//   1. the same profile email, when the snapshot shows one;
//   2. the same avatar image: identical bytes, else a 16×16 difference hash (box-averaged) within AVATAR_MAX_BITS of 256 (Slack
//      keeps a new rendition per upload, so one photo uploaded to two accounts differs in bytes). Custom images only;
//      Slack's default avatars are shared by many people;
//   3. the same real name + title + company, all three present.
// Never a name alone, and never the display name: a rename can't create or break a link. Each link is written with
// its evidence to config/person_links.json (`hr person-links`), hashed, never the email or the image.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSON_LINKS_PATH } from "./event.ts";

export const AVATAR_MAX_BITS = 8;
const AVATAR_BYTES = 5_000_000;

export interface AccountEvidence {
  id: string;
  email?: string;
  /** sha256 of the image bytes and its 256-bit difference hash, both hex. */
  avatar?: { sha256: string; dhash: string };
  real_name?: string;
  title?: string;
  company?: string;
}

export type LinkEvidence =
  | { kind: "email"; email_sha256: string }
  | { kind: "avatar"; sha256_equal: boolean; dhash_bits_differing: number; of: 256 }
  | { kind: "profile"; fields: ["real_name", "title", "company"]; sha256: string };

export interface PersonLink {
  ids: [string, string];
  /** Where the pair was checked, e.g. "sponsor-side for Fetch.ai". */
  scope: string;
  evidence: LinkEvidence;
}

export interface PersonLinksFile {
  snapshot: { file: string; sha256: string };
  built_at: string;
  /** Rules the snapshot can't support, said once rather than per pair. */
  rule_notes: string[];
  checked: { scope: string; accounts: string[] }[];
  avatars: Record<string, { sha256: string; dhash: string }>;
  links: PersonLink[];
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    for (; x; x &= x - 1) d++;
  }
  return d;
}

/** A users.json account as people.ts reads it. display_name is deliberately not read. */
export interface SnapshotUser {
  id: string;
  profile?: { email?: string; real_name?: string; title?: string; company?: string; is_custom_image?: boolean; image_192?: string; display_name?: string };
}

/** The evidence one snapshot account offers, avatar aside (it needs a fetch: avatarHashes). */
export function profileEvidence(u: SnapshotUser): AccountEvidence {
  const p = u.profile ?? {};
  return { id: u.id, email: p.email || undefined, real_name: p.real_name || undefined, title: p.title || undefined, company: p.company || undefined };
}

/** The first rule that holds for the pair, in the user's order, or null. */
export function linkEvidence(a: AccountEvidence, b: AccountEvidence): LinkEvidence | null {
  if (a.email && b.email && norm(a.email) === norm(b.email)) return { kind: "email", email_sha256: sha(norm(a.email)).slice(0, 16) };
  if (a.avatar && b.avatar) {
    const d = hammingHex(a.avatar.dhash, b.avatar.dhash);
    if (a.avatar.sha256 === b.avatar.sha256 || d <= AVATAR_MAX_BITS) return { kind: "avatar", sha256_equal: a.avatar.sha256 === b.avatar.sha256, dhash_bits_differing: d, of: 256 };
  }
  const p = (x: AccountEvidence) => [x.real_name, x.title, x.company].map((v) => norm(v ?? ""));
  const [pa, pb] = [p(a), p(b)];
  if (pa.every(Boolean) && pa.every((v, i) => v === pb[i])) return { kind: "profile", fields: ["real_name", "title", "company"], sha256: sha(pa.join("|")).slice(0, 16) };
  return null;
}

/** id → its person's key: the smallest id among the accounts linked to it (union-find), so keys are stable. */
export function personKeys(links: { ids: [string, string] }[]): (id: string) => string {
  const up = new Map<string, string>();
  const find = (x: string): string => {
    const p = up.get(x);
    if (!p || p === x) return x;
    const r = find(p);
    up.set(x, r);
    return r;
  };
  for (const { ids } of links) {
    const [a, b] = [find(ids[0]), find(ids[1])];
    if (a !== b) up.set(a < b ? b : a, a < b ? a : b);
  }
  return find;
}

/** No file yet: every account is its own person. */
export function loadPersonKey(path = PERSON_LINKS_PATH): (id: string) => string {
  return existsSync(path) ? personKeys((JSON.parse(readFileSync(path, "utf8")) as PersonLinksFile).links) : (id) => id;
}

/** Difference hash of a 17×16 grayscale image (row-major): each pixel brighter than its right neighbour is a 1. */
export function dhash(gray: Uint8Array, w = 17, h = 16): string {
  let bits = "";
  for (let r = 0; r < h; r++) for (let c = 0; c < w - 1; c++) bits += gray[r * w + c]! > gray[r * w + c + 1]! ? "1" : "0";
  return bits.match(/.{4}/g)!.map((n) => parseInt(n, 2).toString(16)).join("");
}

/** Averages k×k blocks: a grayscale image of (W·k)×(H·k) → W×H. sips' own shrink to 17×16 samples too sparsely
 *  (one photo at two sizes came out 31 bits apart; averaged, 3). */
export function boxDown(gray: Uint8Array, w: number, k: number, W = 17, H = 16): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      let t = 0;
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) t += gray[(r * k + y) * w + c * k + x]!;
      out[r * W + c] = Math.round(t / (k * k));
    }
  return out;
}

/** An uncompressed 24- or 32-bit BMP (what `sips -s format bmp` writes) → grayscale, top row first. */
export function bmpGray(buf: Uint8Array): { w: number; h: number; gray: Uint8Array } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint16(0, false) !== 0x424d) throw new Error("not a BMP");
  const off = v.getUint32(10, true), w = v.getInt32(18, true), hRaw = v.getInt32(22, true), bpp = v.getUint16(28, true);
  if ((bpp !== 24 && bpp !== 32) || (v.getUint32(30, true) !== 0 && v.getUint32(30, true) !== 3)) throw new Error(`unsupported BMP (${bpp} bpp)`);
  const h = Math.abs(hRaw), step = bpp / 8, stride = Math.ceil((w * step) / 4) * 4;
  const gray = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const row = off + (hRaw > 0 ? h - 1 - r : r) * stride;
    for (let c = 0; c < w; c++) {
      const p = row + c * step;
      gray[r * w + c] = Math.round(0.299 * buf[p + 2]! + 0.587 * buf[p + 1]! + 0.114 * buf[p]!);
    }
  }
  return { w, h, gray };
}

const BOX = 8;

/** Fetches one avatar from Slack's image CDN (the URL users.json lists; no Slack API call), hashes it, and keeps
 *  only the hashes. macOS `sips` shrinks it to 136×128 and boxDown to 17×16; nothing is saved. */
export async function avatarHashes(url: string): Promise<{ sha256: string; dhash: string } | { error: string }> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !u.hostname.endsWith(".slack-edge.com")) return { error: `not a Slack avatar URL: ${u.hostname}` };
  const r = await fetch(u, { redirect: "error" });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > AVATAR_BYTES) return { error: "image too large" };
  const dir = mkdtempSync(join(tmpdir(), "hr-avatar-"));
  try {
    writeFileSync(join(dir, "in"), bytes);
    const s = spawnSync("sips", ["-s", "format", "bmp", "-z", String(16 * BOX), String(17 * BOX), join(dir, "in"), "--out", join(dir, "out.bmp")], { encoding: "utf8", timeout: 30_000 });
    if (s.status !== 0) return { error: `sips: ${(s.stderr || s.error?.message || "").split("\n")[0]}` };
    const { w, h, gray } = bmpGray(readFileSync(join(dir, "out.bmp")));
    if (w !== 17 * BOX || h !== 16 * BOX) return { error: `resized to ${w}×${h}` };
    return { sha256: sha(bytes), dhash: dhash(boxDown(gray, w, BOX)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
