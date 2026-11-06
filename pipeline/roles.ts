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

export interface Organizer {
  id: string;
  name: string;
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
    return why.length ? [{ id: u.id, name: u.profile?.display_name || u.real_name || u.name || u.id, why }] : [];
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
