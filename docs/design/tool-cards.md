# Tool cards

Why the `balanced` and `full` cards look the way they do. The user-facing table is in `docs/layout.md` (Tool cards).

## What the others do

Read locally and read-only: pi 0.85.1 (`@earendil-works/pi-coding-agent` renderers), legacy MendCode (`src/mendcode/.../tui/routes/session/index.tsx`),
`.agents/plans/competitor-gaps-2026-10-02.md`. Not found locally: Codex CLI sources (only the installed binary, whose TUI cannot be read),
OpenClaude (the recovery-research folder is empty), grok-cli. Nothing was cloned or fetched.

| | read / list / search | shell | edit | web / sub-agent |
|---|---|---|---|---|
| pi | one call line per tool: bold title, path, `:start-end` range in warning; result body only expanded | 5-line preview, `Took` / `Elapsed` footer, background tint for pending / ok / error | word-level inverse on the changed tokens, leading whitespace not marked | no cards (extensions) |
| legacy MendCode | `InlineTool` row: icon, `Grep "x" (12 matches)`, spinner while pending; `↳ Loaded path` rows | block with a 10-line tail, expands | diff block with a patch | `Task` row with a link to the child session |
| Codex CLI | not found locally | not found locally | not found locally | not found locally |

Adopt: one row per looking tool with facts after the target (v1, pi); the range in the header (pi); a short tail with an
elapsed time (pi, v1); intraline highlights (pi); a status colour instead of a box (pi tints).
Avoid: a body for every read (pi shows none until expanded, v1 none); a coloured background per card (it fights the diff
backgrounds); one list entry per row; the last lines of a file.

## The frame

`▤ Read README.md  123 lines                               2.4s`, then a thin rule `│` holding the body.

- Glyph per kind, coloured by status. Target bold, facts muted, duration right-aligned from 1 s. A running call puts its time
  after the facts: the bottom-right corner belongs to the pet, which hides when a row reaches it.
- Nothing in the body repeats the header: a passing `bun test` is `241 pass · 0 fail` in the header and has no body; a read
  header says its range and the body starts at the first line.
- Content in the form that suits it: a list is a grid, a search is grouped by file, source is highlighted with a muted
  gutter, a diff has two number columns and marks what changed inside a line, an unknown tool says the shape of its result.
- Density scales with the view: `balanced` is the header and at most 3 grid rows or 3 files; `full` is 6. `minimal` is untouched.
- Graph cards: the visual is the content. One muted summary row in `balanced`, a table of at most 6 rows in `full`, the whole
  lists only when the card is opened (`detail` nodes in the render spec).
- A call with a long input (a whole file, a long script) opens its card while the model still writes it, on every engine: the
  native one (Responses, Anthropic Messages and Chat Completions providers) and Claude Code. After 1,500 characters the card shows
  the call with what its input names so far and `writing 84 lines · 6.2 KB` (at most every 2,000 characters), so the working row
  never reads as stalled; once the input is whole the same card runs the tool, renamed if the whole input names it differently.
  A stream that stops first closes it as cancelled or failed, and nothing runs. Plan, secrets and `task` calls wait for their
  whole input.
- Display only. The model, `/find`, `/copy` and `/export` keep the whole result; finished cards are cached by item id.
