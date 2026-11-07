import { describe, expect, test } from "bun:test";
import { boardData } from "./board.ts";
import { bmpGray, boxDown, dhash, hammingHex, linkEvidence, personKeys, profileEvidence, type AccountEvidence, type SnapshotUser } from "./people.ts";
import type { Sponsors } from "./pool.ts";
import { rolesById } from "./roles.ts";
import type { Message } from "./schema.ts";

const av = (dhash: string, sha256 = dhash) => ({ sha256, dhash });
const ones = "f".repeat(64), zeros = "0".repeat(64);
const near = "f".repeat(62) + "00"; // 8 bits from ones

describe("linkEvidence: strong evidence only, in the user's order (2026-11-07)", () => {
  test("email first, then the avatar (bytes, or within 8 of 256 hash bits), then real name + title + company", () => {
    expect(linkEvidence({ id: "A", email: "Ravi@Fetch.ai " }, { id: "B", email: "ravi@fetch.ai" })).toMatchObject({ kind: "email" });
    expect(linkEvidence({ id: "A", avatar: av(ones, "x") }, { id: "B", avatar: av(zeros, "x") })).toMatchObject({ kind: "avatar", sha256_equal: true });
    expect(linkEvidence({ id: "A", avatar: av(ones) }, { id: "B", avatar: av(near) })).toEqual({ kind: "avatar", sha256_equal: false, dhash_bits_differing: 8, of: 256 });
    expect(linkEvidence({ id: "A", avatar: av(ones) }, { id: "B", avatar: av("f".repeat(61) + "000") })).toBeNull();
    const p = { real_name: "Ravi Varma", title: "Senior AI Engineer", company: "Fetch.ai" };
    expect(linkEvidence({ id: "A", ...p }, { id: "B", ...p })).toMatchObject({ kind: "profile" });
  });

  test("never a name alone: real name + title without a company, or a real name alone, links nothing", () => {
    expect(linkEvidence({ id: "A", real_name: "Raj", title: "Engineer" }, { id: "B", real_name: "Raj", title: "Engineer" })).toBeNull();
    expect(linkEvidence({ id: "A", real_name: "Raj" }, { id: "B", real_name: "Raj" })).toBeNull();
  });

  test("a rename never creates or breaks a link: the display name isn't read", () => {
    const u = (id: string, display_name: string, rest: SnapshotUser["profile"] = {}): SnapshotUser => ({ id, profile: { display_name, ...rest } });
    // Same display name, nothing else shared: no link.
    expect(linkEvidence(profileEvidence(u("A", "Raj [Fetch AI]")), profileEvidence(u("B", "Raj [Fetch AI]")))).toBeNull();
    // A linked pair stays linked whatever either one is renamed to.
    const shared = { email: "ravi@fetch.ai" };
    const before = linkEvidence(profileEvidence(u("A", "Raj [Fetch AI]", shared)), profileEvidence(u("B", "Raj", shared)));
    const after = linkEvidence(profileEvidence(u("A", "LenaRose", shared)), profileEvidence(u("B", "someone else", shared)));
    expect(before).not.toBeNull();
    expect(after).toEqual(before);
    expect(profileEvidence(u("A", "x"))).toEqual(profileEvidence(u("A", "y")));
  });

  test("links join transitively under the smallest id", () => {
    const key = personKeys([{ ids: ["U3", "U2"] }, { ids: ["U2", "U9"] }]);
    expect(["U9", "U3", "U2", "U5"].map(key)).toEqual(["U2", "U2", "U2", "U5"]);
  });
});

describe("avatar hashing", () => {
  test("bmpGray reads a bottom-up 24-bit BMP; dhash marks a pixel brighter than its right neighbour", () => {
    const w = 17, h = 16, stride = Math.ceil((w * 3) / 4) * 4;
    const buf = new Uint8Array(54 + stride * h);
    const v = new DataView(buf.buffer);
    v.setUint16(0, 0x424d, false); v.setUint32(10, 54, true); v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(28, 24, true);
    // Bottom-up: file row 0 is the image's last row. Make every pixel darker than its left neighbour.
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) buf.fill(255 - c * 10, 54 + r * stride + c * 3, 54 + r * stride + c * 3 + 3);
    const g = bmpGray(buf);
    expect([g.w, g.h, g.gray[0], g.gray[1]]).toEqual([17, 16, 255, 245]);
    expect(dhash(g.gray)).toBe(ones);
    expect(hammingHex(ones, near)).toBe(8);
    expect([...boxDown(new Uint8Array(34 * 32).map((_, i) => (i % 2) * 100), 34, 2)].every((x) => x === 50)).toBe(true);
  });
});

describe("one person, two accounts: one rep, both accounts behind it", () => {
  const sponsors = { "spons-fetch-ai": { sponsor: "Fetch.ai", kind: "sponsor", aliases: ["Fetch AI"] } } as unknown as Sponsors;
  const msg = (ts: string, author_id: string, author_name: string): Message => ({ id: `C1:${ts}`, channel_id: "C1", channel_name: "spons-fetch-ai", ts, author_id, author_name, text: "", links: [], permalink: "", captured_at: "", run_id: "r" });
  const messages = [msg("100.0", "UGUEST", "Raj [Fetch AI]"), msg("200.0", "UMEMBER", "Raj"), msg("300.0", "UDEV", "Devam (Fetch AI)")];
  const board = (person?: (id: string) => string) =>
    boardData({ event: "e", timezone: "America/Los_Angeles", run_id: "r", channels: ["spons-fetch-ai"], messages, sponsors, offers: [], role: rolesById(messages, sponsors, new Set(), person), ...(person ? { person } : {}), basis: { grouping: "g", model: "m", written_at: "w" } });

  test("linked: the member account renamed to a bare name is still sponsor-side, and the tile counts one rep", () => {
    const d = board(personKeys([{ ids: ["UGUEST", "UMEMBER"] }]));
    expect(d.reps[0]).toMatchObject({ candidates: 2, candidate_first: [100, 300] });
    expect(d.rep_accounts).toEqual({ "spons-fetch-ai": [2, 1] });
  });

  test("not linked: same name or not, each id is its own rep, and the renamed account has no role", () => {
    const d = board();
    expect(d.reps[0]).toMatchObject({ candidates: 2, candidate_first: [100, 300] });
    expect(d.rep_accounts).toEqual({ "spons-fetch-ai": [1, 1] });
  });
});
