import type { ColorName, Line, Span } from "../ui/theme"
import { clip } from "./deck"
import { markFold } from "./line-meta"
import { type Grouped, type Listing, type ReadRows, type WebInfo } from "./tool-data"
import { gridRows, type GridCell, type Marks } from "./tool-frame"
import { highlight, isHighlighted, type HighlightState } from "./syntax"
import { shortenMiddle, textWidth, truncateEnd } from "./wrap"

/**
 * The bodies of `balanced` and `full` cards, each drawn in the form that suits its content: a file as a gutter and highlighted
 * rows, a listing as `ls` columns, matches grouped by file. Every function takes the rows' prefix (indent and rule), returns
 * finished rows, and never builds more rows than it shows. Fold marks: 0 opens the card, 1 turns its page.
 */

export type BodyContext = { prefix: Span[]; width: number; marks: Marks }

/** Rows of a body in each density: the excerpt of a read, the rows of a listing grid, the files of a search. */
export const EXCERPT_ROWS = 6
export const GRID_ROWS = { summary: 3, preview: 6 } as const
export const GREP_FILES = { summary: 3, preview: 6 } as const
export const GREP_LINES_PER_FILE = { summary: 1, preview: 2 } as const
export const SHAPE_ROWS = 6
export const WEB_LINES = 4
/**
 * Rows of a call's preview in the full view's `calm` and `standard` densities, by kind: the first lines of a read, the matching
 * lines of a search, the tail of a shell. The rest is the card's `… N more`, which opens it.
 */
export const BRIEF_ROWS = { read: 3, grid: 2, grep: 3, shell: 3, shellFailed: 4, web: 2, titles: 3, shape: 3, diff: 8, notes: 2 } as const
/** Source lines per page of an opened card. */
export const PAGE_LINES = 40

const FOLD_CARD = 0
const FOLD_PAGE = 1

const row = (ctx: BodyContext, spans: Span[]): Line => [...ctx.prefix, ...spans]

/** A source row: its line number in a muted gutter (right-aligned to `digits`), then the content; a blank line keeps no trailing gutter space. */
const numbered = (ctx: BodyContext, { n, digits, content }: { n: number; digits: number; content: Span[] }): Line => (digits ? row(ctx, [{ text: `${String(n).padStart(digits)}${content.length ? "  " : ""}`, fg: "muted", dim: true }, ...content]) : row(ctx, content))

/** Cells the gutter takes: the widest number and two spaces; none for rows without numbers. */
const gutterCells = (digits: number) => (digits ? digits + 2 : 0)

