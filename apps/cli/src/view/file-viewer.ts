import { FILE_VIEW_MAX_SCAN } from "@mendcode/protocol/wire"
import type { Line, Span } from "../ui/theme"
import { clip, fit, spread } from "./deck"
import { cells, lineWidth, textWidth, truncateEnd } from "./wrap"
import type { BuiltinInput } from "./view-builtins"
import type { ViewHit } from "./views"

/**
 * The file viewer's built-in renderer (slot `file.viewer`, docs/file-viewer.md): a header, one row for the slot, the lines of the
 * file with a Git margin and line numbers, and a hint row. Pure: the model carries the rows (text and highlighted spans); this only
 * lays them out. Loaded on first use (`lazy-pages.ts`), so a terminal that never opens a file never pays for it.
 */

/** Rows around the lines: the header and the hint row. */
export const FILE_VIEWER_CHROME = 2
/** Removed lines drawn above the line that follows them; a longer run ends in `… N more removed`. */
export const FILE_VIEWER_REMOVED = 8

type Input = BuiltinInput<"file.viewer">
const MARKS = { added: "success", modified: "warning", deleted: "error" } as const

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The spans' cells `[from, to)`, without splitting a grapheme. */
export function sliceSpans(spans: readonly Span[], from: number, to: number): Line {
  const out: Line = []
  let col = 0
  for (const span of spans) {
    let text = ""
    for (const cell of cells(span.text)) {
      const end = col + cell.width
      if (col >= from && end <= to) text += cell.text
      col = end
    }
    if (text) out.push({ ...span, text })
    if (col >= to) break
  }
  return out
}

/** A line cut into pieces of `width` cells (a hard wrap: code has no word breaks to keep). At least one piece. */
export function wrapCode(spans: readonly Span[], width: number): Line[] {
  const total = lineWidth(spans)
  if (total <= width || width < 1) return [[...spans]]
  const pieces: Line[] = []
  for (let from = 0; from < total; from += width) pieces.push(sliceSpans(spans, from, from + width))
  return pieces
}

/**
 * A line of prose cut into pieces of at most `width` cells at its spaces (a word longer than the width is cut where it must be), the
 * spaces a cut falls on dropped. At least one piece.
 */
export function wrapWords(spans: readonly Span[], width: number): Line[] {
  if (lineWidth(spans) <= width || width < 1) return [[...spans]]
  const all = spans.flatMap((span) => [...cells(span.text)])
  const pieces: Line[] = []
  let col = 0
  let breakAt = -1
  let from = 0
  const colOf: number[] = []
  all.forEach((cell, index) => { colOf[index] = col; col += cell.width })
  colOf[all.length] = col
  // `index` walks the cells; a piece ends before the first cell that would cross `width`, at the last space seen if there is one.
  for (let index = 0; index < all.length; index++) {
    if (all[index]!.text === " " && index > from) breakAt = index
    if (colOf[index + 1]! - colOf[from]! <= width) continue
    const end = breakAt > from ? breakAt : Math.max(from + 1, index)
    pieces.push(sliceSpans(spans, colOf[from]!, colOf[end]!))
    from = end
    while (all[from]?.text === " ") from++
    breakAt = -1
    index = from - 1
  }
  if (from < all.length) pieces.push(sliceSpans(spans, colOf[from]!, colOf[all.length]!))
  return pieces.length > 0 ? pieces : [[...spans]]
}

/** The matches of `query` in the spans (case-insensitive unless it has a capital) painted, the rest of the styling kept. */
export function paintQuery(spans: readonly Span[], query: string, current: boolean): Line {
  const text = spans.map((span) => span.text).join("")
  const hay = query === query.toLowerCase() ? text.toLowerCase() : text
  const found: Array<[number, number]> = []
  for (let at = hay.indexOf(query); at >= 0 && query; at = hay.indexOf(query, at + query.length)) found.push([at, at + query.length])
  if (!found.length) return [...spans]
  const out: Line = []
  let index = 0
  for (const span of spans) {
    const start = index
    const end = index + span.text.length
    index = end
    let cursor = start
    for (const [from, to] of found) {
      if (to <= cursor || from >= end) continue
      if (from > cursor) out.push({ ...span, text: text.slice(cursor, from) })
      const a = Math.max(from, cursor)
      const b = Math.min(to, end)
      out.push({ ...span, text: text.slice(a, b), fg: "background", bg: current ? "primary" : "warning" })
      cursor = b
    }
    if (cursor < end) out.push({ ...span, text: text.slice(cursor, end) })
  }
  return out
}

