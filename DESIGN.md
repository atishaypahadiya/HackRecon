---
# gstack: design-md-format=spec
name: HackRecon
description: Daylight glass. A faint warm field behind near-opaque white tiles; every color and effect carries information, every mark is real data, and the board gets quieter as you claim things.
colors:
  ground: "#F4F1EA"
  surface: "rgba(255,255,255,0.90)"
  surface-solid: "#FFFFFF"
  text: "#15171C"
  text-muted: "#585C66"
  primary: "#15171C"
  on-primary: "#FFFFFF"
  line: "rgba(21,23,28,0.08)"
  dim: "rgba(21,23,28,0.12)"
  success: "#16794A"
  success-mark: "#22A35A"
  warning: "#9A5600"
  warning-mark: "#F5A524"
  info: "#2457C5"
  error: "#B4322C"
  field-sun: "#FFC94D"
  field-peach: "#FF9E6E"
  field-sky: "#9FC2FF"
typography:
  display:
    fontFamily: Manrope
    fontWeight: 700
    fontSize: clamp(44px, 6vw, 72px)
    letterSpacing: -0.035em
    fontFeature: tnum
  numeral:
    fontFamily: Manrope
    fontWeight: 700
    fontSize: 40px
    letterSpacing: -0.03em
    fontFeature: tnum
  lead:
    fontFamily: Manrope
    fontWeight: 600
    fontSize: 20px
    letterSpacing: -0.01em
  title:
    fontFamily: Manrope
    fontWeight: 650
    fontSize: 17px
  body:
    fontFamily: Manrope
    fontWeight: 500
    fontSize: 15px
    lineHeight: 1.5
  label:
    fontFamily: Manrope
    fontWeight: 650
    fontSize: 12px
    letterSpacing: 0.04em
  mono:
    fontFamily: Atkinson Hyperlegible Mono
    fontWeight: 600
    fontSize: 14px
    letterSpacing: 0.03em
  meta:
    fontFamily: Atkinson Hyperlegible Mono
    fontWeight: 400
    fontSize: 12px
rounded:
  dot: 2px
  chip: 10px
  tile: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  gap: 12px
  md: 16px
  tile: 20px
  lg: 24px
  xl: 40px
components:
  tile:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.tile}"
    padding: "{spacing.tile}"
  code-chip:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    fontFamily: "{typography.mono.fontFamily}"
    rounded: "{rounded.chip}"
    height: 36px
  claim-button:
    backgroundColor: "{colors.surface-solid}"
    textColor: "{colors.text}"
    borderColor: "{colors.dim}"
    rounded: "{rounded.chip}"
    height: 36px
---

# HackRecon

## Overview

**Creative North Star:** Daylight glass, after Flux (Orbix Studio, `docs/design-refs/flux-3.png`): a warm, sunlit field behind near-opaque white tiles. The material is soft; the content is exact. It fits first-time hackers in bright venue halls and an MLH projector because every tile stays legible while the page still feels like a real product.
**Product context:** HackRecon's board: a hackathon's sponsor offers (credits, codes, claim links, deadlines) found in its Slack, for first-time hackers on laptop and phone, plus a replay of the week for an MLH screen-share. Local single page on 127.0.0.1 under a strict CSP.
**Mode per surface:** Board: Operate (grab offers, mark them done). Replay: a short Experience moment. Drawer: Read (evidence, Slack links).
**Reference sites:** docs/design-refs/flux-1..5.png; https://superdesign.dev/library/premium-glassmorphism-dashboard-with-smooth-edge-to-edge-line-charts; https://www.shadcnblocks.com/block/dashboard3; https://dribbble.com/orbixstudiodashboard.
**Memorable thing (user):** there's free stuff here; it read 977 posts so I didn't have to; it feels precise and real; and the ease of mind of knowing I've taken everything relevant to me.
**Key characteristics:**
- One huge count ("20 offers") over a field of 977 dots with the offer posts lit.
- Ink-black action chips: a code you copy, or Claim.
- Numbers only where a post states them; hatching where it doesn't.
- The board gets quieter as you claim: rows strike through and fade, the hero counts what's left.

## Colors

