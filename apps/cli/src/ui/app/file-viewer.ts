import path from "node:path"
import { FILE_VIEW_MAX_ROWS, parseDiffRows, sanitizeState, type FileView, type FileViewKind } from "@mendcode/protocol/wire"
import type { ChangesReport } from "@mendcode/protocol"
import type { FileViewerEntry, FileViewerModel, FileViewerRow } from "@mendcode/extension-api/views"
import { fileSize, FILE_VIEWER_CHROME, FILE_VIEWER_REMOVED } from "../../view/file-viewer"
import { rangeLabel } from "../../view/file-ref"
import { fileUri } from "../../view/links"
import { highlight, type HighlightState } from "../../view/syntax"
import { actionHint } from "../keymap"
import { languageOfPath } from "../../view/tool-bodies"
import type { ViewHit } from "../../view/views"
import type { Line } from "../theme"
import type { AppContext } from "./context"
import { fileInSlot, panelWanted, slotCells } from "./file-slot"
import { rightBarCells } from "../../view/right-bar"
import { fit, spread } from "../../view/deck"
import { truncateEnd } from "../../view/wrap"

/** The file a click, `/open` or an extension asked for: `root` is the workspace directory that holds it, `path` is relative to it. */
export type FileTarget = { root: string; path: string; absolute: string; line?: number; endLine?: number }

/** How the viewer is installed beyond the file: whether the keyboard stays (moving through a listing), the folder a file was opened from, the entry to land on. */
type OpenOptions = { focused?: boolean; origin?: string; cursorName?: string }
type Cached = { text: string; spans: ReturnType<typeof highlight> }
type Mark = "added" | "modified" | "deleted"

export type FileViewerState = {
  root: string
  path: string
  absolute: string
  /** What the right slot shows while the file is open and the panel exists too. */
  showing: "file" | "panel"
  /** Drawn as the `file` page (a terminal too narrow for the slot). */
  page: boolean
  /** The keyboard is in the viewer. */
  focused: boolean
  kind: FileViewKind | "loading" | "error"
  size: number
  mime?: string
  note?: string
  /** `FileView.version` of what is shown; sent back as `known` to ask whether the file changed. */
  version: string
  lang: string
  lines: number
  /** First line shown (1-based) and the first column when long lines are cut. */
  top: number
  left: number
  rows: Map<number, Cached>
  marks: Map<number, Mark>
  /** What HEAD had just above a line and the working file no longer has. */
  gone?: Map<number, string[]>
  /** Set when the file opened without a line: the first Git marks to arrive move the window to the first change. */
  landOnChange?: boolean
  /** A folder's listing (`directory`): `..` first when the folder is not the workspace root. `top` is then the 1-based index of the first entry shown. */
  entries: FileViewerEntry[]
  entriesTotal: number
  /** The entry the keyboard is on. */
  cursor: number
  /** The folder this file was opened from (a listing), so backspace goes back to it. */
  origin?: string | undefined
  /** The cited or clicked lines. */
  selection?: { from: number; to: number }
  search: { query: string; typing: boolean; lines: number[]; total: number; current: number }
  /** `:` typed: the line number being entered. */
  goto?: string
  wrap: boolean
  /** Markdown or text: wrapped at its spaces, and by default (`viewerWrap: auto`). */
  prose: boolean
  numbers: boolean
  notice?: string | undefined
  redacted: number
  /** Where the last frame drew it, for the mouse. */
  drawn?: { width: number; height: number; hits: ViewHit[] }
  /** The panel's keyboard focus before the file opened, given back when it closes. */
  rightFocus: boolean
  /** The cited line, kept for the editor link. */
  cited?: number
  token: number
  inflight?: string | undefined
  drag?: { anchor: number; moved: boolean; wasSelected: boolean } | undefined
}

const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/
const WINDOW_ROOM = 120
const CACHE_LIMIT = 1_500
const REFRESH_GAP_MS = 300

const PROSE_EXTENSIONS = new Set("md mdx markdown txt text rst adoc asciidoc org".split(" "))

/** Prose reads as paragraphs: Markdown and text files, and a file with no extension that the highlighter has no language for (README, LICENSE, NOTICE). */
function isProse(file: string): boolean {
  const name = file.split("/").at(-1) ?? file
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  return extension ? PROSE_EXTENSIONS.has(extension) : !!name && languageOfPath(file) === undefined && !/^(Makefile|Dockerfile|Gemfile|Rakefile|Procfile|Justfile)$/i.test(name)
}

