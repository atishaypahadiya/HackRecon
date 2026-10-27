# Day-2 labels (`review/labels.csv`)

**The labels are written by an LLM judge, not by a person (D21).** `hr prelabel` has `claude-opus-5-5` fill the label columns of every row, under the rules in the Columns section below. Opus is a demo-time eval: it gives the classifier something to be scored against before the demo. It is not ground truth, and labeling is not a user step. `hr gate` therefore reports **agreement with Opus**, not accuracy, and the receipt footnote says the same.

Labels never feed the classifier. Label columns use the credit sheet's names (`review/credits.csv`, D13), so `hr sheet` can pre-fill the day-4 credit pass from single-credit rows. That pass is an Opus pass under the same rule.

- Build or refresh the sheet with `bun run hr pool`. Re-running never touches a label column or `labeler`.
- Label it with `bun run hr prelabel`, then score with `bun run hr gate`.
- Check the sheet with `bun run hr pool --check`.
- `review/` is gitignored because it holds workspace message text.

## How Opus labels (`hr prelabel`)

- **Same input as the classifier.** Each row is sent with exactly the redacted text Haiku gets, built by the same code (`pipeline/inputs.ts`): channel, channel sponsor, poster_role, posted_at, links and the post. Names are redacted before any API call. A row the capture missed is sent with its baseline text through the same redaction.
- **The rules, verbatim.** The system prompt holds the Columns section of this file word for word, plus the event schedule from `config/event.json`. The classifier's prompt holds the same section, so both models read one set of rules. Editing that section changes both prompt hashes, which means a full reclassify as well as a relabel. So does editing the schedule. `hr gate` then calls the Opus labels stale until `hr prelabel` runs again. Edits elsewhere in this file don't change the prompt.
- **Blind to Haiku.** The judge never reads `data/items.json`, the classify cache or run record, or `review/pool.json`, and it never sees the `pool` column. A test checks that none of its code names them.
- **Model settings.** `claude-opus-5-5` at effort `high` (thinking is always on for this model), JSON output with the label columns, and the system prompt cached across rows. Each answer must pass the same checks as `hr pool --check`. One that fails is retried up to 2 times; after that the row is left unlabeled and listed as an error.
- **Output.** Answers go into the label columns, with `labeler = opus-5-5`. A row with no current answer (failed, or its input or prompt changed) is cleared, so the gate never scores an old answer. Answers are cached in `review/prelabel_cache.json`, so a rerun only pays for new or changed rows. The run record, with token counts and list-price cost, is in `review/prelabel_run.json`.
- **Hand-labeled rows** (`labeler = hand`) are kept unless you pass `--include-hand`. With no hand rows the gate says "agreement with Opus". With some, it says "agreement with these labels" and lists who labeled how many rows.
- **Before paying:** `bun run hr prelabel --dry-run` prints the system prompt, one request and the row counts, with no API call. `--limit N` labels only N new rows.

## Hand corrections (optional, `hr label`)

`bun run hr label` (add `--open`, `--port N`) serves a page on http://127.0.0.1:4317/ for fixing a row by hand. It isn't part of the eval.

- One row at a time, with its text, links, channel, sponsor, author, time (PT) and an "open in Slack" link.
- Keys:
  - `c` / `d` toggle credit / dated and show their fields.
  - `n` saves the row as neither, `x` as excluded.
  - `Enter` saves and moves on, `←`/`→` move between rows, and `u` jumps to the next unlabeled row.
- Every save is checked like `hr pool --check` and sets `labeler = hand`.
- The page never sees classifier output or the `pool` column.
- Stop it before running `hr prelabel`. Close the sheet in any spreadsheet app while either one writes it.

## Opening the sheet

The file is UTF-8 CSV. In Google Sheets, use File → Import and untick **Convert text to numbers, dates, and formulas**. Otherwise posts that start with `@channel` or `-` and the ISO times get mangled. In Numbers, just open it. Export back to CSV under the same path.

## Rows

There is one row per message, in `sponsors.json` channel order, then by time.

- `pool = keyword`: the message matched the design doc's keyword list in the baseline. This covers 187 top-level hits in the locked 25, plus 6 replies that were also sent to the channel.
- `pool = miss_check`: a row from either miss check:
  - one of the 30 random top-level non-hits (miss check 2);
  - a non-hit the classifier flagged as credit or dated (miss check 1, added by `hr pool --add-flagged` after a full `hr classify`).

  The sheet doesn't say which, so a row's pool never tells you what the classifier thought. Membership is in `review/pool.json`.
