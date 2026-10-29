# Markdown rendering: Prismantis comparison and the `full` renderer

Question: does MendCode's `full` message renderer have Markdown as nice and as configurable as Prismantis (a Claude Code
mod)? This page compares them feature by feature, says what was added and what was left out, and lists every colour slot
and setting. The Prismantis side is its README feature list as given in the request; no network was used and nothing of
Prismantis is copied.

"Before" is `3ce2cea` (main when this work started); "now" is this branch. Frames of the torture document
(`apps/cli/test/fixtures/markdown-torture.md`) at 80, 120 and 200 columns are in `.agents/runs/frames/markdown/`.

## Comparison

| Feature | Before | Now |
|---|---|---|
| Colour palettes | Partial: 40 bundled themes (8 own + 32 v1 ports), `/theme`, theme files; no Markdown-specific roles. `themes/index.ts:13`, `themes/define.ts` | Have: every Markdown token has a named slot (28), derived per theme and overridable one by one from a theme file or `/customize`. `themes/define.ts` `markdownRoles`, `ui/theme.ts` `setColorOverrides` |
| Customisable colour slots | Partial: 6 `syn*` roles plus `heading`, `code`, `link`, `border`; Markdown shared them | Have: 28 `md*`/`syn*` slots below; `markdownColors` in the profile |
| Code header with language | Partial: a `│ ts` row, only when a language was given. `markdown.ts:155` | Have: `╭─ ts ──── copy` on every fence (`text` when none). `markdown.ts` `codeHeader` |
| Copy button on code | Missing (`/copy` and ctrl+x y copy a whole answer) | Have: right-aligned `copy`, click or `ctrl+x Y`. `markdown-chrome.ts` `blockHeader`, `ui/app/mouse-selection.ts`, `ui/app/block-copy.ts` |
| Syntax highlighting | Partial: 6 languages (ts/js, json, bash, python, go, rust) plus diff and md. `syntax.ts:44` | Have: 23 (list below). `syntax.ts` `LANGUAGES` |
| Shell prompts by command / flag / string / comment | Partial: command, string, comment, variable; no flags, no prompt. `syntax.ts:228` | Have: prompt, command, flag, string, variable, comment. `syntax.ts` `PROMPT`, `flags` |
| Diff blocks | Partial: coloured text only. `syntax.ts` `lineStyled` | Have: plus a gutter bar per line kind. `markdown.ts` `diffBar` |
| Long code lines | Have: wrapped behind `↪`. `markdown.ts:335` | Same (no clip setting exists; wrapping is the only mode) |
| Table header colour | Have: `heading`, bold. `markdown.ts:418` | Have: own slot `mdTableHeader` |
| Column alignment (`:---:`, `---:`) | Have. `markdown.ts:381` | Have, in every style |
| Table box styles | Missing: one box | Have: `box`, `rules`, `grid`, `minimal` (`tableStyle`). `markdown-table.ts` |
| Column sizing to the width | Have: widest-first shrink, wrapping in cells, wide-char safe. `markdown.ts:389` | Have, same engine; adds a stack threshold (below) |
| Very wide tables | Partial: stacked only when columns cannot reach 3 cells. `markdown.ts:457` | Have: stacked when the longest words (capped at 10 cells) do not fit or a column would be under 4 cells. `markdown-table.ts:70` |
| Mermaid as ASCII, sized to the width | Have: 31 families through `renderMermaid(source, width)`. `mermaid/registry.ts`, `mermaid.ts:41` | Same; copy of source and of the art, diagram roles. Empty padding rows trimmed |
| Mermaid bar/line charts | Have: `xychart-beta` bars and lines, also `pie`, `gantt`, `quadrantChart`. `mermaid/xychart.ts` | Same |
| Heading styles | Missing: every level the same bold heading colour. `markdown.ts:192` | Have: `banner`, `bold`, `underline`, `uppercase` (`headingStyle`), level hierarchy in all. `markdown-chrome.ts` `headingRows` |
| Nested and ordered lists | Have (4 levels). `markdown.ts:289` | Same |
| Task lists with indicators | Partial: `[x]` / `[ ]` text. `markdown.ts:297` | Have: `✓` / `○`, own slots |
| Bold, italic, strikethrough, inline code | Partial: strikethrough was dimmed, not struck. `markdown.ts:482` | Have: strikethrough is struck (`strike`) |
| Block quotes and callouts | Partial: single bar, no nesting, no callouts. `markdown.ts:205` | Have: nested quotes, `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` with a coloured rail |
| Links | Have: OSC 8 through `safeLink` and the `hyperlinks` setting; `(url)` shown after a label. `markdown.ts:10`, `ui/hyperlink.ts` | Have, plus underline |
| Footnotes | Missing | Have: `[^1]` references as superscripts, `[^1]: text` definitions |
| Horizontal rules | Partial: 40 cells, dim. `markdown.ts:202` | Have: full width, own slot |
| Copy buttons on tables, lists, quotes, diagrams | Missing | Have: `copy` on the top border of boxed tables, `art  copy` beside a diagram, by key on lists and quotes (no visible chrome). Never in minimal; code only in balanced |
| Right-to-left text | Missing | Have, with limits (below): paragraphs, headings, lists and quotes |
| Settings file | Partial: `tui/profile.json` and `/customize`, nothing for Markdown | Have: `tableStyle`, `headingStyle`, `markdownCopyHints`, `markdownRtl`, `markdownColors` in `profile.json`, rows in `/customize` with a live preview |