/** How many entries the folder holds, as the header says it: the daemon stops counting at `FILE_VIEW_MAX_SCAN`, so that many is "and more". */
function entryTotal(m: Input) {
  const total = m.entriesTotal ?? (m.entries?.length ?? 0)
  return { total, text: `${total}${total >= FILE_VIEW_MAX_SCAN ? "+" : ""}` }
}

/** The actions of the header, in the order they are dropped from the end when the row is narrow: each is a key and a word, drawn as a hint. */
const HEADER_ACTIONS = { open: "o open", ask: "a ask", copy: "y copy" } as const

/**
 * One row: the way back, the file's path (bold) and what it holds (muted) on the left; on the right the actions as hints (`o open · a ask
 * · y copy`, muted like every hint row), each still a click. The same muted chrome as the panel's and the pages' hints: no link color.
 */
function header(m: Input, glyphs: { back: string }): { line: Line; hits: ViewHit[] } {
  const folder = m.kind === "directory" && !!m.entries
  const meta = folder ? ` · ${entryTotal(m).text} entr${entryTotal(m).total === 1 ? "y" : "ies"}` : m.kind === "text" ? ` · ${m.lines} line${m.lines === 1 ? "" : "s"}` : m.kind === "loading" ? "" : ` · ${fileSize(m.size)}`
  // The language is told only when the name does not say it (a Dockerfile, a script without an extension); `.md` already says markdown.
  const language = m.kind === "text" && m.language !== "text" && !/\.[^./]+$/.test(m.name) ? ` · ${m.language}` : m.mime ? ` · ${m.mime}` : ""
  // A folder has no line to open in an editor.
  const sets: ReadonlyArray<ReadonlyArray<keyof typeof HEADER_ACTIONS>> = folder ? [["ask", "copy"], ["copy"], []] : [["open", "ask", "copy"], ["open", "copy"], ["copy"], []]
  const lead = `${glyphs.back} `
  const wanted = (names: ReadonlyArray<keyof typeof HEADER_ACTIONS>) => names.reduce((sum, name) => sum + textWidth(HEADER_ACTIONS[name]), 0) + Math.max(0, names.length - 1) * 3
  const names = sets.find((set) => m.width - wanted(set) - 2 >= lead.length + Math.min(textWidth(m.name), 12) + 4) ?? sets.at(-1)!
  const room = Math.max(1, m.width - wanted(names) - (names.length ? 2 : 0) - lead.length)
  const shown = truncateEnd(m.name, Math.max(4, Math.min(textWidth(m.name), room)))
  // What the file holds is said whole or not at all: `· 2…` for `· 272 lines` reads as a broken row.
  const whole = `${meta}${language}`
  const details = textWidth(whole) <= room - textWidth(shown) ? whole : textWidth(meta) <= room - textWidth(shown) ? meta : ""
  const left: ActLine = [{ text: lead, fg: "muted", action: "close" }, { text: shown, fg: "text", bold: true }, { text: details, fg: "muted" }]
  const right: ActLine = names.flatMap((name, index): ActLine => [...(index ? [{ text: " · ", fg: "muted" as const }] : []), { text: HEADER_ACTIONS[name], fg: "muted", action: name }])
  return drawn(spread(left, right, m.width), m.width)
}

/** A span that names the action a press on it runs (the built-in's hit regions are found from these, then the names are dropped). */
type ActLine = Array<Span & { action?: string }>

