# CLAUDE.md

## gstack

- gstack skills live in `.claude/skills/gstack`.
- Use `/browse` for all web browsing.
- Skills in use for this project:
  - `/office-hours`
  - `/plan-eng-review`
  - `/review`
  - `/qa`
  - `/investigate`
  - `/retro`
- If gstack skills fail to load or run, rebuild them with:

  ```bash
  cd .claude/skills/gstack && ./setup
  ```

## Git workflow

- Start each piece of work on a new branch from an up-to-date `main` (`git switch main && git pull --ff-only && git switch -c <type>/<name>`).
- Push only to the current feature branch. Never push to `main` directly; work reaches `main` only through a PR.
- Open the PR once the work is verified (tests, typecheck and extension build pass, plus any live check the work calls for). CI must be green before a merge.
- Commit and push doc and plan changes (docs/designs/*, TODOS.md) without asking. Commit and push product code without asking when `bun test` passes; if it fails, show the failures and ask first.
- Merge your own PR without asking once CI is green and the full local run passes (`bun test`, `tsc --noEmit`, `bun run build:ext`); tell the user after, with the PR link. Ask first for a PR that deletes data, changes the extension's permissions or the Slack read-only allowlist (`READ_METHODS`), or touches the cost guard (`pipeline/costguard.ts` or its callers' limits).
- Delete a branch locally and on origin once its PR is merged.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate, unless one read-only check confirms the cause and a narrow fix (then fix it and run the focused test)
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Design System
Read DESIGN.md before visual or UI work: it defines the fonts, colors, spacing, and
aesthetic direction. Ask the user before departing from it. When reviewing or QA-ing
UI, flag code that doesn't match DESIGN.md.