### Where MendCode is already ahead

- **Mermaid is a real subsystem, not one renderer**: 31 diagram families with a lazy-loaded layout engine
  (`mermaid-lazy.ts`, no cost until the first fence), width-aware layouts with a "too wide" fallback to source, and a
  full-screen pan-and-zoom viewer (`/diagram`, `ctrl+x i`, `mermaid-viewer.ts`) with a diagram list per session.
- **Streaming safety is designed in**: unclosed fences, half-typed tables and separators render what they have; the
  settled-prefix memo (`markdown.ts` `renderSettled`) re-renders only the open paragraph, with `markdown streaming and
  width safety` and `markdown-settled` tests proving the memo equals the whole renderer at every step.
- **Performance**: a 2,000-line torture document renders in about 9 ms at width 100, classic or enhanced (see Performance).
- **Math** (`$…$`, `$$…$$`, `\[…\]` as stacked Unicode), **collapsible `<details>`** with per-block fold state and a
  click or key to toggle, inline HTML (`<kbd>`, `<sub>`, `<sup>`, `<br>`), colour swatches next to hex colours.
- **Selection-aware copying**: a mouse selection copies the text without the code gutter, wrap markers or headers
  (`line-meta.ts` gutters), and wrapped lines rejoin without a space.
- **Three views from one engine**: minimal stays plain, balanced is calm, full is rich, switchable live with `/view`.

## What the `full` renderer does now

The enhanced engine runs only in the `full` message renderer, in the balanced and full views. `minimal` view, the
`markdown` renderer (diagrams as source) and the `plain` renderer keep the classic look, as does every other caller of
`renderMarkdown` (asides, sidebars, history pages). The transcript resolves the style per message
(`markdownStyleFor`, `markdown-style.ts`).

### Settings

All in `<dataDir>/tui/profile.json`, declared in both `apps/cli/src/view/tui-profile.ts` and
`packages/protocol/src/tui-data.ts`, with rows under Customize > Markdown and a live preview of a sample document.

| Setting | Values | `auto` means |
|---|---|---|
| `tableStyle` | `auto`, `box`, `rules`, `grid`, `minimal` | `box` in every view |
| `headingStyle` | `auto`, `banner`, `bold`, `underline`, `uppercase` | `underline` in full, `bold` in balanced |
| `markdownCopyHints` | `auto`, `code`, `all`, `off` | `all` in full, `code` in balanced (minimal has none) |
| `markdownRtl` | boolean, default on | |
| `markdownColors` | JSON object `{ "mdHeading1": "#rrggbb", … }`, any slot below | none |

Table styles: `box` is the full frame; `grid` adds a rule between every row; `rules` keeps horizontal rules only (top,
under the header, bottom) with two spaces between columns; `minimal` underlines each header column and nothing else.

Heading styles: every level has a role (h1, h2 heading colour; h3 text; h4-h6 body) and is bold. `banner` fills h1
(element background) and h2 (panel background) across the width and marks h3 with `▌`; `underline` rules h1 with `═` and
h2 with `─` as wide as the text; `uppercase` capitalises h1 and h2 (inline code and links keep their case).

### Colour slots