**Strategy:** Restrained. **The test (user, 2026-10-28): removing a color or effect must lose information, or it goes.** Ink is the only action color. Hue appears only on marks where it is the sole way to tell two kinds apart: green = a post or day with an offer (matrix dots, activity day markers), amber = an offer's claim window and close (timeline, set against ink organizer deadlines). Single-series marks (the reps ring and pips, the priced bar) are ink. **No colored text, ever:** status words carry their own meaning ("Closes", "Closed", "New", "Done"). Blue and red remain tokens but are unused on the board.
**Light or dark:** Light. The scene is bright venue halls, laptops at full brightness and a projector, where dark UIs wash out. No dark theme for now; tokens are named so one can be added.
The field (sun, peach, sky) exists only on the background layer, blurred 120px at 35% opacity, low enough that no tile competes with it; it never carries text. Tiles are 90% white with no backdrop-filter, so contrast is measured against a tile over the most saturated field stop: ink 16.7:1, muted 6.2:1, green 5.1:1, amber 5.3:1, blue 6.0:1, red 5.7:1. Marks (dots, bars, timeline pins) use the brighter `success-mark` / `warning-mark` and never carry text. Under `prefers-reduced-transparency`, tiles go solid white and the field is hidden.

## Typography

Manrope (OFL-1.1, variable 200–800) for everything a person reads, with tabular figures on so scrubbing never jitters the numerals. Atkinson Hyperlegible Mono (OFL-1.1) for promo codes (14/600: it separates 0/O and 1/l/I for someone retyping a code on a phone) and for all metadata (12/400 muted: counts, dates, status words, "posted …", axis ticks, captions under numerals). Numbers are never emphasized by weight or color; every number carries its context ("of 977 posts", "3 of 20 priced", "as stated"). Both are self-hosted woff2 files in `board/fonts/` (Fontsource latin subsets, about 43 KB total) served by `hr board` under `font-src 'self'`; their OFL texts sit beside them. Hierarchy comes from size steps that differ by far more than weight: display 72, numeral 40, lead 20, title 17, body 15, label 12.

## Layout

12-column bento grid, max width 1320px, 12px gaps, 20px tile padding (16px under 600px).
- Desktop (≥ 1100px): Hero 7 col × 2 rows | Value 5 col, Closes soon 5 col stacked. Activity 12 col with the scrubber. Offer stream 8 col (the largest tile) | Reps 4 col.
- Tablet (600–1099px): Hero 12; Value and Closes soon 6 + 6; Activity 12; Offer stream 12; Reps 12.
- Phone (< 600px): Hero, Offer stream, Closes soon, Value, Reps, Activity, in that order (actions before analysis). The scrubber also docks as a bar at the bottom of the viewport so the replay is reachable while reading offers.
- The drawer is a right sheet 440px wide on desktop and a bottom sheet (88vh) on phone.

## Elevation & Depth

Depth comes from the field behind the tiles, not from the tiles. A tile is a 1px `line` border and no shadow; hover darkens the border (no lift). The drawer sits above a 30% ink scrim with no shadow. Shadows remain only where an element floats over content with nothing else to separate it: the phone dock and the slider thumb. No glows, no zero-offset halos.

## Shapes

Tiles 16px. Chips and buttons inside tiles 10px (16 − 6 visual inset). Dots 2px on 7px squares. Rings and the play button are the only full rounds. Hatching for "value not stated": 135° stripes of muted at 42%/10%.

## Components