- `subtype = thread_broadcast`: a thread reply also sent to the channel. Label it like any other row. The gate reports these 6 separately from the 187.
- `in_capture = n`: the extension didn't capture this message. Label it from `text`, which is then the baseline's Slack markup. Day 1 had 0 such rows.
- `labeler`: who wrote the row's label columns: `opus-5-5` (`hr prelabel`) or `hand` (`hr label`). It's empty on unlabeled rows. A row labeled before this column existed counts as `hand`.

Label every row the same way. Don't let `pool` change your answer. The judge never sees it.

## Columns

Use exactly these values. Leave a cell empty when it doesn't apply.

| Column | Values | Rule |
|---|---|---|
| `is_credit` | `y` / `n` | `y` if the post offers hackers something they can claim without winning: API or cloud credits, free usage, promo codes, discounts. Credits that only go to prize winners are `n` (write "prize" in `notes`). |
| `is_dated` | `y` / `n` | `y` if the post states a time limit for hackers to act: a deadline (submission, form, claim, RSVP) or a claim window. Start times of talks or food are not limits. It's `y` exactly when `deadline_iso` or `window_end` is filled, or `deadline_status` is `unresolved`. |
| `exclude` | `y` / `n` | `y` if the post talks about credits or a deadline but offers nothing. Examples: a hacker's question ("do we only get $5 of credit?"), a complaint, "codes ran out". Then `is_credit = n`. |
| `credits_in_post` | `0`, `1`, `2`… | The number of distinct credit offers in the post. Required when `is_credit = y`. Fill the amount fields below only when it is `1`. For `2` or more, describe them in `notes`. |
| `amount_text` | text | The amount exactly as written, e.g. `$50 in Azure credits`, `up to $200`, `1M tokens`. |
| `amount_usd_per_person` | number | Only when the post states a USD amount per person, e.g. "$50 credits for every hacker" → `50`. Never compute one: $100 per team is not $25 a person. Leave it empty for up-to, per-team, pool, tokens and hours. No `$` sign. |
| `amount_basis` | `per_person` / `per_team` / `pool` / `up_to` / `unknown` | How the stated amount is given out. `unknown` if an amount is stated with no basis. |
| `deadline_iso` | `2026-10-25T09:00-07:00` | The deadline the post asks hackers to act by, in event time (`-07:00` that week). If there are several, use the credit's deadline, else the earliest, and list the others in `notes`. If a date is stated with no time, use `T23:59` and write `date-only` in `notes`. |
| `deadline_status` | `explicit` / `resolved_relative` / `unresolved` / `none` | `explicit`: a calendar date is stated ("Oct 25, 9am"). `resolved_relative`: you worked it out from the post time or the schedule ("tonight", "Sunday 9am", "end of hacking"). `unresolved`: a deadline is mentioned but can't be pinned ("soon", "while supplies last"). `none`: no deadline (with `is_dated = y` only when `window_end` is filled). |
| `window_end` | `2026-10-24T19:00-07:00` | The end of a claim window stated in the post itself ("handing out credits 6–7pm", "$50 credits at the workshop happening now" with a stated end). Leave it empty if the post states no end (D15). |
| `notes` | text | Anything the columns can't hold: `prize`, `date-only`, other deadlines, multi-credit details. |

## What the gate reads

`bun run hr gate` scores only labeled rows: `is_credit` and `is_dated` both filled, and nothing malformed. Other rows are skipped and counted, and nothing the classifier said about them is printed. A row where one of the two is filled counts as incomplete; check it with `hr pool --check`.

- **Reference.** The report opens by naming its reference labels: how many rows each labeler wrote, plus the judge's model and prompt hash. With Opus labels it says every percentage is agreement with Opus, not accuracy. Failed bars are named `amount_agreement` and `deadline_agreement`, and miss lists read `opus: … classifier: …`. The thresholds and per-metric counts are unchanged. Opus labels with no run record, or from a prompt the config no longer gives, are stale and keep the result provisional.
- Credit positives: `is_credit = y`. Dated positives: `is_dated = y`. A message is predicted credit if it has a `credit` item, and dated if any item has a deadline status other than `none`.
- Precision and recall cover the keyword hits plus the labeled rows the classifier flags outside them (D12). The random 30 and the flagged rows are each reported separately as miss checks.
- Capture recall: positives with `in_capture = y` out of all positives.
- Field agreement:
  - `amount_usd_per_person` exact on single-credit rows. An empty cell must stay unpriced, and a missed credit item counts as wrong.
  - `deadline_iso`, or `window_end` when there is no deadline, matched by any classifier deadline in the post: to the minute when a time is stated, to the day when `notes` says `date-only`.
  - `unresolved`-only labels are reported apart.
- Every percentage is reported with its count, top-level and `thread_broadcast` rows separately.
