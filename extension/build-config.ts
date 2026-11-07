// Writes extension/dist/sync-config.json from the current event's config: which channels "Sync this event" takes
// (user 2026-11-06: every sponsors.json channel, event channels included, plus event.json authority_channels;
// sidebar prefixes only discover channels the config doesn't list yet), and each sponsor's names for signal 2b's
// match in hacker-only channels. Config only; no workspace content.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANON_PATH, EVENTS_DIR, SPONSORS_PATH, EVENT_PATH } from "../pipeline/event.ts";
import { syncConfigFrom } from "./src/thread.ts";

const dir = join(EVENTS_DIR, "current");
const read = (p: string) => (existsSync(join(dir, p)) ? JSON.parse(readFileSync(join(dir, p), "utf8")) : null);
// Track names from canon (the public Devpost page), to find the prize checkboxes on the user's own submission.
const tracks = ((read(CANON_PATH) ?? []) as { entities: { kind: string; name: { value: string | null } }[] }[]).flatMap((p) => p.entities.filter((e) => e.kind === "track" && e.name.value).map((e) => e.name.value!));
const cfg = syncConfigFrom(read(SPONSORS_PATH) ?? {}, read(EVENT_PATH) ?? {}, tracks);
mkdirSync(join(import.meta.dir, "dist"), { recursive: true });
writeFileSync(join(import.meta.dir, "dist", "sync-config.json"), JSON.stringify(cfg, null, 2));
console.log(`sync-config.json: ${cfg.event || "no event"}, ${cfg.channels.length} channels from config, ${tracks.length} Devpost tracks`);