/** The row cut to `width`, and the regions of its clickable spans. */
function drawn(line: ActLine, width: number): { line: Line; hits: ViewHit[] } {
  const row = fit(line, width) as ActLine
  const hits: ViewHit[] = []
  let col = 0
  for (const span of row) {
    const wide = textWidth(span.text)
    if (span.action && wide > 0) hits.push({ row: 0, from: col, to: col + wide, action: span.action })
    col += wide
  }
  return { line: row.map(({ action: _action, ...rest }) => rest), hits }
}

/** The entries of a folder listing that fit in `room` rows: `m.top` is the 1-based index of the first one asked for, held inside the list. */
function window(m: Input, room: number): { first: number; count: number; cut: boolean } {
  const total = m.entries?.length ?? 0
  const listed = total - (m.entries?.[0]?.kind === "up" ? 1 : 0)
  const cut = (m.entriesTotal ?? listed) > listed
  // A cut listing keeps its last row for saying so.
  const space = cut ? Math.max(1, room - 1) : room
  const first = Math.max(0, Math.min(m.top - 1, total - space))
  return { first, count: Math.max(0, Math.min(space, total - first)), cut }
}

/** Where the window is in the file (`41-80/157`) or the folder, for the end of the hint row. */
function position(m: Input, drawn?: number): string {
  const shown = m.entries ? window(m, Math.max(1, m.height - FILE_VIEWER_CHROME)) : undefined
  if (shown && shown.count > 0) return `${shown.first + 1}-${shown.first + shown.count}/${m.entries!.length}`
  const last = drawn ?? m.rows.findLast((row) => !row.pending)?.line ?? m.top
  return m.kind === "text" && m.lines > 0 ? `${m.top}-${last}/${m.lines}` : ""
}

/** A folder's rows: one per entry (folders first, `..` on top), the one under the keyboard marked and filled like a selected line, the sizes of files on the right. */
function entryRows(m: Input, room: number, glyphs: { bar: string }): { lines: Line[]; hits: ViewHit[] } {
  const entries = m.entries ?? []
  const lines: Line[] = []
  const hits: ViewHit[] = []
  if (entries.length === 0) return { lines: [fit([{ text: " the folder is empty", fg: "muted" }], m.width)], hits }
  const { first, count, cut } = window(m, room)
  for (let index = first; index < first + count; index++) {
    const entry = entries[index]!
    const on = index === m.cursor
    const fill = on ? { bg: "element" as const } : {}
    const name = entry.kind === "up" ? ".." : entry.kind === "dir" ? `${entry.name}/` : entry.kind === "link" ? `${entry.name}@` : entry.name
    const size: Line = entry.kind === "file" && entry.size !== undefined ? [{ text: ` ${fileSize(entry.size)} `, fg: "muted", ...fill }] : [{ text: " ", ...fill }]
    const space = Math.max(1, m.width - 2 - lineWidth(size))
    const tone = entry.kind === "dir" || entry.kind === "up" ? "primary" : entry.kind === "file" ? "text" : "muted"
    const label = truncateEnd(name, space)
    const row: Line = [{ text: on ? glyphs.bar : " ", fg: "primary", ...fill }, { text: " ", ...fill }, { text: label, fg: tone, ...(on ? { bold: true } : {}), ...fill }, { text: " ".repeat(Math.max(0, space - textWidth(label))), ...fill }, ...size]
    lines.push(clip(row, m.width))
    hits.push({ row: lines.length - 1, from: 0, to: m.width, action: "entry", arg: index })
  }
  if (cut && lines.length < room) lines.push(fit([{ text: ` showing the first ${entries.filter((entry) => entry.kind !== "up").length} of ${entryTotal(m).text}`, fg: "warning" }], m.width))
  return { lines, hits }
}