/** A muted row that opens (or pages) its card when clicked. */
export function noteRow(ctx: BodyContext, text: string, fold = FOLD_CARD): Line {
  const line = row(ctx, [{ text: truncateEnd(text, ctx.width), fg: "muted", dim: true }])
  markFold(line, fold)
  return line
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

const EXTENSIONS: Readonly<Record<string, string>> = { ts: "ts", tsx: "ts", mts: "ts", cts: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", json: "json", jsonc: "json", md: "md", mdx: "md", py: "py", sh: "bash", bash: "bash", zsh: "bash", go: "go", rs: "rust", css: "css", html: "html", yml: "yaml", yaml: "yaml", toml: "toml", diff: "diff", patch: "diff" }

/** The highlighter's language for a file name, or undefined (drawn plain) for an extension it does not know. */
export function languageOfPath(path: string): string | undefined {
  const name = path.split("/").at(-1) ?? path
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  // The table names the common ones; any other extension the highlighter knows by that name (swift, kt, java, rb, c, cpp, php, sql, lua…) is coloured too.
  return EXTENSIONS[extension] ?? (extension === "markdown" ? "md" : extension && isHighlighted(extension) ? extension : /^dockerfile$/i.test(name) ? "dockerfile" : undefined)
}

/** One source line as spans, tabs as two spaces, cut to `room` cells with an ellipsis; highlighted when the language is known. */
function codeSpans({ text, lang, state, room, marks }: { text: string; lang: string | undefined; state: HighlightState; room: number; marks: Marks }): Span[] {
  const source = text.replace(/\t/g, "  ").replace(/\s+$/, "")
  const spans: Span[] = lang ? highlight(source, lang, state) : source ? [{ text: source, fg: "code" }] : []
  if (textWidth(source) <= room) return spans
  const cut = clip(spans, Math.max(1, room - textWidth(marks.ellipsis)))
  return [...cut, { text: marks.ellipsis, fg: "muted" }]
}

const numberWidth = (rows: ReadonlyArray<{ n: number }>) => Math.max(1, ...rows.map((entry) => String(entry.n).length))

/**
 * The first rows of what a read returned, with a muted gutter of the file's own line numbers (right-aligned to the widest shown) and
 * highlighted text, then `… N more lines`. Never the tail: a reader recognises a file by how it begins.
 */
export function readExcerpt({ parsed, path, ctx, rows }: { parsed: ReadRows; path: string; ctx: BodyContext; rows: number }): Line[] {
  if (!parsed.rows.length) return []
  const shown = parsed.rows.slice(0, rows)
  const digits = parsed.numbered ? numberWidth(shown) : 0
  const room = ctx.width - gutterCells(digits)
  const lang = languageOfPath(path)
  const state: HighlightState = {}
  const lines = shown.map((entry): Line => numbered(ctx, { n: entry.n, digits, content: codeSpans({ text: entry.text, lang, state, room, marks: ctx.marks }) }))
  const more = parsed.rows.length - shown.length + parsed.more
  return more > 0 ? [...lines, noteRow(ctx, `${ctx.marks.ellipsis} ${plural(more, "more line")}`)] : lines
}

/** One page of an opened read: the same gutter and highlighting, TOOL_PAGE source lines at a time, and the footer that turns the page. */
export function readPage({ parsed, path, ctx, page }: { parsed: ReadRows; path: string; ctx: BodyContext; page: number }): Line[] {
  const pages = Math.max(1, Math.ceil(parsed.rows.length / PAGE_LINES))
  const at = Math.min(Math.max(0, page), pages - 1)
  const shown = parsed.rows.slice(at * PAGE_LINES, (at + 1) * PAGE_LINES)
  const digits = parsed.numbered ? numberWidth(shown) : 0
  const lang = languageOfPath(path)
  const state: HighlightState = {}
  const lines = shown.map((entry): Line => numbered(ctx, { n: entry.n, digits, content: codeSpans({ text: entry.text, lang, state, room: ctx.width - gutterCells(digits), marks: ctx.marks }) }))
  if (pages > 1) lines.push(noteRow(ctx, `lines ${at * PAGE_LINES + 1}-${at * PAGE_LINES + shown.length} of ${parsed.rows.length} ${ctx.marks.dot} ${at < pages - 1 ? "click or ctrl+x f for the next page" : "click or ctrl+o to close"}`, at < pages - 1 ? FOLD_PAGE : FOLD_CARD))
  return lines
}

const CELL_MAX = 30

function nameCell({ name, marks, maxWidth = CELL_MAX }: { name: string; marks: Marks; maxWidth?: number }): GridCell {
  const dir = name.endsWith("/")
  const dot = name.startsWith(".")
  const shown = truncateEnd(name, maxWidth)
  const fg: ColorName = dir ? "accent" : dot ? "muted" : "text"
  return { spans: [{ text: shown, fg, ...(dot && !dir ? { dim: true } : {}) }], width: textWidth(shown) }
}

function gridBody({ cells, ctx, maxRows, hidden }: { cells: GridCell[]; ctx: BodyContext; maxRows: number; hidden: number }): Line[] {
  const { rows, shown } = gridRows({ cells, width: ctx.width, maxRows })
  const lines = rows.map((line) => row(ctx, line))
  const more = cells.length - shown + hidden
  return more > 0 ? [...lines, noteRow(ctx, `${ctx.marks.ellipsis} +${more.toLocaleString("en-US")}`)] : lines
}

/** A listing as `ls` columns: directories first (they arrive first) with their slash in the accent colour, dotfiles muted. */
export function listGrid({ listing, ctx, maxRows }: { listing: Listing; ctx: BodyContext; maxRows: number }): Line[] {
  return gridBody({ cells: listing.entries.map((name) => nameCell({ name, marks: ctx.marks })), ctx, maxRows, hidden: listing.hidden })
}

const GROUP_LABEL_MAX = 28

/**
 * Paths grouped by directory: each directory (muted, once) leads the first row of its group, the names in it follow as `ls` columns
 * and hang under it. Directories keep the order their first file appeared in; `… +N` counts the files that did not fit.
 */
export function globGroups({ listing, ctx, maxRows }: { listing: Listing; ctx: BodyContext; maxRows: number }): Line[] {
  const groups = new Map<string, string[]>()
  for (const path of listing.entries) {
    const slash = path.lastIndexOf("/") + 1
    const dir = slash ? path.slice(0, slash) : "./"
    groups.set(dir, [...(groups.get(dir) ?? []), path.slice(slash)])
  }
  const lines: Line[] = []
  let left = listing.entries.length
  for (const [dir, names] of groups) {
    const budget = maxRows - lines.length
    if (budget <= 0) break
    const labelWidth = Math.min(GROUP_LABEL_MAX, textWidth(dir), Math.floor(ctx.width / 2))
    const room = Math.max(1, ctx.width - labelWidth - 2)
    const cells = names.map((name): GridCell => {
      const shown = truncateEnd(name, Math.min(CELL_MAX, room))
      return { spans: [{ text: shown, fg: "text" }], width: textWidth(shown) }
    })
    const { rows, shown } = gridRows({ cells, width: room, maxRows: budget })
    const label = shortenMiddle(dir, labelWidth)
    rows.forEach((spans, at) => lines.push(row(ctx, [{ text: at === 0 ? `${label}${" ".repeat(labelWidth - textWidth(label) + 2)}` : " ".repeat(labelWidth + 2), fg: "muted", dim: true }, ...spans])))
    left -= shown
  }
  const more = left + listing.hidden
  return more > 0 ? [...lines, noteRow(ctx, `${ctx.marks.ellipsis} +${more.toLocaleString("en-US")}`)] : lines
}

/** A pattern as a global regex for highlighting matched text; case-insensitive when only that finds something. Undefined when it is not a valid regex. */
export function matcherOf(pattern: string | undefined, sample: string): RegExp | undefined {
  if (!pattern) return undefined
  try {
    const exact = new RegExp(pattern, "g")
    return exact.test(sample) ? new RegExp(pattern, "g") : new RegExp(pattern, "gi")
  } catch {
    return undefined
  }
}

/** A matching line trimmed of its indent, shifted so the first match is in view, with each match emphasised. */
function matchSpans({ text, matcher, room, marks }: { text: string; matcher: RegExp | undefined; room: number; marks: Marks }): Span[] {
  let source = text.replace(/\t/g, "  ").trim()
  const found = matcher ? (matcher.lastIndex = 0, matcher.exec(source)) : null
  let lead = ""
  if (found && textWidth(source.slice(0, found.index + found[0].length)) > room) {
    const start = Math.max(0, found.index - 10)
    source = source.slice(start)
    lead = marks.ellipsis
  }
  const spans: Span[] = lead ? [{ text: lead, fg: "muted" }] : []
  if (!matcher) return [...spans, { text: source, fg: "body" }]
  let last = 0
  matcher.lastIndex = 0
  for (let hit = matcher.exec(source); hit; hit = matcher.exec(source)) {
    if (!hit[0]) {
      matcher.lastIndex++
      continue
    }
    if (hit.index > last) spans.push({ text: source.slice(last, hit.index), fg: "body" })
    spans.push({ text: hit[0], fg: "warning", bold: true })
    last = hit.index + hit[0].length
  }
  if (last < source.length) spans.push({ text: source.slice(last), fg: "body" })
  return textWidth(source) + textWidth(lead) <= room ? spans : [...clip(spans, Math.max(1, room - textWidth(marks.ellipsis))), { text: marks.ellipsis, fg: "muted" }]
}

/**
 * Matches grouped by file: the file (its directory muted, its name emphasised) with its match count, then up to two matching lines
 * with their line numbers and the match emphasised; `… +N matches in M files` for the rest.
 */
export function grepGroups({ grouped, pattern, ctx, files, perFile, matches }: { grouped: Grouped; pattern: string | undefined; ctx: BodyContext; files: number; perFile: number; /** At most this many matching lines in all, over `files` and `perFile`. */ matches?: number }): Line[] {
  let left = matches ?? Infinity
  const picked = grouped.files.slice(0, files).map((file) => {
    const take = Math.min(perFile, file.matches.length, left)
    left -= take
    return { file, take }
  }).filter(({ take }) => matches === undefined || take > 0)
  const sample = grouped.files[0]?.matches[0]?.text ?? ""
  const matcher = matcherOf(pattern, sample)
  const digits = Math.max(1, ...picked.flatMap(({ file, take }) => file.matches.slice(0, take).map((match) => String(match.line).length)))
  const lines: Line[] = []
  for (const { file, take } of picked) {
    const slash = file.path.lastIndexOf("/") + 1
    const count = `${file.count} ${file.count === 1 ? "match" : "matches"}`
    const room = ctx.width - textWidth(count) - 2
    const name = truncateEnd(file.path.slice(slash), Math.max(1, room))
    const dir = shortenMiddle(file.path.slice(0, slash), Math.max(0, room - textWidth(name)))
    lines.push(row(ctx, [...(dir ? [{ text: dir, fg: "muted" as const, dim: true }] : []), { text: name, fg: "text", bold: true }, { text: `  ${count}`, fg: "muted" }]))
    for (const match of file.matches.slice(0, take)) lines.push(numbered(ctx, { n: match.line, digits, content: matchSpans({ text: match.text, matcher, room: ctx.width - digits - 2, marks: ctx.marks }) }))
  }
  const rest = grouped.matches - picked.reduce((sum, { file, take }) => sum + (matches === undefined ? Math.min(file.count, perFile) : take), 0)
  if (rest > 0) lines.push(noteRow(ctx, `${ctx.marks.ellipsis} +${rest.toLocaleString("en-US")} more ${rest === 1 ? "match" : "matches"}`))
  return lines
}

/** A fetched page in `full`: the first lines of its text under the title, muted. */
export function webLines({ info, ctx, rows = WEB_LINES }: { info: WebInfo; ctx: BodyContext; rows?: number }): Line[] {
  const shown = info.lines.slice(0, rows)
  const lines = shown.map((text): Line => row(ctx, [{ text: truncateEnd(text.replace(/^#{1,6}\s+/, "").trim(), ctx.width), fg: "muted" }]))
  const more = info.lines.length - shown.length
  return more > 0 ? [...lines, noteRow(ctx, `${ctx.marks.ellipsis} ${plural(more, "more line")}`)] : lines
}

/** The first rows of an unknown tool's text, dim, cut to the width; `… +N lines` for the rest. */
export function shapeLines({ lines, ctx, rows }: { lines: string[]; ctx: BodyContext; rows: number }): Line[] {
  const shown = lines.slice(0, rows)
  const out = shown.map((text): Line => row(ctx, [{ text: truncateEnd(text.replace(/\t/g, "  "), ctx.width), fg: "muted", dim: true }]))
  const more = lines.length - shown.length
  return more > 0 ? [...out, noteRow(ctx, `${ctx.marks.ellipsis} +${more.toLocaleString("en-US")} line${more === 1 ? "" : "s"}`)] : out
}