- **Tile:** whole tile is a button that opens its drawer (hover: shadow lifts 2px; focus-visible: 2px ink ring at 3px offset). Header: title 13/650 muted left, context right.
- **Hero:** count, lead sentence, dot matrix (one dot per real post in time order; offer posts lit green). Hovering a lit dot shows its offer; clicking opens it in the drawer. Shows "N left for you" once anything is marked done.
- **Code chip:** ink background, mono 14/600, 36px tall (44px hit area). Click copies; label flips to "Copied" for 1.4s, and the offer is marked done.
- **Claim:** ghost button (white, 1px `dim` border, ink text) "Claim ↗", opens the claim link in a new tab and marks the offer done. Code chips stay ink: the code is the thing you take.
- **Done state:** per viewer, in browser storage only. The row fades to 42% and its metadata reads "Done"; its matrix dots fade the same. A "Mark not done" control lives in the drawer.
- **Micro-charts (hand-rolled SVG, drawn in pixels):** posts-per-day bars in ink at 78% on a square-root scale with each day's exact count under it, a green dot under each day an offer first appeared; the stacked priced/unpriced bar (ink / hatched); the reps ring (ink arc on a 12% track, 8px stroke, round caps); the deadline timeline (amber claim windows and pins, ink organizer-deadline ticks, ink "now" tick, a key).
- **Empty, early frames:** each tile states its zero plainly ("No deadlines yet"), never a fake chart.
- **Tabs (v2):** `role="tablist"`. Each tab is Manrope 15/600 text, 44px tall: muted when inactive; ink with a 2px ink underline when active (`aria-selected="true"`). The underline is the only indicator: no pills, no counts, no background. Arrow keys move between tabs (roving tabindex), Home and End go to the first and last, and Enter or Space activates.
- **Checkbox (v2, Plan entry steps and Ship):** a styled native `<input type="checkbox">` with `appearance: none`, never a div. 18px square, 1.5px `muted` border, 4px radius; when checked, ink fill with a white tick; the 2px ink focus ring at 3px offset; a 44px hit row via its `<label>`. When checked, the label takes the existing done state (42%).
- **Drawer:** title, close (Esc), then the tile's full detail: offer list, deadlines, reps, evidence excerpts, and Slack links.

## Do's and Don'ts

- Do keep every number traceable to posts; unpriced stays hatched with "value not stated".
- Do keep text on tiles only, never on the field.
- Do give every interactive element a 44px hit area and a visible focus ring.
- Do recompute every tile from the scrubber frame.
- Don't add backdrop-filter to tiles, or a second translucent layer.
- Don't use the field colors, gradients or glows for emphasis; emphasis is size or weight.
- Don't show a sparkline, ring or delta that isn't real data.
- Don't nest a tile inside a tile; the drawer is the place for more.

## Motion

- **Approach:** intentional.
- **Easing:** enter ease-out `cubic-bezier(.2,.8,.2,1)`, exit ease-in, move ease-in-out.
- **Duration:** micro 120ms (chip press), short 200ms (hover, done), medium 320ms (drawer, row reorder), long 480ms (count-up).
- **The one authored moment:** the replay. Scrubbing lights the dots in time order while the numerals count and the bars grow. Instant under `prefers-reduced-motion`.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-28 | Initial design system created | /design-consultation from the Flux refs, 4 researched sites and one independent Claude subagent ("Lightbox & Highlighter"). Adopted from it: hatching for unpriced, the done state (also in my draft), Atkinson Hyperlegible Mono for codes. User chose risks R1 (board gets quieter), R2 (977-dot hero), R4 (Atkinson Mono); declined R3 (highlighter swipes). |
| 2026-10-28 | Bento board built; /design-review at 1440 and 390 | Activity bars use a square-root scale (one day has 490 posts, most under 40) and print every day's exact count; the phone dock carries its own scrubber; DOM order follows the phone order. Open question for the user: secondary text is 13px and dense lists 14px, which the type scale doesn't name (add a 13 "small" step, or move them to 12/15). |
| 2026-10-28 | De-slop pass (user) | Test: removing a color or effect must lose information, or it goes. Claim buttons ghost; no colored text; metadata in mono 12/400 muted; numbers get context, never emphasis; tile and drawer shadows and the hover lift removed; field at 35%. Reps ring, pips and priced bar to ink. Kept: green offer dots/day markers, amber deadline marks, hatching, done-fade, dock and thumb shadows. |
| 2026-11-06 | Plan exception to the tile rule (/plan-design-review D7, user) | On Plan only, Tracks and Credits are tiles and a tile is a container: each row is the button that opens its drawer (no button inside a button; one focus stop per item). Sessions, Booths and reps, and People are plain sections: heading plus rows, no card border or background. Everywhere else, the whole tile stays a button. |
| 2026-11-06 | Tabs and checkbox added (/plan-design-review D9, user) | v2's five tabs are text with an ink underline as the only active indicator (role=tablist, arrow keys, aria-selected). Entry-step checkboxes are styled native inputs (appearance: none), so keyboard, focus and screen readers work without custom code. Both are ink only: the new marks are shapes, not colors. |
