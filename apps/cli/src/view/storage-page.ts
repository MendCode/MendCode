import type { StorageReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { panelGrid, deck, deckChrome, type DeckStatus } from "./deck"
import { centerBlock, kpiRow, kvList, type PageTab } from "./page"
import { relativeTime, shortenMiddle, truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

export type StorageConfirm =
  | { kind: "clean"; days: number; sessions: number; bytes: number; goalFiles?: number }
  | { kind: "vacuum" }
  /** Old data moves to the compact forms and finished streaming deltas go: nothing is lost, the file shrinks. */
  | { kind: "compact"; rows: number; deltas: number }
  /** Merged, clean, unused worktrees (and old trash) the daemon created. */
  | { kind: "worktrees"; removed: number; bytes: number }

/** `tab` is 0 for Overview, 1 for Sessions and 2 for Blobs; unset means Overview. */
export type StoragePageState = { confirm?: StorageConfirm; note?: string; tab?: number }

export type StoragePageAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "refresh" }
  /** The app runs a dry run and answers with `storageConfirmClean` (or a note when nothing qualifies). */
  | { type: "previewClean" }
  | { type: "previewCompact" }
  | { type: "previewWorktrees" }
  | { type: "clean"; days: number }
  | { type: "vacuum" }
  | { type: "compact" }
  | { type: "worktrees" }

const HINT = "c clean · z compact · w worktrees · v vacuum · r refresh · tab/1-3 tabs · esc back"
const PAGE_TABS: PageTab[] = [{ key: "1", label: "Overview" }, { key: "2", label: "Sessions" }, { key: "3", label: "Blobs" }]
const BAR_CELLS = 10
const SIZE_COLUMN = 9
const TOP_ROWS = 10
/** The page body never grows wider than this; on wider terminals it is centered. */
const MAX_COLUMN = 112

export function createStoragePageState(): StoragePageState {
  return {}
}

export function storageConfirmClean(confirm: Exclude<StorageConfirm, { kind: "vacuum" }>): StoragePageState {
  return { confirm }
}

export function storageNote(state: StoragePageState, note: string): StoragePageState {
  return { ...state, note }
}

/** 512 B / 1.5 KB / 12.4 MB / 5.6 GB — base 1024, one decimal. */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1023.95 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

const thousands = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** `y` confirms a pending question; any other key cancels it. Tab and shift-tab cycle the tabs, 1 to 3 jump. */
export function storagePageKey(state: StoragePageState, key: string): { state: StoragePageState; action: StoragePageAction } {
  const tab = state.tab ?? 0
  const fresh: StoragePageState = tab ? { tab } : {}
  const confirm = state.confirm
  if (confirm) {
    if (key === "y") return { state: fresh, action: confirm.kind === "clean" ? { type: "clean", days: confirm.days } : confirm.kind === "vacuum" ? { type: "vacuum" } : { type: confirm.kind } }
    return { state: fresh, action: { type: "none" } }
  }
  const noAction: StoragePageAction = { type: "none" }
  /** Switching tabs also drops a note, like any other key. */
  const goTo = (next: number): { state: StoragePageState; action: StoragePageAction } =>
    next === tab && !state.note ? { state, action: noAction } : { state: next ? { tab: next } : {}, action: noAction }
  switch (key) {
    case "\t":
      return goTo((tab + 1) % PAGE_TABS.length)
    case "\x1b[Z":
      return goTo((tab + PAGE_TABS.length - 1) % PAGE_TABS.length)
    case "1":
    case "2":
    case "3":
      return goTo(Number(key) - 1)
    case "\x1b":
    case "q":
      return { state, action: { type: "close" } }
    case "r":
      return { state: fresh, action: { type: "refresh" } }
    case "c":
      return { state: fresh, action: { type: "previewClean" } }
    case "z":
      return { state: fresh, action: { type: "previewCompact" } }
    case "w":
      return { state: fresh, action: { type: "previewWorktrees" } }
    case "v":
      return { state: { ...fresh, confirm: { kind: "vacuum" } }, action: { type: "none" } }
  }
  return { state: state.note ? fresh : state, action: { type: "none" } }
}

const label = (text: string, dim = false): Span => ({ text, fg: "muted", ...(dim ? { dim: true } : {}) })
const value = (text: string): Span => ({ text, fg: "text", bold: true })

function pad(text: string, width: number) {
  const fitted = truncateEnd(text, width)
  return fitted + " ".repeat(Math.max(0, width - textWidth(fitted)))
}

function bar(part: number, total: number, color: ColorName): Span[] {
  const filled = total <= 0 || part <= 0 ? 0 : Math.min(BAR_CELLS, Math.max(1, Math.round((part / total) * BAR_CELLS)))
  return [{ text: "█".repeat(filled), fg: color }, { text: "░".repeat(BAR_CELLS - filled), fg: "border" }]
}

/** Where the disk goes: the database and its parts, the write-ahead log and the blob files, each with its share as a bar. */
function breakdown(report: StorageReport, width: number): Line[] {
  const total = Math.max(1, report.dbBytes + report.walBytes + report.blobBytes + (report.goalBytes ?? 0))
  const nameWidth = Math.max(8, width - SIZE_COLUMN - BAR_CELLS - 2)
  const row = (name: string, bytes: number, color: ColorName, options: { indent?: boolean; muted?: boolean } = {}): Line => [
    { text: pad(`${options.indent ? "  " : ""}${name}`, nameWidth), fg: options.muted ? "muted" : "body" },
    value(formatBytes(bytes).padStart(SIZE_COLUMN)),
    { text: " " },
    ...bar(bytes, total, color),
  ]
  return [
    row("database", report.dbBytes, "heading"),
    row("events", report.eventBytes, "code", { indent: true, muted: true }),
    row("engine history", report.engineBytes, "code", { indent: true, muted: true }),
    row(report.freeBytes > 0 ? `other · ${formatBytes(report.freeBytes)} free` : "other", report.otherBytes, "code", { indent: true, muted: true }),
    row("wal", report.walBytes, "heading"),
    row(`blobs (${thousands(report.blobs)} files)`, report.blobBytes, "link"),
    ...((report.goalFiles ?? 0) > 0 ? [row(`goal objectives (${thousands(report.goalFiles!)} files)`, report.goalBytes ?? 0, "link"),
      row(`orphan objectives (${thousands(report.orphanGoalFiles ?? 0)})`, report.orphanGoalBytes ?? 0, "warning", { indent: true, muted: true })] : []),
  ]
}

function settingRows(report: StorageReport, retentionDays: number | undefined, width: number, worktreeGcDays?: number): Line[] {
  return kvList(
    [
      { label: "auto-vacuum", value: report.autoVacuum === "none" ? "none · file never shrinks without a full vacuum" : report.autoVacuum },
      retentionDays
        ? { label: "auto-clean", value: `sessions idle > ${retentionDays} days, daily 03:30` }
        : { label: "auto-clean", value: "off · set retentionDays (≥ 7) in settings to enable" },
      ...(report.compressedRows === undefined
        ? []
        : [{ label: "compression", value: report.compressedRows > 0 ? `${thousands(report.compressedRows)} rows packed · saves ${formatBytes(report.savedBytes ?? 0)} · z moves older data` : "nothing packed yet · z moves older data" }]),
      ...(report.forkRefs
        ? [{ label: "forks", value: `${thousands(report.forkRefs)} share ${thousands(report.sharedMessages ?? 0)} messages of their parent · ${formatBytes(report.sharedBytes ?? 0)} stored once` }]
        : []),
      { label: "worktrees", value: worktreeGcDays ? `merged, clean, unused ones idle > ${worktreeGcDays} days go daily 03:30 · w now` : `off · set worktreeGcDays in settings to enable · w now${report.trashBytes ? ` · trash ${formatBytes(report.trashBytes)}` : ""}` },
    ],
    width,
  )
}

function sessionRows(report: StorageReport, width: number, now: number): Line[] {
  if (report.topSessions.length === 0) return [[label("no sessions")]]
  const timeWidth = 4
  const titleWidth = Math.max(8, width - SIZE_COLUMN - timeWidth - 4)
  const head: Line = [label("size".padStart(SIZE_COLUMN)), label("age".padStart(timeWidth + 1)), label("  session")]
  const rows = report.topSessions.slice(0, TOP_ROWS).map((session): Line => {
    const title = session.title.trim() || "untitled"
    const room = titleWidth - textWidth(title) - 3
    const where = room >= 8 ? ` ${shortenMiddle(`(${session.directory})`, room)}` : ""
    return [
      value(formatBytes(session.bytes).padStart(SIZE_COLUMN)),
      label(relativeTime(now, session.updatedAt).padStart(timeWidth + 1)),
      { text: `  ${truncateEnd(title, titleWidth)}`, fg: "body" },
      ...(where ? [label(where, true)] : []),
    ]
  })
  return [head, ...rows]
}

function blobRows(report: StorageReport, width: number): Line[] {
  return kpiRow(
    [
      { value: thousands(report.blobs), label: "files" },
      { value: formatBytes(report.blobBytes), label: "size" },
      { value: thousands(report.orphanBlobs), label: "orphaned", ...(report.orphanBlobs > 0 ? { tone: "warning" as const } : {}) },
      { value: formatBytes(report.orphanBytes), label: "reclaimable", ...(report.orphanBlobs > 0 ? { tone: "warning" as const } : {}) },
    ],
    width,
  )
}

function confirmLine(confirm: StorageConfirm, report: StorageReport | undefined): Line {
  if (confirm.kind === "clean") return [{ text: `remove ${confirm.sessions} sessions older than ${confirm.days} days${confirm.goalFiles ? ` + ${confirm.goalFiles} goal files` : ""} (≈${formatBytes(confirm.bytes)})? y/n`, fg: "warning", bold: true }]
  if (confirm.kind === "compact") return [{ text: `pack old data${confirm.deltas ? ` and drop ${thousands(confirm.deltas)} finished streaming deltas` : ""} (${thousands(confirm.rows)} rows)? nothing is lost. y/n`, fg: "warning", bold: true }]
  if (confirm.kind === "worktrees") return [{ text: `remove ${thousands(confirm.removed)} merged, clean, unused worktrees or trash entries (≈${formatBytes(confirm.bytes)})? y/n`, fg: "warning", bold: true }]
  const size = report ? formatBytes(report.dbBytes) : "the"
  return [{ text: `full vacuum rewrites the ${size} database and needs that much free disk. y/n`, fg: "warning", bold: true }]
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderStoragePage(input: {
  report: StorageReport | undefined
  error?: string
  state: StoragePageState
  retentionDays?: number
  worktreeGcDays?: number
  width: number
  height: number
  now: number
  glyphs?: Glyphs
}): Line[] {
  const { report, state, width, retentionDays, worktreeGcDays, now } = input
  const height = Math.max(0, input.height)
  void (input.glyphs ?? defaultGlyphs())

  const status: DeckStatus | undefined = state.confirm ? { label: "Confirm", tone: "warn" } : !report && input.error ? { label: "Error", tone: "error" } : undefined
  const subtitle = report ? `${formatBytes(report.dbBytes + report.walBytes + report.blobBytes + (report.goalBytes ?? 0))} on disk` : ""
  const summary = report ? `${thousands(report.sessions)} sessions · ${thousands(report.events)} events` : ""

  const inner = Math.max(1, width - 2)
  const column = Math.min(inner, MAX_COLUMN)
  const tab = Math.max(0, Math.min(state.tab ?? 0, PAGE_TABS.length - 1))
  const room = Math.max(0, height - deckChrome(HINT, width, { tabs: report !== undefined }))

  const promptRows: Line[] = state.confirm ? [confirmLine(state.confirm, report)] : state.note ? [[label(state.note)]] : []
  const promptRoom = promptRows.length ? promptRows.length + 1 : 0
  const contentRoom = Math.max(0, room - promptRoom)

  if (report && width >= 110 && contentRoom >= 14) {
    const disk = { title: "Disk usage", body: (w: number) => breakdown(report, w) }
    const sessions = { title: "Largest sessions", body: (w: number) => sessionRows(report, w, now) }
    const blobs = { title: "Blobs", body: (w: number) => blobRows(report, w) }
    const maintenance = { title: "Maintenance", body: (w: number) => settingRows(report, retentionDays, w, worktreeGcDays) }
    const panels = tab === 1 ? [[sessions, disk], [blobs, maintenance]] : tab === 2 ? [[blobs, disk], [sessions, maintenance]] : [[disk, sessions], [blobs, maintenance]]
    const body = [...panelGrid({ width: inner, rows: panels, heights: [Math.max(10, contentRoom - 9), 8] }), ...promptRows]
    return deck({ page: "Storage", ...(status ? { status } : {}), subtitle, summary, tabs: PAGE_TABS, activeTab: tab, body, hints: HINT, width, height })
  }

  const content: Line[] = !report
    ? [[input.error ? { text: input.error, fg: "warning" } : label("measuring storage…")]]
    : tab === 1
      ? sessionRows(report, column, now)
      : tab === 2
        ? blobRows(report, column)
        : [...breakdown(report, column), [], ...settingRows(report, retentionDays, column, worktreeGcDays)]
  const rows = content.slice(0, contentRoom)
  while (rows.length < contentRoom) rows.push([])
  const body = centerBlock([...rows, ...(promptRows.length ? [[], ...promptRows] : [])].slice(0, room), column, inner)

  return deck({ page: "Storage", ...(status ? { status } : {}), subtitle, summary, ...(report ? { tabs: PAGE_TABS, activeTab: tab } : {}), body, hints: HINT, width, height })
}
