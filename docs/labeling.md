# Day-2 labeling rules (`review/labels.csv`)

The sheet is the day-2 gate's ground truth (D12). Labels never feed the classifier. Label columns use the credit sheet's names (`review/credits.csv`, D13), so `hr sheet` can pre-fill the day-4 pass from single-credit rows.

- Build or refresh it with `bun run hr pool`. Re-running never touches a label column.
- Check what you've entered with `bun run hr pool --check`.
- `review/` is gitignored because it holds workspace message text.

## Opening the sheet

The file is UTF-8 CSV. In Google Sheets, use File → Import and untick **Convert text to numbers, dates, and formulas**. Otherwise posts that start with `@channel` or `-` and the ISO times get mangled. In Numbers, just open it. Export back to CSV under the same path.

## Rows

There is one row per message, in `sponsors.json` channel order, then by time.

- `pool = keyword`: the message matched the design doc's keyword list in the baseline. This covers 187 top-level hits in the locked 25, plus 6 replies that were also sent to the channel.
- `pool = random`: one of the 30 random top-level non-hits (miss check 2, seed in `review/pool.json`).
- `pool = flagged`: added later. The classifier flagged these as credit or dated outside the keyword hits (miss check 1).
- `subtype = thread_broadcast`: a thread reply also sent to the channel. Label it like any other row. The gate reports these 6 separately from the 187.
- `in_capture = n`: the extension didn't capture this message. Label it from `text`, which is then the baseline's Slack markup. Day 1 had 0 such rows.

Label every row the same way. Don't let `pool` change your answer.

## Columns

Use exactly these values. Leave a cell empty when it doesn't apply.

| Column | Values | Rule |
|---|---|---|
| `is_credit` | `y` / `n` | `y` if the post offers hackers something they can claim without winning: API or cloud credits, free usage, promo codes, discounts. Credits that only go to prize winners are `n` (write "prize" in `notes`). |
| `is_dated` | `y` / `n` | `y` if the post states a time limit for hackers to act: a deadline (submission, form, claim, RSVP) or a claim window. Start times of talks or food are not limits. It's `y` exactly when `deadline_iso` or `window_end` is filled, or `deadline_status` is `unresolved`. |
| `exclude` | `y` / `n` | `y` if the post talks about credits or a deadline but offers nothing. Examples: a hacker's question ("do we only get $5 of credit?"), a complaint, "codes ran out". Then `is_credit = n`. |
| `credits_in_post` | `0`, `1`, `2`… | The number of distinct credit offers in the post. Fill the amount fields below only when it is `1`. For `2` or more, describe them in `notes`. |
| `amount_text` | text | The amount exactly as written, e.g. `$50 in Azure credits`, `up to $200`, `1M tokens`. |
| `amount_usd_per_person` | number | Only when the post states a USD amount per person, e.g. "$50 credits for every hacker" → `50`. Never compute one: $100 per team is not $25 a person. Leave it empty for up-to, per-team, pool, tokens and hours. No `$` sign. |
| `amount_basis` | `per_person` / `per_team` / `pool` / `up_to` / `unknown` | How the stated amount is given out. `unknown` if an amount is stated with no basis. |
| `deadline_iso` | `2026-10-25T09:00-07:00` | The deadline the post asks hackers to act by, in event time (`-07:00` that week). If there are several, use the credit's deadline, else the earliest, and list the others in `notes`. If a date is stated with no time, use `T23:59` and write `date-only` in `notes`. |
| `deadline_status` | `explicit` / `resolved_relative` / `unresolved` / `none` | `explicit`: a calendar date is stated ("Oct 25, 9am"). `resolved_relative`: you worked it out from the post time or the schedule ("tonight", "Sunday 9am", "end of hacking"). `unresolved`: a deadline is mentioned but can't be pinned ("soon", "while supplies last"). `none`: no deadline. |
| `window_end` | `2026-10-24T19:00-07:00` | The end of a claim window stated in the post itself ("handing out credits 6–7pm", "$50 credits at the workshop happening now" with a stated end). Leave it empty if the post states no end (D15). |
| `notes` | text | Anything the columns can't hold: `prize`, `date-only`, other deadlines, multi-credit details. |

## What the gate reads

- Credit positives: `is_credit = y`. Dated positives: `is_dated = y`.
- Capture recall: positives with `in_capture = y` out of all positives.
- Field accuracy:
  - `amount_usd_per_person` exact (an empty cell must stay empty) on single-credit rows.
  - `deadline_iso` to the day, or to the minute when a time is stated (no `date-only`).
- Every percentage is reported with its count, top-level and `thread_broadcast` rows separately.