/** A tab is expanded to the next multiple of four columns and other control characters become a dot, so a row is made of printable cells only. */
function clean(text: string): string {
  let out = ""
  for (const char of text) {
    if (char === "\t") out += " ".repeat(4 - (out.length % 4))
    else out += /[\x00-\x1f\x7f-\x9f]/.test(char) ? "·" : char
  }
  return out
}

export function createFileViewer(ctx: AppContext, deps: { insertPrompt(text: string): void }) {
  const { input, state, requestFrame, say } = ctx
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let lastRefresh = 0
  let opening = 0

  const room = (fv: FileViewerState) => Math.max(1, (fv.drawn?.height ?? input.screen.size.height) - FILE_VIEWER_CHROME)
  const current = () => state.fileViewer
  const display = (fv: Pick<FileViewerState, "absolute" | "root">) => {
    const base = input.directory ?? fv.root
    const relative = path.relative(base, fv.absolute)
    if (relative === "") return "."
    return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : fv.absolute
  }

  function store(fv: FileViewerState, view: FileView) {
    if (view.kind !== "text" || view.from === undefined || !view.rows) return
    // The tokenizer's state at the first row, from the daemon: a block comment, a triple-quoted string or a fence opened above the window is still open here.
    const carry: HighlightState = sanitizeState(view.lex)
    view.rows.forEach((raw, index) => {
      const text = clean(raw)
      // A language the highlighter does not know is drawn the way the chat's read card draws it (the code role); a prose file is plain text.
      fv.rows.set(view.from! + index, { text, spans: fv.lang === "text" ? (text ? [{ text, fg: fv.prose ? "text" : "code" }] : []) : highlight(text, fv.lang, carry) })
    })
    if (fv.rows.size > CACHE_LIMIT) {
      const keep = fv.top
      for (const line of [...fv.rows.keys()]) if (Math.abs(line - keep) > CACHE_LIMIT / 2) fv.rows.delete(line)
    }
    fv.lines = view.lines ?? fv.lines
    fv.redacted = view.redacted ?? 0
  }

  function apply(fv: FileViewerState, view: FileView) {
    fv.kind = view.kind
    fv.size = view.size
    fv.version = view.version
    if (view.mime) fv.mime = view.mime
    else delete fv.mime
    delete fv.note
    if (view.kind === "binary") fv.note = `binary file${view.mime ? ` · ${view.mime}` : ""} · ${fileSize(view.size)}\nnot shown`
    else if (view.kind === "special") fv.note = "device, pipe or socket\nnot opened"
    else if (view.kind === "large") fv.note = `too large to view · ${fileSize(view.size)}\nthe viewer reads files up to ${fileSize(4 * 1024 * 1024)}`
    else if (view.kind === "missing") fv.note = "the file no longer exists"
    else if (view.kind === "directory") fv.note = "this is a folder"
    else if (view.kind === "outside") fv.note = "outside the workspace\nnot read"
    if (view.kind === "text") store(fv, view)
    else {
      fv.rows.clear()
      fv.lines = 0
      fv.marks.clear()
    }
    if (view.kind === "directory" && view.entries) {
      delete fv.note
      fv.entries = [...(fv.path === "." ? [] : [{ name: "..", kind: "up" as const }]), ...view.entries.map((entry): FileViewerEntry => ({ name: clean(entry.name), kind: entry.kind, ...(entry.size !== undefined ? { size: entry.size } : {}) }))]
      fv.entriesTotal = view.entriesTotal ?? view.entries.length
      fv.lines = fv.entries.length
      fv.cursor = Math.max(0, Math.min(fv.cursor, fv.entries.length - 1))
    } else fv.entries = []
  }

  async function read(fv: Pick<FileViewerState, "root" | "path"> & { lang?: string }, extra: { from?: number; count?: number; search?: string; known?: string }) {
    const lang = fv.lang && fv.lang !== "text" ? fv.lang : undefined
    const reply = await input.send({ type: "file.view", directory: fv.root, path: fv.path, ...(extra.from ? { from: extra.from } : {}), ...(extra.count ? { count: extra.count } : {}), ...(extra.search ? { search: extra.search } : {}), ...(extra.known ? { known: extra.known } : {}), ...(lang ? { lang } : {}) })
    if (!reply.ok) return { error: reply.error.message }
    const view = reply.result as FileView | undefined
    return typeof view?.kind === "string" ? { view } : { error: "this daemon cannot show files yet" }
  }

  /** The window the viewport needs, asked for once; rows already read stay. */
  function ensureWindow(fv: FileViewerState) {
    if (fv.kind !== "text") return
    const last = Math.min(fv.lines, fv.top + room(fv) - 1)
    let missing = -1
    for (let line = fv.top; line <= last; line++) if (!fv.rows.has(line)) { missing = line; break }
    if (missing < 0) return
    const from = Math.max(1, missing - 30)
    const key = `${fv.token}:${from}`
    if (fv.inflight === key) return
    fv.inflight = key
    const token = fv.token
    void read(fv, { from, count: Math.min(FILE_VIEW_MAX_ROWS, room(fv) + WINDOW_ROOM) }).then((answer) => {
      if (state.fileViewer !== fv || fv.token !== token) return
      fv.inflight = undefined
      if (answer.view?.kind === "text") store(fv, answer.view)
      else if (answer.view) apply(fv, answer.view)
      requestFrame()
    })
  }

  /** Git marks: the file's hunks against HEAD, read from the changes report (the same one the Changes page draws). */
  async function loadMarks(fv: FileViewerState) {
    const directory = input.directory ?? fv.root
    const reply = await input.send({ type: "changes.query", directory })
    if (state.fileViewer !== fv || !reply.ok) return
    const report = reply.result as ChangesReport | undefined
    if (!report?.root || !Array.isArray(report.files)) return
    const relative = path.relative(report.root, fv.absolute).split(path.sep).join("/")
    let file = report.files.find((entry) => entry.path === relative)
    if (!file || file.binary) { fv.marks.clear(); requestFrame(); return }
    if (file.truncated) {
      const full = await input.send({ type: "changes.file", directory, path: relative })
      if (state.fileViewer !== fv) return
      if (full.ok) file = full.result as typeof file
    }
    const marks = new Map<number, Mark>()
    const gone = new Map<number, string[]>()
    let removed = 0
    let added = 0
    // The removed lines of a hunk are shown above the first line that follows them in the working file.
    let pending: string[] = []
    const place = (line: number) => {
      if (pending.length && !gone.has(line)) gone.set(line, pending)
      pending = []
    }
    for (const row of parseDiffRows(file.diff.split("\n"))) {
      if (row.kind === "del") { removed++; pending.push(row.text.slice(1).replace(/\t/g, "  ").replace(/[\x00-\x1f\x7f-\x9f]/g, " ")); continue }
      if (row.kind === "add" && row.new !== undefined) {
        place(row.new)
        marks.set(row.new, removed > added ? "modified" : "added")
        added++
        continue
      }
      if (row.new !== undefined) place(row.new)
      else pending = []
      if (removed > added && row.new !== undefined) marks.set(row.new, "deleted")
      removed = 0
      added = 0
    }
    fv.marks = marks
    fv.gone = gone
    // Opened without a line (a click on an edit's path): land on the first change instead of the top of the file.
    const land = fv.landOnChange && fv.top === 1 && !fv.selection && marks.size > 0
    fv.landOnChange = false
    if (land) return goto(fv, Math.min(...marks.keys()), true)
    requestFrame()
  }

  function install(target: FileTarget, view: FileView, options: OpenOptions = {}): FileViewerState {
    const previous = current()
    const lang = languageOfPath(target.path) ?? "text"
    const prose = isProse(target.path)
    const fv: FileViewerState = {
      root: target.root, path: target.path, absolute: target.absolute,
      showing: "file", page: previous?.page ?? false, focused: options.focused ?? state.tuiProfile.viewerFocus,
      kind: view.kind, size: view.size, version: view.version, lang, lines: view.lines ?? 0,
      top: 1, left: 0, rows: new Map(), marks: new Map(), entries: [], entriesTotal: 0, cursor: 0, origin: options.origin,
      search: { query: "", typing: false, lines: [], total: 0, current: -1 },
      wrap: state.tuiProfile.viewerWrap === "on" || state.tuiProfile.viewerWrap === "auto" && prose, prose, numbers: state.tuiProfile.viewerNumbers,
      redacted: 0, rightFocus: previous?.rightFocus ?? state.rightFocus, token: (previous?.token ?? 0) + 1,
    }
    apply(fv, view)
    // Coming back up to a folder puts the keyboard on the one just left.
    if (options.cursorName !== undefined) fv.cursor = Math.max(0, fv.entries.findIndex((entry) => entry.name === options.cursorName))
    const first = fv.kind === "directory" ? fv.cursor + 1 : target.line ?? 1
    fv.top = Math.max(1, Math.min(Math.max(1, fv.lines), first - Math.floor(room(fv) / 3)))
    fv.landOnChange = !target.line && fv.kind === "text"
    if (target.line && fv.kind === "text") {
      fv.cited = Math.min(target.line, Math.max(1, fv.lines))
      fv.selection = { from: fv.cited, to: Math.min(target.endLine ?? fv.cited, Math.max(1, fv.lines)) }
    }
    if (!previous) state.rightFocus = false
    state.fileViewer = fv
    return fv
  }

  /**
   * Opens `target` in the viewer (a folder shows its listing); a path that is not readable says so in one line and leaves everything as it was.
   * True once it is open.
   */
  async function open(target: FileTarget, options: OpenOptions & { quietMissing?: boolean } = {}): Promise<boolean> {
    const ticket = ++opening
    const start = Math.max(1, (target.line ?? 1) - Math.floor((input.screen.size.height - FILE_VIEWER_CHROME) / 3))
    const lang = languageOfPath(target.path)
    const answer = await read({ ...target, ...(lang ? { lang } : {}) }, { from: start, count: Math.min(FILE_VIEW_MAX_ROWS, input.screen.size.height + WINDOW_ROOM) })
    if (ticket !== opening) return false
    if (!answer.view) return (say(`not opened: ${answer.error}`, "warning"), false)
    const label = display({ absolute: target.absolute, root: target.root })
    if (answer.view.kind === "outside") return (say(`not opened: ${label} is outside the workspace`, "warning"), false)
    if (answer.view.kind === "missing") return (options.quietMissing ? undefined : say(`not opened: ${label} does not exist`, "warning"), false)
    if (answer.view.kind === "directory" && !answer.view.entries) return (say(`not opened: ${label} is a folder that cannot be listed`, "warning"), false)
    const fv = install(target, answer.view, options)
    if (fv.kind === "text") fv.top = Math.max(1, Math.min(Math.max(1, fv.lines), (target.line ?? 1) - Math.floor(room(fv) / 3)))
    syncPage(input.screen.size.width)
    if (fv.kind === "text") void loadMarks(fv)
    requestFrame()
    return true
  }

  function close() {
    const fv = current()
    if (!fv) return
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = undefined
    state.fileViewer = undefined
    state.rightFocus = fv.rightFocus
    if (state.page === "file") state.page = "chat"
    requestFrame()
  }

  /** The page when the slot does not fit, the slot when it does; run at the top of every frame. */
  function syncPage(width: number) {
    const fv = current()
    if (!fv) {
      if (state.page === "file") state.page = "chat"
      return
    }
    if (state.page !== "chat" && state.page !== "file") return
    const bar = rightBarCells({ columns: width, setting: state.tuiProfile.sidebarWidth, collapsed: state.rightBarCollapsed })
    state.rightBarCollapsed = bar.collapsed
    const fits = bar.cells > 0
    fv.page = !fits
    state.page = fits ? "chat" : "file"
  }

  async function refresh(manual = false) {
    const fv = current()
    if (!fv) return
    const wait = REFRESH_GAP_MS - (ctx.now() - lastRefresh)
    if (!manual && wait > 0) {
      refreshTimer ??= setTimeout(() => { refreshTimer = undefined; void refresh() }, wait)
      return
    }
    lastRefresh = ctx.now()
    const token = fv.token
    const answer = await read(fv, { from: fv.top, count: Math.min(FILE_VIEW_MAX_ROWS, room(fv) + WINDOW_ROOM), known: fv.version })
    if (state.fileViewer !== fv || fv.token !== token || !answer.view) return
    if (answer.view.unchanged) {
      if (manual) { fv.notice = "up to date"; requestFrame() }
      return
    }
    const before = fv.lines
    fv.rows.clear()
    apply(fv, answer.view)
    fv.top = Math.max(1, Math.min(fv.top, Math.max(1, fv.lines)))
    fv.notice = answer.view.kind === "text" ? (fv.lines === before ? "reloaded" : `reloaded · ${fv.lines} lines`) : undefined
    if (fv.search.query) void runSearch(fv, fv.search.query, false)
    if (fv.kind === "text") void loadMarks(fv)
    requestFrame()
  }

  function goto(fv: FileViewerState, line: number, centre = false) {
    const last = Math.max(1, fv.lines)
    const target = Math.max(1, Math.min(last, line))
    fv.top = centre ? Math.max(1, Math.min(last, target - Math.floor(room(fv) / 3))) : target
    delete fv.notice
    requestFrame()
  }

  async function runSearch(fv: FileViewerState, query: string, jump: boolean) {
    if (!query) { fv.search = { query: "", typing: false, lines: [], total: 0, current: -1 }; return requestFrame() }
    const answer = await read(fv, { from: fv.top, count: 1, search: query })
    if (state.fileViewer !== fv) return
    if (!answer.view?.hits) { fv.notice = answer.error ?? "search failed"; return requestFrame() }
    const lines = answer.view.hits.lines
    const next = lines.findIndex((line) => line >= fv.top)
    fv.search = { query, typing: false, lines, total: answer.view.hits.total, current: lines.length ? (next < 0 ? 0 : next) : -1 }
    if (jump && lines.length) goto(fv, lines[fv.search.current]!, true)
    requestFrame()
  }

  function step(fv: FileViewerState, direction: 1 | -1) {
    const { lines } = fv.search
    if (!lines.length) { fv.notice = fv.search.query ? "no match" : "/ to search"; return requestFrame() }
    fv.search.current = (fv.search.current + direction + lines.length) % lines.length
    goto(fv, lines[fv.search.current]!, true)
  }

  function selectedRange(fv: FileViewerState): { from: number; to: number } | undefined {
    return fv.selection ? { from: Math.min(fv.selection.from, fv.selection.to), to: Math.max(fv.selection.from, fv.selection.to) } : undefined
  }

  async function copy(fv: FileViewerState) {
    const range = selectedRange(fv)
    if (!range || fv.kind !== "text") return ctx.copyText(display(fv), "the path")
    const to = Math.min(range.to, range.from + FILE_VIEW_MAX_ROWS - 1)
    if (![...Array(to - range.from + 1).keys()].every((index) => fv.rows.has(range.from + index))) {
      const answer = await read(fv, { from: range.from, count: to - range.from + 1 })
      if (answer.view) store(fv, answer.view)
    }
    const text = [...Array(to - range.from + 1).keys()].map((index) => fv.rows.get(range.from + index)?.text ?? "").join("\n")
    ctx.copyText(text, `${to - range.from + 1} line${to > range.from ? "s" : ""}${to < range.to ? ` of ${range.to - range.from + 1}` : ""}`)
  }

  function ask(fv: FileViewerState) {
    const range = selectedRange(fv)
    const shown = display(fv)
    const name = /\s/.test(shown) ? JSON.stringify(shown) : shown
    deps.insertPrompt(`@${name}${range ? `:${rangeLabel(range.from, range.to)}` : ""} `)
    fv.focused = false
    say(`added ${shown}${range ? `:${rangeLabel(range.from, range.to)}` : ""} to the prompt`, "success")
  }

  async function openExternal(fv: FileViewerState) {
    if (input.remote) return say("open: this terminal is remote · ctrl+click the link where your editor runs", "info")
    const line = selectedRange(fv)?.from ?? fv.cited ?? fv.top
    const reply = await input.send({ type: "ide.open", directory: input.directory ?? fv.root, filePath: fv.absolute, line, character: 1 })
    if (reply.ok && reply.result?.opened === true) return say(`opened ${display(fv)}:${line} in your editor`, "success")
    say("open: no editor bridge · ctrl+click the link, or /ide on", "info")
  }

  /** Switches the right slot between the open file and the panel (only while both exist). */
  function switchSlot(fv: FileViewerState) {
    if (fv.page) return say("no panel on a page", "info")
    if (!panelWanted(state)) return say("no panel to switch to · /panel", "info")
    fv.showing = fv.showing === "file" ? "panel" : "file"
    fv.focused = false
    requestFrame()
  }

  function model(fv: FileViewerState, variant: "slot" | "page"): FileViewerModel {
    const last = Math.min(Math.max(fv.lines, 1), fv.top + room(fv) - 1)
    const hits = new Set(fv.search.lines)
    const range = selectedRange(fv)
    const rows: FileViewerRow[] = []
    if (fv.kind === "text") {
      for (let line = fv.top; line <= last; line++) {
        const cached = fv.rows.get(line)
        const mark = fv.marks.get(line)
        const gone = fv.gone?.get(line)
        rows.push({ line, text: cached?.text ?? "", spans: cached?.spans ?? [], ...(mark ? { mark } : {}), ...(gone ? { removed: gone.slice(0, FILE_VIEWER_REMOVED), ...(gone.length > FILE_VIEWER_REMOVED ? { removedMore: gone.length - FILE_VIEWER_REMOVED } : {}) } : {}), selected: !!range && line >= range.from && line <= range.to, hit: hits.has(line), ...(cached ? {} : { pending: true as const }) })
      }
    }
    const folder = fv.kind === "directory"
    const link = state.tuiProfile.hyperlinks && !folder ? fileUri({ file: fv.absolute, line: range?.from ?? fv.cited ?? fv.top, opener: state.tuiProfile.fileOpener }) : undefined
    const keys = { focus: actionHint(state.bindings, "panel.focus"), switch: actionHint(state.bindings, "file.switch"), close: actionHint(state.bindings, "file.close") }
    return {
      variant, path: display(fv), name: folder ? `${display(fv) === "." ? path.basename(fv.root) : display(fv)}/` : path.basename(fv.path), language: fv.lang, kind: fv.kind === "outside" ? "error" : fv.kind, size: fv.size, lines: fv.lines,
      ...(fv.kind === "directory" ? { entries: fv.entries, cursor: fv.cursor, entriesTotal: fv.entriesTotal } : {}),
      keys: { ...(keys.focus ? { focus: keys.focus } : {}), ...(keys.switch ? { switch: keys.switch } : {}), ...(keys.close ? { close: keys.close } : {}) },
      ...(fv.mime ? { mime: fv.mime } : {}), ...(fv.note ? { note: fv.note } : {}),
      top: fv.top, rows, ...(range ? { selection: range } : {}),
      ...(fv.search.query || fv.search.typing ? { search: { query: fv.search.query, typing: fv.search.typing, current: fv.search.current >= 0 ? (fv.search.lines[fv.search.current] ?? 0) : 0, total: fv.search.total } } : {}),
      focused: fv.focused || variant === "page", panel: variant === "slot" && panelWanted(state),
      options: { lineNumbers: fv.numbers, wrap: fv.wrap, left: fv.left, prose: fv.prose },
      ...(fv.goto !== undefined ? { notice: `line: ${fv.goto}_` } : fv.notice ? { notice: fv.notice } : {}),
      ...(link ? { openLink: link } : {}), redacted: fv.redacted,
    }
  }

  function draw(fv: FileViewerState, variant: "slot" | "page", width: number, height: number): Line[] {
    fv.drawn = { width, height, hits: [] }
    ensureWindow(fv)
    const drawn = ctx.views.draw("file.viewer", model(fv, variant), { width, height })
    fv.drawn = { width, height, hits: drawn.hits }
    return drawn.lines
  }

  /** The slot's rows; while the panel has the slot, the panel's first row becomes a tab that names the open file. */
  function slotRows(width: number, height: number): Line[] {
    const fv = current()
    return fv ? draw(fv, "slot", width, height) : []
  }

  /** The panel's first row while a file is open behind it: the panel's name, the file's, and the key that switches. */
  function tabRow(width: number): Line {
    const fv = current()!
    const left: Line = [{ text: "panel", fg: "primary", bold: true }, { text: " · ", fg: "muted" }, { text: truncateEnd(path.basename(fv.path), Math.max(4, width - 22)), fg: "muted", underline: true }]
    const key = actionHint(state.bindings, "file.switch")
    return fit(spread(left, key ? [{ text: `${key} file`, fg: "muted" }] : [], width), width)
  }

  function pageRows(width: number, height: number): Line[] {
    const fv = current()
    return fv ? draw(fv, "page", width, height) : []
  }

  function onAction(fv: FileViewerState, hit: ViewHit) {
    if (hit.action === "close") close()
    else if (hit.action === "switch") switchSlot(fv)
    else if (hit.action === "open") void openExternal(fv)
    else if (hit.action === "ask") ask(fv)
    else if (hit.action === "copy") void copy(fv)
    else if (hit.action === "entry" && typeof hit.arg === "number") void activate(fv, hit.arg)
    requestFrame()
  }

  // ----- a folder's listing ---------------------------------------------------------------------------------------

  const parentOf = (folder: string) => (folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ".")
  const childOf = (folder: string, name: string) => (folder === "." ? name : `${folder}/${name}`)

  /** Opens `relative` (inside `fv.root`) in place of the listing, the keyboard where it was. */
  function enter(fv: FileViewerState, relative: string, options: OpenOptions = {}) {
    return open({ root: fv.root, path: relative, absolute: relative === "." ? fv.root : path.join(fv.root, relative) }, { focused: fv.focused, ...options })
  }

  /** The entry under the keyboard or the click: `..` goes up (never above the workspace root), a folder opens its listing, a file opens in the viewer. */
  async function activate(fv: FileViewerState, index: number) {
    const entry = fv.entries[index]
    if (!entry) return
    fv.cursor = index
    if (entry.kind === "up") return void await enter(fv, parentOf(fv.path), { cursorName: path.basename(fv.path) })
    const target = childOf(fv.path, entry.name)
    await enter(fv, target, { origin: fv.path })
  }

  /** The room a listing has for entries, one row less when it is cut (it says so on the last). */
  const entryRoom = (fv: FileViewerState) => Math.max(1, room(fv) - (fv.entriesTotal > fv.entries.filter((entry) => entry.kind !== "up").length ? 1 : 0))

  function moveCursor(fv: FileViewerState, to: number) {
    const last = Math.max(0, fv.entries.length - 1)
    fv.cursor = Math.max(0, Math.min(last, to))
    const rows = entryRoom(fv)
    if (fv.cursor < fv.top - 1) fv.top = fv.cursor + 1
    else if (fv.cursor > fv.top - 2 + rows) fv.top = fv.cursor - rows + 2
    delete fv.notice
    requestFrame()
  }

  /** Keys of a listing; undefined for the ones the viewer treats the same everywhere (close, ask, copy, reload...). */
  function folderKey(fv: FileViewerState, raw: string): boolean | undefined {
    const page = Math.max(1, entryRoom(fv) - 1)
    if (raw === "j" || raw === "\x1b[B") moveCursor(fv, fv.cursor + 1)
    else if (raw === "k" || raw === "\x1b[A") moveCursor(fv, fv.cursor - 1)
    else if (raw === " " || raw === "\x1b[6~" || raw === "\x04") moveCursor(fv, fv.cursor + page)
    else if (raw === "b" || raw === "\x1b[5~" || raw === "\x15") moveCursor(fv, fv.cursor - page)
    else if (raw === "g" || raw === "\x1b[H" || raw === "\x1b[1~") moveCursor(fv, 0)
    else if (raw === "G" || raw === "\x1b[F" || raw === "\x1b[4~") moveCursor(fv, fv.entries.length - 1)
    else if (raw === "\r" || raw === "l" || raw === "\x1b[C") void activate(fv, fv.cursor)
    else if (raw === "\x7f" || raw === "h" || raw === "\x1b[D") {
      if (fv.entries[0]?.kind === "up") void activate(fv, 0)
      else (fv.notice = "this is the workspace root", requestFrame())
    } else if (raw === "o") { fv.notice = "a folder has no line to open in an editor"; requestFrame() }
    else return undefined
    return true
  }

  /** Where the pointer is in the viewer, or undefined when it is not over it. */
  function local(fv: FileViewerState, x: number, y: number): { col: number; row: number } | undefined {
    const size = input.screen.size
    if (state.page === "file") return { col: x - 1, row: y - 1 }
    if (state.page !== "chat" || !fileInSlot(state)) return undefined
    const cells = slotCells(state, size.width)
    const left = size.width - cells
    return cells > 0 && x - 1 >= left ? { col: x - 1 - left, row: y - 1 } : undefined
  }

  function onMouse(fv: FileViewerState, button: number, x: number, y: number, down: boolean): boolean {
    const showingPanel = state.page === "chat" && fv.showing === "panel" && panelWanted(state)
    if (showingPanel) {
      // The panel owns the slot; only its first row (the file's tab) is ours.
      const size = input.screen.size
      const cells = slotCells(state, size.width)
      if (down && button === 0 && y === 1 && cells > 0 && x - 1 >= size.width - cells) { switchSlot(fv); return true }
      return false
    }
    const at = local(fv, x, y)
    // A click on the file gives it the keyboard (its keys, `o` among them, then act); a click anywhere else gives the keyboard back.
    // The frame is asked for after the click's own target was looked up: drawing first would replace the hits it is looked up in.
    const refocused = button === 0 && down && state.page === "chat" && fv.focused !== !!at
    if (refocused) fv.focused = !!at
    if (refocused && !at) requestFrame()
    if (!at && !fv.drag) return false
    const wheel = button === 64 || button === 65
    if (wheel && at) {
      const rows = state.tuiProfile.wheelLines
      goto(fv, fv.top + (button === 65 ? rows : -rows))
      return true
    }
    if (button === 0 && down && at) {
      const hit = fv.drawn?.hits.find((entry) => entry.row === at.row && at.col >= entry.from && at.col < entry.to && entry.action !== "line")
      if (hit) { onAction(fv, hit); return true }
      const line = fv.drawn?.hits.find((entry) => entry.row === at.row && entry.action === "line")?.arg
      if (typeof line === "number") {
        const range = selectedRange(fv)
        fv.drag = { anchor: line, moved: false, wasSelected: !!range && range.from === line && range.to === line }
        fv.selection = { from: line, to: line }
      }
      if (refocused || typeof line === "number") requestFrame()
      return true
    }
    if (button === 32 && fv.drag) {
      const line = fv.drawn?.hits.find((entry) => entry.row === Math.max(0, Math.min(fv.drawn!.height - 1, (at ?? { row: 0 }).row)) && entry.action === "line")?.arg
      if (typeof line === "number" && line !== fv.selection?.to) {
        fv.drag.moved = true
        fv.selection = { from: fv.drag.anchor, to: line }
        requestFrame()
      }
      return true
    }
    if (!down && fv.drag) {
      if (!fv.drag.moved && fv.drag.wasSelected) delete fv.selection
      fv.drag = undefined
      requestFrame()
      return true
    }
    return !!at
  }

  async function key(raw: string): Promise<boolean> {
    const fv = current()
    if (!fv) return false
    if (state.page !== "chat" && state.page !== "file") return false
    const mouse = MOUSE.exec(raw)
    if (mouse) return onMouse(fv, Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] === "M")
    if (raw === "\x1b{") { switchSlot(fv); return true }
    const inPage = state.page === "file"
    if (!inPage && !fileInSlot(state)) return false
    if (raw === "\x1b}") {
      fv.focused = !fv.focused
      requestFrame()
      return true
    }
    if (!fv.focused && !inPage) return false
    return typed(fv, raw)
  }

  function typed(fv: FileViewerState, raw: string): boolean {
    const text = fv.kind === "text"
    const page = room(fv) - 1
    if (fv.search.typing || fv.goto !== undefined) {
      const entering = fv.goto !== undefined
      if (raw === "\x1b") { fv.search.typing = false; delete fv.goto }
      else if (raw === "\r") {
        if (entering) { const line = Number(fv.goto); delete fv.goto; if (line > 0) goto(fv, line, true) }
        else void runSearch(fv, fv.search.query, true)
      } else if (raw === "\x7f") {
        if (entering) fv.goto = fv.goto!.slice(0, -1)
        else fv.search.query = fv.search.query.slice(0, -1)
      } else if (entering && /^\d$/.test(raw)) fv.goto += raw
      else if (!entering && raw.length === 1 && raw >= " " && fv.search.query.length < 200) fv.search.query += raw
      requestFrame()
      return true
    }
    if (fv.kind === "directory") {
      const handled = folderKey(fv, raw)
      if (handled !== undefined) return handled
    } else if (raw === "\x7f" && fv.origin !== undefined) {
      // A file opened from a listing: backspace goes back to it, on the entry just left.
      void enter(fv, fv.origin, { cursorName: path.basename(fv.path) })
      return true
    }
    if (raw === "\x1b" || raw === "q") close()
    else if (raw === "j" || raw === "\x1b[B") goto(fv, fv.top + 1)
    else if (raw === "k" || raw === "\x1b[A") goto(fv, fv.top - 1)
    else if (raw === " " || raw === "\x1b[6~" || raw === "\x04") goto(fv, fv.top + (raw === "\x04" ? Math.floor(page / 2) : page))
    else if (raw === "b" || raw === "\x1b[5~" || raw === "\x15") goto(fv, fv.top - (raw === "\x15" ? Math.floor(page / 2) : page))
    else if (raw === "g" || raw === "\x1b[H" || raw === "\x1b[1~") goto(fv, 1)
    else if (raw === "G" || raw === "\x1b[F" || raw === "\x1b[4~") goto(fv, Math.max(1, fv.lines - room(fv) + 1))
    else if ((raw === "h" || raw === "\x1b[D") && !fv.wrap) { fv.left = Math.max(0, fv.left - 8); requestFrame() }
    else if ((raw === "l" || raw === "\x1b[C") && !fv.wrap) { fv.left += 8; requestFrame() }
    else if (raw === "/" && text) { fv.search = { ...fv.search, typing: true, query: "" }; requestFrame() }
    else if (raw === ":" && text) { fv.goto = ""; requestFrame() }
    else if (raw === "n") step(fv, 1)
    else if (raw === "N") step(fv, -1)
    else if (raw === "r") void refresh(true)
    else if (raw === "o") void openExternal(fv)
    else if (raw === "a") ask(fv)
    else if (raw === "y") void copy(fv)
    else if (raw === "w") { fv.wrap = !fv.wrap; fv.left = 0; requestFrame() }
    else if (raw === "#") { fv.numbers = !fv.numbers; requestFrame() }
    else if (raw === "c") { delete fv.selection; requestFrame() }
    // Printable keys are the viewer's while it has the keyboard; control sequences (ctrl+c, the palette...) go on.
    return raw.length === 1 && raw >= " " || raw === "\x1b" || /^\x1b\[[0-9;]*[A-DHF~]$/.test(raw)
  }

  // The terminal window coming back to the front is the cheap moment to ask whether the file changed while it was away.
  input.screen.focus?.subscribe((focus) => { if (focus === "focused" && state.fileViewer) void refresh() })

  return { open, close, key, refresh, slotRows, tabRow, pageRows, syncPage, switchSlot, current }
}

export type FileViewerController = ReturnType<typeof createFileViewer>
