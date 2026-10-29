import type { ColorName, Line, Span } from "../ui/theme"
import { subagentColor } from "./agent-color"
import type { ToolCardInput, ToolLevel } from "./tool-card"
import { clip } from "./deck"
import { markFold, markGutter } from "./line-meta"
import { wrapSpans } from "./markdown"
import { formatDuration, formatElapsed } from "./time"
import { BRIEF_ROWS, EXCERPT_ROWS, globGroups, GRID_ROWS, GREP_FILES, GREP_LINES_PER_FILE, grepGroups, listGrid, noteRow, PAGE_LINES, readExcerpt, readPage, SHAPE_ROWS, shapeLines, webLines, type BodyContext } from "./tool-bodies"
import { directoryEntries, formatBytes, jsonShape, parseGrep, parseListing, parseRead, resultShape, shellSummary, webInfo } from "./tool-data"
import { bodyWidth, factSpans, FOLD_CARD, FOLD_PAGE, glyphOf, headerRow, INDENT, marksOf, railPrefix, toneOf, type Marks, type StatusTone } from "./tool-frame"
import { lineWidth, textWidth, truncateEnd } from "./wrap"

/**
 * One function per kind of call for `balanced` (a header, at most a few body rows) and `full` (the same header over a richer
 * body); an opened card pages the whole body. Each returns finished rows, or undefined when the text is not what the kind
 * expects (the generic card then shows it).
 */

export const SPINNER_ASCII = ["-", "\\", "|", "/"] as const
const SPINNER_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export type CardContext = {
  input: ToolCardInput
  name: string
  detail: string
  level: ToolLevel
  ascii: boolean
  marks: Marks
  status: StatusTone
  running: boolean
  failed: boolean
  cancelled: boolean
  /** The full view's density for this call: one row (`line`), a short preview capped by kind (`brief`), or neither (the level decides). */
  line: boolean
  brief: boolean
  body: BodyContext
}

export function cardContext({ input, name, detail, level, ascii }: { input: ToolCardInput; name: string; detail: string; level: ToolLevel; ascii: boolean }): CardContext {
  const running = input.status === "running"
  const failed = input.status === "error" || input.status === "interrupted"
  const cancelled = input.status === "cancelled"
  const status: StatusTone = running ? (input.awaiting ? "awaiting" : "running") : failed ? "failed" : cancelled ? "cancelled" : input.awaiting ? "awaiting" : "ok"
  const marks = marksOf(ascii)
  const rule = toneOf(status).rule
  // A call kept to one row draws like the summary level wherever the summary has no row of its own to add: only the header.
  const line = input.density === "line" && level !== "full" && !running && !failed
  const brief = input.density === "brief" && level !== "full"
  return { input, name, detail, level: line ? "summary" : level, ascii, marks, status, running, failed, cancelled, line, brief, body: { prefix: railPrefix({ rule, marks }), width: bodyWidth(input.width), marks } }
}

/** The marker at the start of a card: the kind's glyph in the status colour; a failed call has the failure mark instead, so the state reads without colour. */
export function glyphSpan(c: CardContext): Span {
  const tone = toneOf(c.status)
  if (c.running) {
    const frames = c.ascii ? SPINNER_ASCII : SPINNER_UNICODE
    return { text: frames[c.input.frame % frames.length]!, fg: tone.glyph }
  }
  if (c.failed) return { text: c.marks.failed, fg: tone.glyph }
  return { text: glyphOf({ name: c.name, ascii: c.ascii }), fg: tone.glyph, ...(tone.dim ? { dim: true } : {}) }
}

/** The card's duration for the header's right edge: only from a second on, a running one counting. */
function durationOf(c: CardContext): string | undefined {
  const ms = c.input.elapsedMs
  if (ms === undefined || ms < 1000) return undefined
  return c.running ? formatElapsed(ms) : formatDuration(ms)
}

export type HeaderParts = { label?: string; target?: string; targetTone?: ColorName; facts?: Array<string | Span | Span[]>; middle?: boolean; /** No duration at the right edge (a second file of one card). */ quiet?: boolean }