function bodyRows(m: Input, room: number, glyphs: { bar: string; ellipsis: string; deleted: string }): { lines: Line[]; hits: ViewHit[]; /** The last file line drawn, when removed rows took room from the window. */ last?: number } {
  if (m.kind === "directory" && m.entries) return entryRows(m, room, glyphs)
  const lines: Line[] = []
  const hits: ViewHit[] = []
  if (m.kind !== "text") {
    const note = m.kind === "loading" ? "loading…" : m.note ?? ""
    const tone = m.kind === "loading" ? "muted" : "warning"
    for (const part of note.split("\n")) lines.push(fit([{ text: " " + truncateEnd(part, Math.max(1, m.width - 2)), fg: tone }], m.width))
    return { lines: lines.slice(0, room), hits }
  }
  const numberWidth = String(Math.max(1, m.lines)).length
  const showNumbers = m.options.lineNumbers && m.width >= 24
  const prefix = 1 + (showNumbers ? numberWidth + 1 : 1)
  const code = Math.max(1, m.width - prefix)
  const current = m.search ? m.search.current : -1
  let last = m.top
  for (const row of m.rows) {
    if (lines.length >= room) break
    // What HEAD had here and the file no longer has: red rows with no number of their own, read like the `-` side of a diff.
    const gone = row.removed?.length ? [...row.removed, ...(row.removedMore ? [`${glyphs.ellipsis} ${row.removedMore} more removed`] : [])] : []
    for (const text of gone) {
      if (lines.length >= room) break
      const body = truncateEnd(text, Math.max(1, code))
      lines.push(clip([{ text: "-", fg: "error", bg: "diffRemovedBg" }, { text: " ".repeat(prefix - 1), bg: "diffRemovedBg" }, { text: body, fg: "error", bg: "diffRemovedBg" }, { text: " ".repeat(Math.max(0, m.width - prefix - textWidth(body))), bg: "diffRemovedBg" }], m.width))
    }
    if (lines.length >= room) break
    if (!row.pending) last = row.line
    // An added or changed line is tinted like the `+` side of a diff; the selection's own fill wins.
    const changed = row.mark === "added" || row.mark === "modified"
    const fill = row.selected ? { bg: "element" as const } : changed ? { bg: "diffAddedBg" as const } : {}
    const base: Span[] = row.pending ? [{ text: glyphs.ellipsis, fg: "muted", dim: true }] : row.spans.length ? [...row.spans] as unknown as Span[] : []
    const painted = m.search?.query && row.hit && !row.pending ? paintQuery(base, m.search.query, row.line === current) : base
    const shifted = m.options.wrap ? painted : sliceSpans(painted, m.options.left, m.options.left + code)
    const pieces = m.options.wrap ? (m.options.prose ? wrapWords : wrapCode)(shifted, code) : [shifted]
    pieces.forEach((piece, index) => {
      if (lines.length >= room) return
      const mark = index === 0 && row.mark ? [{ text: row.mark === "deleted" ? glyphs.deleted : glyphs.bar, fg: MARKS[row.mark] as Span["fg"], ...fill }] : [{ text: " ", ...fill }]
      const number = showNumbers ? [{ text: index === 0 ? String(row.line).padStart(numberWidth) + " " : " ".repeat(numberWidth + 1), fg: row.selected ? "primary" as const : "muted" as const, ...(row.selected ? { bold: true } : { dim: true }), ...fill }] : [{ text: " ", ...fill }]
      const body = piece.map((span) => ({ ...span, ...fill }))
      const used = prefix + lineWidth(body)
      const pad: Span[] = used < m.width ? [{ text: " ".repeat(m.width - used), ...fill }] : []
      lines.push(clip([...mark, ...number, ...body, ...pad], m.width))
      if (!row.pending) hits.push({ row: lines.length - 1, from: 0, to: m.width, action: "line", arg: row.line })
    })
  }
  return { lines, hits, ...(m.rows.some((row) => row.removed?.length) ? { last } : {}) }
}

/**
 * The last row, all muted like every hint row of the app. In the slot with the keyboard elsewhere it names the keys that bring it here
 * (`opt+} focus · opt+{ panel`, as the user's bindings and the Option label say them; a key that is not bound is not named), and the
 * `panel` hint is a click. With the keyboard in the viewer it lists the viewer's own keys. The end of the row says what happened last, or where the window is.
 */