Every slot is derived from the base roles when a theme omits it, so all 40 bundled themes define them; a theme file may
set any (native format: `colors.mdHeading1`), and `markdownColors` overrides single slots over whichever theme is active
(not over the host-owned `terminal` theme). Line-like slots (`mdQuoteBar`, `mdTableBorder`, `mdRule`, `mdCodeBorder`) are
held to 3:1 against the background, the rest to 4.5:1.

| Slot | Token | Derived from |
|---|---|---|
| `mdHeading1`, `mdHeading2` | h1, h2 | `heading` |
| `mdHeading3`, `mdHeading4` | h3; h4-h6 | `text`; `body` |
| `mdInlineCode` | `` `code` `` | `code` |
| `mdStrike` | `~~text~~` | `muted` |
| `mdLink` | links and autolinks | `link` |
| `mdFootnote` | footnote references and labels | `link` |
| `mdQuote`, `mdQuoteBar` | quote text; its bar | `muted`; `border` |
| `mdNote`, `mdTip`, `mdImportant`, `mdWarning`, `mdCaution` | callout label and rail | `info`, `success`, `accent`, `warning`, `error` |
| `mdTableHeader`, `mdTableBorder` | table header; frame and rules | `heading`; `border` |
| `mdListMarker`, `mdTaskDone`, `mdTaskOpen` | bullets and numbers; `✓`; `○` | `muted`, `success`, `muted` |
| `mdRule` | horizontal rules, heading underlines | `border` |
| `mdCodeLabel`, `mdCodeBorder` | block header label; code gutter and header frame | `muted`; `border` |
| `mdCopy` | `copy` and `art` hints | `muted` |
| `mdDiagramLine`, `mdDiagramAccent` | diagram outlines and labels; arrows and markers | `heading`; `accent` |
| `synComment`, `synKeyword`, `synString`, `synNumber`, `synFunction`, `synType` | code tokens (unchanged) | as before |
| `synFlag` | shell options `-x`, `--long` | mix of `heading` and `link` |
| `synPrompt` | shell prompt `$` | `muted` |

Callout and heading backgrounds use the existing `element` and `panel` fills.

### Syntax highlighting

Per-line tokenizer, one regex pass, no dependencies. 23 languages: typescript (`tsx`, `js`, `jsx`, `mjs`, `cjs`), json
(`jsonc`, `json5`, `jsonl`), bash (`sh`, `zsh`, `shell`, `console`), python (`py`), go, rust (`rs`), c (`h`), cpp (`c++`, `cc`,
`hpp`), java, csharp (`cs`), kotlin (`kt`), swift, ruby (`rb`), php, sql (`psql`, `mysql`), yaml (`yml`), toml, css (`scss`,
`less`), html (`xml`, `svg`, `vue`), lua, dockerfile; diff (`patch`) and markdown (`md`) are coloured by line. Block comments
and Python triple quotes carry across lines; HTML comments and TOML multi-line strings do not (single-line only).
No claim of equal coverage with Prismantis is made: its language list was not available to compare.

### Copy affordances

Only code keeps a header row (`╭─ ts ──── copy`, full width: it reads as a panel). Lists and quotes draw no header, no
rail and no button: they are plain Markdown (a quote keeps its own `│` bar). Tables and diagrams get no header line
either; their hint is drawn on their own art:

```
┌───────┬─────┬─────── copy ┐        a boxed table: on the top border, right-aligned to the table
yes ┌────────┐    ╭───────╮ art  copy   a diagram: on its first row, right of the art, only over blank cells
```

A hint that does not fit is not drawn (a table narrower than 12 cells, a last column under 6 cells, a first diagram row
with no blank cells there); `rules`, `minimal` and stacked tables have no top border. The key still works in all of
these. Hint rows are chrome, so a mouse selection skips them (a boxed table's top border is the one row that is not
copied with a selection).

Every row of a block also carries an invisible, zero-width copy region (`markdown-chrome.ts` `tagCopy`): nothing is
drawn, a click never hits it, and the key finds the block under the middle of the screen. Visible buttons are hit regions
(`line-meta.ts` `markCopy`, carried through the message gutter by `carryMeta` and into `<details>` bodies), mapped to the
selection map (`ui/selection.ts` `BodyLine.copy`) and clicked in `ui/app/mouse-selection.ts`. The key is `ctrl+x Y`
(`block.copy`), which copies the nearest block to the middle of the screen, like `ctrl+x f` does for `<details>`; with
no block in view it says so. Both go through `copyText`, the OSC 52 path that `/copy` uses. A mouse selection copies
lists and quotes as it always did.