const isErrorFact = (fact: string | Span | Span[]) => (typeof fact === "string" ? false : Array.isArray(fact) ? fact.some((span) => span.fg === "error") : fact.fg === "error")

/**
 * A failed call says so in words, in the error role, on its header: the badge its kind already has (`exit 2`, `HTTP 404`, a task's
 * `failed`) or, when it has none, `failed` / `interrupted`. The rest of the row keeps its normal colours.
 */
function statusFacts(c: CardContext, facts: ReadonlyArray<string | Span | Span[]> = []): Array<string | Span | Span[]> {
  if (!c.failed || facts.some(isErrorFact)) return [...facts]
  return [...facts, spanOf(c.input.status === "interrupted" ? "interrupted" : "failed", "error")]
}

/** `writing 84 lines · 6.2 KB` while the model still writes the call's input (a whole file, a long script): the tool has not started. */
function writingFact(c: CardContext): Span | undefined {
  const chars = c.input.meta?.writingChars
  const lines = c.input.meta?.writingLines
  if (!c.running || typeof chars !== "number") return undefined
  return { text: `writing ${typeof lines === "number" && lines > 1 ? `${lines} lines · ` : ""}${formatBytes(chars)}`, fg: "muted" }
}

export function header(c: CardContext, parts: HeaderParts, fold = true): Line {
  const time = parts.quiet ? undefined : durationOf(c)
  // A running call's time follows its facts: the bottom-right corner of the transcript belongs to the pet, and the live panel keeps the clock.
  const right = c.running ? undefined : time
  const writing = writingFact(c)
  const facts = [...statusFacts(c, parts.facts), ...(writing ? [writing] : []), ...(c.running && time ? [time] : [])]
  const row = clip(headerRow({
    glyph: glyphSpan(c),
    ...(parts.label ? { label: parts.label } : {}),
    ...(parts.target ? { target: parts.target } : {}),
    targetTone: parts.targetTone ?? (c.line ? "muted" : "text"),
    ...(c.line ? { plain: true } : {}),
    ...(facts.length ? { facts: factSpans(facts) } : {}),
    ...(right ? { right } : {}),
    width: c.input.width,
    ...(parts.middle ? { middle: true } : {}),
    ...(c.cancelled ? { strike: true } : {}),
  }), c.input.width)
  if (fold) markFold(row, FOLD_CARD)
  return row
}

/** Rows a wrapped header may take; a longer command ends its last row in `…`. */
export const HEADER_MAX_ROWS = 8

/**
 * A header whose text can be longer than a row: a shell command, or the whole title an engine gives a call that has no `name: detail`
 * form. The views that show a card's body (`preview`, `full`) wrap it onto continuation rows under the card's rail, aligned under
 * the first word, with the facts and the duration after its last word; the denser `summary` keeps the one row that ends in `…`.
 */
