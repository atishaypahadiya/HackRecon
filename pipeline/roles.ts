// poster_role (D17): organizer | sponsor-side | other. A label computed from the A5 rules, sent to
// the classifier as a hint; never a name.
import { existsSync, readFileSync } from "node:fs";
import type { SlackExport } from "./export.ts";
import type { SponsorEntry } from "./pool.ts";
import type { Message } from "./schema.ts";
import { ORGANIZERS_PATH } from "./event.ts";


export type PosterRole = "organizer" | "sponsor-side" | "other";

const ORG_TAG = /\bcal\s*hacks\b/i;
const ORG_TITLE = /director|exec|organi[sz]er|logistics/i;

/** organizers.json is Slack user IDs only (user 2026-11-06): names change mid-event and aren't needed to match. */
export interface Organizer {
  id: string;
  why: string[];
}

interface ExportUserFull {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  profile?: { display_name?: string; real_name?: string; title?: string };
}

/** A5, built once from the baseline's users.json (55 accounts measured): admins, owners,
 *  CAL HACKS-tagged names, director/exec/organizer/logistics titles. */
export function buildOrganizers(exp: SlackExport): Organizer[] {
  return [...exp.users.values()].flatMap((raw) => {
    const u = raw as ExportUserFull;
    if (u.deleted || u.is_bot) return [];
    const names = [u.profile?.display_name, u.profile?.real_name, u.real_name].filter(Boolean).join(" ");
    const why = [
      u.is_admin && "admin",
      u.is_owner && "owner",
      ORG_TAG.test(names) && "cal hacks tag",
      ORG_TITLE.test(u.profile?.title ?? "") && "title",
    ].filter((w): w is string => !!w);
    return why.length ? [{ id: u.id, why }] : [];
  });
}

export function loadOrganizerIds(path = ORGANIZERS_PATH): Set<string> {
  if (!existsSync(path)) throw new Error(`${path} not found: run \`bun run hr organizers\` once (reads the baseline's users.json)`);
  return new Set((JSON.parse(readFileSync(path, "utf8")) as Organizer[]).map((o) => o.id));
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Organizer wins over sponsor-side. Sponsor-side: the name (bracket tag included) or inline title
 *  names the channel's sponsor or an alias, or the poster carries Slack's external-org badge.
 *  In event channels (0-announcements, 2-opportunities) any configured sponsor counts. */
export function posterRole(m: Message, channel: SponsorEntry | undefined, organizerIds: Set<string>, all: SponsorEntry[] = []): PosterRole {
  if ((m.author_id && organizerIds.has(m.author_id)) || ORG_TAG.test(m.author_name) || ORG_TITLE.test(m.author_title ?? "")) return "organizer";
  const event = !channel || channel.sponsor === "event";
  const candidates = event ? all.filter((s) => s.sponsor !== "event") : [channel];
  const who = norm(`${m.author_name} ${m.author_title ?? ""}`);
  if (candidates.some((s) => [s.sponsor, ...s.aliases].some((n) => who.includes(norm(n))))) return "sponsor-side";
  if (!event && m.author_external) return "sponsor-side";
  return "other";
}

/**
 * Roles keyed by Slack user ID only (user 2026-11-06: display names change mid-event; a cohost rep's
 * "LenaRose (Annapurna Labs)" became "LenaRose" between the Oct 27 capture and the Nov 6 sync).
 * posterRole reads one post's signals (name tag, inline title, external badge). Here a signal seen on any of a
 * user's posts holds for all of them: organizer everywhere; sponsor-side for that sponsor's channels, and in event
 * channels. A post with no author_id gets no role ("other"): names alone never key a person.
 */
export function rolesById(messages: Message[], sponsors: Record<string, SponsorEntry>, organizerIds: Set<string>): (m: Message) => PosterRole {
  const all = Object.values(sponsors);
  const organizer = new Set(organizerIds);
  const sponsorSide = new Set<string>();
  const anySponsor = new Set<string>();
  for (const m of messages) {
    if (!m.author_id || m.author_kind === "bot") continue;
    const ch = sponsors[m.channel_name];
    const r = posterRole(m, ch, organizerIds, all);
    if (r === "organizer") organizer.add(m.author_id);
    if (r === "sponsor-side") {
      sponsorSide.add(`${m.author_id}|${ch?.sponsor ?? "event"}`);
      anySponsor.add(m.author_id);
    }
  }
  return (m) => {
    if (!m.author_id) return "other";
    if (organizer.has(m.author_id)) return "organizer";
    const ch = sponsors[m.channel_name];
    const event = !ch || ch.sponsor === "event";
    if (event ? anySponsor.has(m.author_id) : sponsorSide.has(`${m.author_id}|${ch.sponsor}`)) return "sponsor-side";
    return "other";
  };
}