| Block | Visible hint | `copy` / key puts | `art` puts |
|---|---|---|---|
| fenced code | header: language (`text` when none) + `copy` | the code as typed, tabs kept; while streaming, what has arrived | |
| table | `copy` on the top border (`box`, `grid`) | the Markdown source | |
| list | none | the list's source | |
| quote | none | the text without `>` | |
| mermaid | `art  copy` beside the first row | the source | the diagram as drawn |
| diagram that cannot be drawn | code header with `copy` | the source | |

`markdownCopyHints` picks what is visible: `code` (code headers only), `all` (plus the table and diagram hints) or `off`
(a header with the language and no button); `auto` is `code` in balanced and `all` in full. The minimal view is plain
and has no hints at all. Hints that do not fit are dropped from the right.

### Right-to-left text

`markdown-bidi.ts` implements the part of UAX #9 that matters for Hebrew and Arabic paragraphs: strong types (R, AL, L),
European and Arabic numbers with their separators (`1,234.5` stays one number), sign handling next to numbers, neutral
resolution (N1/N2), embedding levels 0 and 1 with numbers at level 2, line-level run reversal (L2) and bracket
mirroring (L4). The base direction is the first strong letter of the paragraph. A right-to-left paragraph, heading,
list item (marker on the right) or quote (bar on the right) is reordered per drawn row after wrapping and right-aligned,
with the blanks marked as chrome. A left-to-right paragraph with an embedded Hebrew run is reordered but not aligned.
Rows without right-to-left letters take a regex test and nothing else.

Limits, stated plainly: no explicit embeddings or isolates (LRE, RLI, …), no bracket pairing (rule N0), no Arabic
contextual shaping or ligatures (a terminal font shows isolated letter forms unless the terminal shapes them), no
combining-mark reordering beyond keeping a mark with its base, and a mouse selection copies visual order. A terminal that
does its own bidi (mlterm, some others) would reorder twice: turn `markdownRtl` off there. Tables and code stay
left-to-right.

### Streaming and width safety

- The settled-prefix memo is keyed by width, colour and a style key, so changing a setting never serves stale rows
  (`transcript.setAppearance` also clears the transcript cache).
- A block header, heading rule or callout label is derived from its own source, so no finished block changes while the
  next one streams (`markdown-full-streaming.test.ts` checks this character by character).
- No row exceeds the width for any table style, heading style or width from 20 to 200, with CJK and emoji
  (`markdown-full.test.ts`). Existing width bugs found on the way were fixed: a folded `<details>` count and a
  "diagram too wide" note could pass the width.

### Performance

Median of seven runs on one machine (Bun 1.3.13, Apple silicon), `renderMarkdownWhole`, width 100, 2,000-line document
built from the torture file without diagrams: classic 8.1 ms, enhanced 8.8 ms, enhanced with banner headings and grid
tables 8.7 ms. A streamed frame of a 120-block answer with the memo costs under 10 ms in the test budget. The shell
highlighter stays under 0.05 ms per line. Tests: `markdown.test.ts` (existing 50 ms budget, unchanged),
`markdown-full-streaming.test.ts` (same budget for the enhanced engine).

## Left out, and why

- **A horizontal-clip mode for code** (`codeWrap`): no setting exists today and wrapping behind `↪` never hides code;
  adding a hidden-text mode would need horizontal scrolling in the transcript.
- **Full bidi** (isolates, embeddings, N0, shaping): not needed for model output, and shaping is the terminal's job.
- **A visible copy hint on lists and quotes**: a header or rail on every list of an answer is heavy; the key and the
  mouse selection cover them.
- **A hint on a table that has no top border or no room**: `rules`, `minimal`, stacked and narrow tables use the key.
- **A separate `art` hint on tables**: the border carries `copy` (the Markdown source) only; a mouse selection copies the
  drawn rows.
- **Per-theme Markdown palettes bundled** (15 palettes like Prismantis): MendCode already ships 40 themes; the new slots
  derive from each, so every theme gets a coherent Markdown look without 40 hand-tuned entries.
- **A footer row closing each code block**: it would add a row that only appears once the fence closes.