export function headerRows(c: CardContext, parts: HeaderParts & { wrap?: boolean }, fold = true): Line[] {
  const { wrap, ...single } = parts
  const one = header(c, single, fold)
  if (!wrap || c.level === "summary") return [one]
  const { width } = c.input
  const edge = width - 1
  const glyph = glyphSpan(c)
  const start = INDENT.length + textWidth(glyph.text) + 1
  const label = parts.label ?? ""
  const target = parts.target ?? ""
  if (start + textWidth(label) + (label && target ? 1 : 0) + textWidth(target) <= edge) return [one]
  const strike = c.cancelled ? { strike: true as const } : {}
  const text: Span[] = [
    ...(label ? [{ text: label, fg: "muted" as const, ...strike }] : []),
    ...(label && target ? [{ text: " " }] : []),
    ...(target ? [{ text: target, fg: parts.targetTone ?? "text", bold: true, ...strike } as Span] : []),
  ]
  const lead: Span[] = [{ text: INDENT }, glyph, { text: " " }]
  const rows = wrapSpans(text, edge, lead, c.body.prefix)
  const prefixWidth = textWidth(c.body.prefix.map((span) => span.text).join(""))
  for (const row of rows.slice(1)) markGutter(row, prefixWidth)
  const time = durationOf(c)
  const tail = factSpans([...statusFacts(c, parts.facts), ...(time ? [time] : [])])
  if (rows.length > HEADER_MAX_ROWS) {
    const last = clip(rows[HEADER_MAX_ROWS - 1]!, edge - 1)
    rows.splice(HEADER_MAX_ROWS - 1, rows.length, [...last, { text: "…", fg: "muted" }])
  } else if (tail.length) {
    const last = rows[rows.length - 1]!
    if (lineWidth(last) + 2 + lineWidth(tail) <= edge) rows[rows.length - 1] = [...last, { text: "  " }, ...tail]
    else rows.push(clip([...c.body.prefix, ...tail], edge))
  }
  if (fold) markFold(rows[0]!, FOLD_CARD)
  return rows
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g
export const linesOf = (text: string) => text.replace(ANSI, "").replace(/\s+$/, "").split("\n").filter((line) => line.length > 0)

/** The rows of an opened card's whole body: one page of TOOL_PAGE lines, with the footer that turns the page or closes the card. */
export function pagedLines({ lines, c, tone, dim = true }: { lines: string[]; c: CardContext; tone: ColorName; dim?: boolean }): Line[] {
  const pages = Math.max(1, Math.ceil(lines.length / PAGE_LINES))
  const at = Math.min(Math.max(0, c.input.page ?? 0), pages - 1)
  const from = at * PAGE_LINES
  const to = Math.min(lines.length, from + PAGE_LINES)
  const rows = lines.slice(from, to).flatMap((text) => wrapSpans([{ text, fg: tone, ...(dim ? { dim: true } : {}) }], c.body.width + c.body.prefix.reduce((sum, span) => sum + textWidth(span.text), 0), c.body.prefix, c.body.prefix))
  if (pages > 1) rows.push(noteRow(c.body, `lines ${from + 1}-${to} of ${lines.length} ${c.marks.dot} ${at < pages - 1 ? "click or ctrl+x f for the next page" : "click or ctrl+o to close"}`, at < pages - 1 ? FOLD_PAGE : FOLD_CARD))
  return rows
}

/** A call still running: its header and the last rows it has printed, dim. */
function live(c: CardContext, parts: HeaderParts): Line[] {
  const lines = linesOf(c.input.text).slice(-c.input.tailLines)
  return [...headerRows(c, { ...parts, wrap: !parts.target }, false), ...lines.map((text): Line => [...c.body.prefix, { text: truncateEnd(text, c.body.width), fg: "muted", dim: true }])]
}

/** Lines of an error a failed card prints before `… +N lines`. */
export const FAILURE_LINES = 3

/**
 * The error text of a failed card: a few lines under the rule, the whole body (paged) when opened. The status is the marker, the
 * badge and the rule; the text is not painted with it. A short error (one or two lines) is the card's normal text so it reads at
 * once; a longer one is the muted output role, like any other output.
 */
export function failure({ c, head, lines }: { c: CardContext; head: Line | Line[]; lines: string[] }): Line[] {
  const top = Array.isArray(head[0]) ? (head as Line[]) : [head as Line]
  const tone: ColorName = lines.length <= 2 ? "body" : "muted"
  if (c.level === "full") return [...top, ...pagedLines({ lines, c, tone, dim: false })]
  const room = c.body.width + c.body.prefix.reduce((sum, span) => sum + textWidth(span.text), 0)
  // The cap counts screen rows, not lines: one huge line (an HTML error page, minified CSS) would otherwise wrap down the screen.
  const shown: Line[] = []
  let whole = 0
  for (const text of lines.slice(0, FAILURE_LINES)) {
    const rows = wrapSpans([{ text, fg: tone }], room, c.body.prefix, c.body.prefix)
    if (shown.length + rows.length <= FAILURE_LINES) {
      shown.push(...rows)
      whole++
      continue
    }
    // The line that does not fit whole fills the rows left, its last one cut with an ellipsis.
    const left = FAILURE_LINES - shown.length
    if (left > 0) {
      shown.push(...rows.slice(0, left - 1))
      const last = rows[left - 1]!.slice(c.body.prefix.length).map((span) => span.text).join("")
      shown.push([...c.body.prefix, { text: `${[...last].slice(0, -1).join("")}${c.marks.ellipsis}`, fg: tone }])
    }
    break
  }
  const hidden = lines.length - whole
  return [...top, ...shown, ...(hidden > 0 ? [noteRow(c.body, `${c.marks.ellipsis} +${hidden.toLocaleString("en-US")} line${hidden === 1 ? "" : "s"}`)] : [])]
}

const spanOf = (text: string, fg: ColorName = "muted"): Span => ({ text, fg })

/** Spans joined by a muted dot: one fact made of several (`reviewer · gpt-5.5 · 7 calls`). */
const dotted = (parts: Span[], marks: Marks): Span[] => parts.flatMap((part, at): Span[] => (at ? [{ text: ` ${marks.dot} `, fg: "muted" }, part] : [part]))

/** `Read README.md  126 lines`, `Read src/a.ts  L40–88`; `full` adds the first rows of the file. */
export function readCard(c: CardContext): Line[] | undefined {
  const { input } = c
  const lines = linesOf(input.text)
  if (c.failed) return failure({ c, head: header(c, { label: "Read", target: c.detail }, false), lines })
  if (c.running) return live(c, { label: "Read", target: c.detail })
  const parsed = parseRead(input.text)
  if (parsed.kind === "image" || parsed.kind === "pdf") return [header(c, { label: "Read", target: c.detail, facts: [parsed.kind] }, false)]
  if (parsed.kind === "directory") {
    const listing = parseListing(directoryEntries(input.text).join("\n"))
    const head = header(c, { label: "Read", target: c.detail, facts: [`${plural(listing.entries.length + listing.hidden, "entry", "entries")}${listing.dirs ? ` (${plural(listing.dirs, "dir")})` : ""}`] })
    return c.level === "summary" ? [head] : [head, ...(c.level === "full" ? pagedLines({ lines: listing.entries, c, tone: "text" }) : listGrid({ listing, ctx: c.body, maxRows: c.brief ? BRIEF_ROWS.grid : GRID_ROWS.preview }))]
  }
  if (!parsed.rows.length) return [header(c, { label: "Read", target: c.detail, facts: ["empty"] }, false)]
  const partial = parsed.first > 1 || parsed.more > 0 || parsed.capped
  const total = input.counts?.lines ?? parsed.rows.length
  const range = `L${parsed.first}${c.marks.dash}${parsed.last}${parsed.more > 0 ? ` of ${(parsed.last + parsed.more).toLocaleString("en-US")}` : ""}`
  const head = header(c, { label: "Read", target: c.detail, facts: [partial ? range : `${total.toLocaleString("en-US")} ${total === 1 ? "line" : "lines"}`] })
  if (c.level === "summary") return [head]
  if (c.level === "full") return [head, ...readPage({ parsed, path: c.detail, ctx: c.body, page: input.page ?? 0 })]
  return [head, ...readExcerpt({ parsed, path: c.detail, ctx: c.body, rows: c.brief ? BRIEF_ROWS.read : EXCERPT_ROWS })]
}

/** `List .  25 entries (18 dirs)` over `ls` columns. */
export function listCard(c: CardContext): Line[] | undefined {
  const { input } = c
  const target = c.detail || "."
  if (c.failed) return failure({ c, head: header(c, { label: "List", target }, false), lines: linesOf(input.text) })
  if (c.running) return live(c, { label: "List", target })
  const listing = parseListing(input.text)
  if (!listing.entries.length) return [header(c, { label: "List", target, facts: ["empty"] }, false)]
  const total = listing.entries.length + listing.hidden
  const head = header(c, { label: "List", target, facts: [`${plural(input.counts?.entries && !listing.hidden ? input.counts.entries : total, "entry", "entries")}${listing.dirs ? ` (${plural(listing.dirs, "dir")})` : ""}`] })
  if (c.line) return [head]
  if (c.level === "summary") return [head, ...listGrid({ listing, ctx: c.body, maxRows: GRID_ROWS.summary })]
  if (c.level === "preview") return [head, ...listGrid({ listing, ctx: c.body, maxRows: c.brief ? BRIEF_ROWS.grid : GRID_ROWS.preview })]
  return [head, ...pagedLines({ lines: listing.entries, c, tone: "text" })]
}

/** `Glob *.test.ts  18 files` over columns of paths relative to their shared directory. */
export function globCard(c: CardContext, pattern: string | undefined): Line[] | undefined {
  const { input } = c
  const target = pattern ?? c.detail
  if (c.failed) return failure({ c, head: header(c, { label: "Glob", target }, false), lines: linesOf(input.text) })
  if (c.running) return live(c, { label: "Glob", target })
  if (/^No files found/.test(input.text.trim())) return [header(c, { label: "Glob", target, facts: ["no files"] }, false)]
  const listing = parseListing(input.text)
  const total = listing.entries.length + listing.hidden
  const head = header(c, { label: "Glob", target, facts: [plural(input.counts?.matches && !listing.hidden ? input.counts.matches : total, "file")] })
  if (c.line) return [head]
  if (c.level === "summary") return [head, ...globGroups({ listing, ctx: c.body, maxRows: GRID_ROWS.summary })]
  if (c.level === "preview") return [head, ...globGroups({ listing, ctx: c.body, maxRows: c.brief ? BRIEF_ROWS.grid : GRID_ROWS.preview })]
  return [head, ...pagedLines({ lines: listing.entries, c, tone: "text" })]
}

/** `Grep "foo"  12 matches in 4 files` over the files with their first matching lines. */
export function grepCard(c: CardContext, pattern: string | undefined): Line[] | undefined {
  const { input } = c
  const target = pattern ? `"${pattern}"` : c.detail
  if (c.failed) return failure({ c, head: header(c, { label: "Grep", target }, false), lines: linesOf(input.text) })
  if (c.running) return live(c, { label: "Grep", target })
  if (/^No matches found/.test(input.text.trim())) return [header(c, { label: "Grep", target, facts: ["no matches"] }, false)]
  const grouped = parseGrep(input.text)
  if (!grouped.matches) return undefined
  const more = grouped.capped ? "+" : ""
  const head = header(c, { label: "Grep", target, facts: [`${grouped.matches.toLocaleString("en-US")}${more} ${grouped.matches === 1 && !more ? "match" : "matches"} in ${plural(grouped.files.length, "file")}`] })
  if (c.line) return [head]
  if (c.level === "full") return [head, ...pagedLines({ lines: linesOf(input.text), c, tone: "muted" })]
  const at = c.level === "preview" ? "preview" : "summary"
  return [head, ...grepGroups({ grouped, pattern, ctx: c.body, files: GREP_FILES[at], perFile: GREP_LINES_PER_FILE[at], ...(c.brief ? { matches: BRIEF_ROWS.grep } : {}) })]
}

/** Rows of the tail of a shell's output that fit `cap`, wrapped; what is cut above them becomes `… +N lines`. */
function tail({ c, lines, cap, tone }: { c: CardContext; lines: string[]; cap: number; tone: ColorName }): Line[] {
  const room = c.body.width
  const rows: Line[] = []
  let taken = 0
  while (taken < lines.length && rows.length < cap) {
    const next = wrapSpans([{ text: lines[lines.length - 1 - taken]!, fg: tone }], room, c.body.prefix, c.body.prefix)
    if (rows.length > 0 && rows.length + next.length > cap) break
    rows.unshift(...next)
    taken++
  }
  const hidden = lines.length - taken
  const kept = rows.slice(-cap)
  return hidden > 0 ? [noteRow(c.body, `${c.marks.ellipsis} +${hidden.toLocaleString("en-US")} ${c.running ? "earlier " : ""}line${hidden === 1 ? "" : "s"}`), ...kept] : kept
}

/** `$ bun test  241 pass · 0 fail  12.4s` over the tail of its output. */
export function shellCard(c: CardContext, limits: { summary: number; preview: number; failed: number }): Line[] {
  const { input } = c
  const output = linesOf(input.text)
  const exit = input.exitCode
  const summary = c.running ? undefined : shellSummary({ command: c.detail, text: input.text, exitCode: exit })
  // A call kept to a row or to a short preview says the shape of what it printed instead of printing it: `json · 1,155 lines`.
  const shape = (c.line || c.brief) && !c.running && !c.failed && !summary && output.length ? jsonShape(output) : undefined
  // The one-row form has no body to show how much came out, so it says it.
  const count = c.line && !summary && !shape && output.length ? plural(output.length, "line") : undefined
  const facts: Array<string | Span> = [
    ...(summary ? [spanOf(summary)] : []),
    ...(shape ?? count ? [spanOf((shape ?? count)!)] : []),
    ...(exit ? [spanOf(`exit ${exit}`, "error")] : []),
    ...(!c.running && !output.length && !c.failed ? [spanOf("no output")] : []),
  ]
  // The command wraps under its rail where the card shows a body (the `full` view, an opened card) and ends in `…` in the one-row summary.
  // It keeps the command colour whatever the exit code was: the failure is the marker, the badge and the rule.
  const head = headerRows(c, { target: c.detail || "shell", targetTone: c.input.awaiting ? "warning" : c.line ? "muted" : "primary", facts, middle: true, wrap: true }, !c.running && output.length > 0)
  if (c.running) return [...head, ...(output.length ? tail({ c, lines: output, cap: input.tailLines, tone: "muted" }) : [noteRow(c.body, "No output yet")])]
  if (!output.length || c.line) return head
  const passing = summary !== undefined && !c.failed
  if (c.level === "full") return [...head, ...pagedLines({ lines: output, c, tone: "muted", dim: !c.failed })]
  // A passing run's summary in the header says everything its output would; the rows come when the card is opened.
  if (shape || passing) return head
  const cap = c.failed ? (c.brief ? BRIEF_ROWS.shellFailed : limits.failed) : c.brief ? BRIEF_ROWS.shell : c.level === "preview" ? limits.preview : limits.summary
  return cap > 0 ? [...head, ...tail({ c, lines: output, cap, tone: "muted" })] : head
}

/** `Fetch  Writing tests  bun.sh · 48 KB`; `full` adds the first lines of the text. */
export function webCard(c: CardContext): Line[] | undefined {
  const { input } = c
  const info = webInfo({ detail: c.detail, text: input.text, meta: input.meta })
  if (c.failed) return failure({ c, head: header(c, { label: "Fetch", target: `${info.host}${info.path}` || c.detail, facts: info.status ? [spanOf(`HTTP ${info.status}`, "error")] : [] }, false), lines: linesOf(input.text) })
  if (c.running) return live(c, { label: "Fetch", target: c.detail })
  const where = `${info.host}${info.path && !info.title ? info.path : ""}`
  const head = header(c, { label: "Fetch", target: info.title || where, facts: [dotted([...(info.title ? [spanOf(info.host)] : []), spanOf(info.size)], c.marks)] })
  if (c.level === "summary") return [head]
  if (c.level === "full") return [head, ...pagedLines({ lines: linesOf(input.text), c, tone: "muted" })]
  return [head, ...webLines({ info, ctx: c.body, ...(c.brief ? { rows: BRIEF_ROWS.web } : {}) })]
}

/** `Web search "query"  8 results`; `full` adds the result titles. */
export function searchCard(c: CardContext): Line[] | undefined {
  const { input } = c
  const lines = linesOf(input.text)
  // The subscription's hosted search has no query argument: its text is the queries it ran.
  const hosted = !c.detail
  const target = hosted ? (lines[0] ?? "") : `"${c.detail}"`
  if (c.failed) return failure({ c, head: header(c, { label: "Web search", target }, false), lines })
  if (c.running) return live(c, { label: "Web search", target })
  const count = typeof input.meta?.results === "number" ? input.meta.results : Number(/^(\d+) results?/.exec(lines[0] ?? "")?.[1] ?? 0)
  const titles = lines.filter((line) => /^\d+\. /.test(line))
  const head = header(c, { label: "Web search", target, ...(hosted ? {} : { facts: [count ? plural(count, "result") : "no results"] }) })
  if (c.level === "summary" || !titles.length) return [head]
  if (c.level === "full") return [head, ...pagedLines({ lines, c, tone: "muted" })]
  return [head, ...shapeLines({ lines: titles.map((title) => title.trim()), ctx: c.body, rows: c.brief ? BRIEF_ROWS.titles : 4 })]
}

/** One row: `Task  Review graph tool cards  reviewer · gpt-5.5 · 7 calls  1m 5s`; running, the last thing it said follows. Opens to its result. */
export function taskCard(c: CardContext): Line[] {
  const { input } = c
  const output = linesOf(input.text)
  const state = c.running ? "running" : c.failed ? "failed" : c.cancelled ? "cancelled" : undefined
  // Each fact keeps a colour of its own: the agent, what it runs on, how much it did and its state are told apart without reading.
  const facts: Span[][] = [
    ...(input.agent ? [[spanOf(input.agent, "accent")]] : []),
    ...(input.run?.length ? [input.run] : input.model ? [[spanOf(input.model, "body")]] : []),
    ...(input.toolCalls !== undefined ? [[spanOf(plural(input.toolCalls, "call"))]] : []),
    ...(state ? [[spanOf(state, c.failed ? "error" : c.running ? "success" : "muted")]] : []),
  ]
  const who = facts.flatMap((fact, at): Span[] => (at ? [{ text: ` ${c.marks.dot} `, fg: "muted" }, ...fact] : fact))
  const last = c.running && output.length ? output.at(-1)!.trim() : ""
  const head = header(c, { label: "Task", target: input.title ? c.detail : "", ...(c.detail && !c.line ? { targetTone: subagentColor(c.detail) } : {}), facts: [...(who.length ? [who] : []), ...(last ? [spanOf(`${c.marks.ellipsis} ${last}`)] : [])] }, output.length > 0)
  if (c.level === "full" && output.length && !c.running) return [head, ...pagedLines({ lines: output, c, tone: c.failed ? "error" : "muted", dim: !c.failed })]
  // A failed sub-agent says why under its row (an unknown agent or model, a limit), without the receipt's bookkeeping lines.
  if (c.failed && c.level !== "summary") {
    const reason = output.filter((line) => !/^(task_id|state|context): /.test(line.trim()) && line.trim())
    if (reason.length) return failure({ c, head, lines: reason })
  }
  return [head]
}

/**
 * Any other tool: `server · tool  MEN-482  object · 14 keys` (`fact` is what the result's shape is called, a line count for built-ins);
 * `full` adds the first rows of its text.
 */
export function shapeCard(c: CardContext, label: string, fact: string | undefined): Line[] {
  const { input } = c
  const lines = linesOf(input.text)
  // A call with no `name: detail` title (the Claude Code engine's) has its whole title as the label: it wraps like a command where the card shows a body.
  const wrap = !c.detail
  if (c.failed) return failure({ c, head: headerRows(c, { label, target: c.detail, wrap }, false), lines })
  if (c.running) return live(c, { label, target: c.detail })
  const head = headerRows(c, { label, target: c.detail, wrap, ...(fact ? { facts: [fact] } : {}) }, lines.length > 0)
  if (c.level === "summary" || !lines.length) return head
  if (c.level === "full") return [...head, ...pagedLines({ lines, c, tone: "muted" })]
  // A result that is one JSON value is its shape in the header (`object · 4 keys`), not its first rows.
  if (c.brief && /^(object|array) · /.test(fact ?? "")) return head
  return [...head, ...shapeLines({ lines, ctx: c.body, rows: c.brief ? BRIEF_ROWS.shape : SHAPE_ROWS })]
}