function hint(m: Input, lastDrawn?: number): { line: Line; hits: ViewHit[] } {
  // The slot's last row is the screen's, and the screen never writes its bottom-right cell: what ends the row stops one cell short, or `1-58/1479` reads `1-58/147`.
  const w = m.variant === "slot" ? Math.max(1, m.width - 1) : m.width
  if (m.search?.typing) {
    const count = m.search.total ? `${m.search.total} match${m.search.total === 1 ? "" : "es"}` : m.search.query ? "no match" : ""
    return { line: fit(spread([{ text: "/", fg: "primary" }, { text: m.search.query, fg: "text" }, { text: m.ascii ? "_" : "▏", fg: "primary" }], [{ text: count, fg: "muted" }], w), m.width), hits: [] }
  }
  const folder = m.kind === "directory" && !!m.entries
  const state: Line = m.search?.query ? [{ text: `/${m.search.query} ${m.search.total ? "n/N" : "no match"}`, fg: "muted" }] : m.redacted ? [{ text: `${m.redacted} masked`, fg: "warning" }] : m.notice ? [{ text: m.notice, fg: "muted" }] : [{ text: position(m, lastDrawn), fg: "muted" }]
  const sep: ActLine = [{ text: " · ", fg: "muted" }]
  const text = (value: string): ActLine => [{ text: value, fg: "muted" }]
  let left: ActLine
  if (m.variant === "page" || m.focused) {
    // [hint, rank]: when the row is narrow the highest rank goes first, the state at the end of the row keeps its place.
    const keys: ReadonlyArray<readonly [string, number]> = m.variant === "page"
      ? folder ? [["esc back", 1], ["enter open", 2], ["backspace up", 3], ["r reload", 4]] : [["esc back", 1], ["/ find", 2], [": line", 4], ["n/N next", 5], ["r reload", 3]]
      : folder ? [["j/k move", 1], ["enter open", 2], ["backspace up", 3], ["a ask", 6], ["y copy", 5], ["r reload", 7], ["q close", 4]] : [["j/k move", 1], ["/ find", 2], ["a ask", 6], ["o open", 5], ["y copy", 4], ["r reload", 7], ["q close", 3]]
    let kept = [...keys]
    const build = () => kept.map(([value]) => value).join(" · ")
    while (kept.length > 1 && textWidth(build()) + 2 + lineWidth(state) > w) {
      const worst = Math.max(...kept.map(([, rank]) => rank))
      kept = kept.filter(([, rank]) => rank !== worst)
    }
    left = text(build())
  } else {
    const parts: ActLine[] = [
      ...(m.keys?.focus ? [text(`${m.keys.focus} focus`)] : []),
      ...(m.panel && m.keys?.switch ? [[{ text: `${m.keys.switch} panel`, fg: "muted" as const, action: "switch" }]] : []),
    ]
    left = parts.flatMap((part, index): ActLine => (index ? [...sep, ...part] : part))
    // The reminder of what a click does only when there is room for it after the keys.
    const filler = folder ? "click an entry to open it" : "click a line to select"
    const used = lineWidth(left) + (left.length ? 3 : 0) + textWidth(filler)
    if (used + 2 + lineWidth(state) <= w) left = [...left, ...(left.length ? sep : []), ...text(filler)]
  }
  return drawn(state.length && lineWidth(left) + 2 + lineWidth(state) <= w ? spread(left, state, w) : left, m.width)
}

export function renderFileViewer(m: Input): { lines: Line[]; hits: ViewHit[] } {
  const glyphs = m.ascii ? { back: "<", bar: "|", deleted: "v", ellipsis: "...", dot: "-" } : { back: "‹", bar: "▎", deleted: "▾", ellipsis: "…", dot: "·" }
  const head = header(m, glyphs)
  const room = Math.max(0, m.height - FILE_VIEWER_CHROME)
  const body = bodyRows(m, room, glyphs)
  const lines: Line[] = [head.line, ...body.lines]
  while (lines.length < Math.max(FILE_VIEWER_CHROME - 1, m.height - 1)) lines.push(fit([], m.width))
  const foot = hint(m, body.last)
  lines.push(foot.line)
  return {
    lines: lines.slice(0, m.height),
    hits: [...head.hits, ...body.hits.map((hit) => ({ ...hit, row: hit.row + 1 })), ...foot.hits.map((hit) => ({ ...hit, row: m.height - 1 }))],
  }
}
