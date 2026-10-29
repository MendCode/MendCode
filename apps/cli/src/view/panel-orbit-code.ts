import type { CodegraphOverview, CodegraphOverviewFile } from "@mendcode/protocol"
import { CODEGRAPH_OVERVIEW } from "@mendcode/protocol/wire"
import type { ColorName, Line } from "../ui/theme"
import { uniquePaths } from "./code-map"
import { fit } from "./deck"
import { meter } from "./panel-card"
import type { OrbitCamera, OrbitGraph, OrbitNode, OrbitView } from "./panel-orbit"
import { shortenMiddle, textWidth, truncateEnd } from "./wrap"

/**
 * The Galaxy panel's code mode (docs/sidebar.md): the project's most connected files on the same galaxy, from one `codegraph.overview`
 * reply. Nothing here reads a file or asks the daemon; the panel asks only when the user presses the mode key. Pure and bounded by
 * `CODEGRAPH_OVERVIEW` whatever the reply holds.
 */

export type CodeOverviewReady = Extract<CodegraphOverview, { state: "ready" }>
/** What the panel knows about the code graph of the session's directory: nothing asked yet, the first build running, or the daemon's answer. */
export type OrbitCode = { state: "idle" } | { state: "building" } | CodegraphOverview

/** Rows each lower card may take at most in code mode; the caller trims further to the height it has. */
export const ORBIT_CODE_ROWS = { focus: 12, top: 8 } as const

const COPY = {
  building: "Building code graph",
  off: "Code graph is off here",
  failed: "Code graph failed",
  empty: "No connected source files",
  noImports: "No resolved imports",
  noSelection: "No file selected · tab",
} as const

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)
const pathOf = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= CODEGRAPH_OVERVIEW.path ? clean(value) : undefined)
const paths = (value: unknown) => (Array.isArray(value) ? value.slice(0, CODEGRAPH_OVERVIEW.neighbours).flatMap((entry) => pathOf(entry) ?? []) : [])
const reasonOf = (value: unknown) => (typeof value === "string" ? clean(value).slice(0, CODEGRAPH_OVERVIEW.reason) : "")

/** A reply as the panel may draw it: every count, list and string re-bounded here, so an old or foreign daemon cannot grow a frame. */
export function codeOverviewOf(result: unknown): CodegraphOverview {
  const reply = (result ?? {}) as Record<string, unknown>
  if (reply.state === "off" || reply.state === "failed") return { state: reply.state, reason: reasonOf(reply.reason) }
  if (reply.state !== "ready" || !Array.isArray(reply.files)) return { state: "failed", reason: "the daemon sent no overview" }
  const listed = reply.files.slice(0, CODEGRAPH_OVERVIEW.files)
  const files = listed.flatMap((entry): CodegraphOverviewFile[] => {
    const file = (entry ?? {}) as Record<string, unknown>
    const path = pathOf(file.path)
    return path === undefined ? [] : [{ path, imports: count(file.imports), importedBy: count(file.importedBy), calls: count(file.calls), degree: count(file.degree), symbols: count(file.symbols), topImports: paths(file.topImports), topImportedBy: paths(file.topImportedBy) }]
  })
  const index = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) < files.length ? value as number : undefined)
  // Indexes only hold while no file was dropped above; a reply this panel had to repair keeps its files and draws no edges.
  const edges = files.length === listed.length && Array.isArray(reply.edges) ? reply.edges.slice(0, CODEGRAPH_OVERVIEW.edges).flatMap((edge): Array<[number, number]> => {
    const [from, to] = Array.isArray(edge) ? [index(edge[0]), index(edge[1])] : []
    return from === undefined || to === undefined ? [] : [[from, to]]
  }) : []
  const total = (reply.total ?? {}) as Record<string, unknown>
  return { state: "ready", files, edges, total: { files: Math.max(files.length, count(total.files)), symbols: count(total.symbols) }, omittedEdges: count(reply.omittedEdges), partial: reply.partial === true, builtAt: count(reply.builtAt) }
}

const nodeId = (path: string) => `code:${path}`

/** The overview as the galaxy's graph: one `file` vertex per file, in rank order (so Tab walks from the most connected), and the links among them. */
export function codeOrbitGraph(report: CodeOverviewReady): OrbitGraph {
  const short = uniquePaths(report.files.map((file) => file.path))
  const nodes = report.files.map((file): OrbitNode => ({ id: nodeId(file.path), kind: "file", label: file.path, target: file.path, activity: file.degree, short: short.get(file.path) ?? file.path }))
  const edges = report.edges.map(([from, to]): [string, string] => [nodes[from]!.id, nodes[to]!.id])
  return { nodes, edges, omitted: Math.max(0, report.total.files - nodes.length) }
}

/** How `renderOrbit` draws the state: the graph when there is one, else one muted line (`Building code graph`, `Code graph is off here · …`, `Code graph failed · …`). */
export function codeOrbitView(code: OrbitCode, width: number): OrbitView {
  const withReason = (lead: string, reason: string) => (reason ? `${lead} · ${reason}` : lead)
  const fits = (line: string) => textWidth(line) <= width
  if (code.state === "ready") return code.files.length ? { mode: "code", links: code.edges.length + code.omittedEdges } : { mode: "code", note: COPY.empty }
  // Off says why when the row holds it; a failure always keeps as much of its reason as fits.
  if (code.state === "off") return { mode: "code", note: fits(withReason(COPY.off, code.reason)) ? withReason(COPY.off, code.reason) : COPY.off }
  if (code.state === "failed") return { mode: "code", note: fits(withReason(COPY.failed, code.reason)) ? withReason(COPY.failed, code.reason) : textWidth(COPY.failed) + 4 <= width ? truncateEnd(withReason(COPY.failed, code.reason), width) : COPY.failed }
  return { mode: "code", note: COPY.building }
}

/** The card's live value: `24 of 812 files`, or nothing while there is no graph. */
export const codeOrbitValue = (code: OrbitCode) => (code.state !== "ready" || !code.files.length ? "" : code.total.files > code.files.length ? `${code.files.length} of ${code.total.files} files` : `${code.files.length} file${code.files.length === 1 ? "" : "s"}`)

export type OrbitCodeRows = { focus: Line[]; top: Line[] }

/**
 * The cards under the galaxy in code mode: the selected file with the files it imports and the files that import it (most connected
 * first), and the files ranked by connections. Rows are exactly `width` cells.
 */
export function codeOrbitDetails({ report, camera, width, ascii = false, rows = ORBIT_CODE_ROWS }: { report: CodeOverviewReady; camera: OrbitCamera; width: number; ascii?: boolean; rows?: { focus: number; top: number } }): OrbitCodeRows {
  const glyph = ascii ? "F" : "▣"
  const color: ColorName = "success"
  const text = (value: string, fg: ColorName = "text", extra: { bold?: boolean } = {}): Line => fit([{ text: value, fg, ...extra }], width)
  const plural = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`
  const file = report.files[camera.selected]

  const focus: Line[] = []
  if (!file) focus.push(text(COPY.noSelection, "muted"))
  else {
    focus.push(fit([{ text: `${glyph} `, fg: color }, { text: shortenMiddle(file.path, Math.max(1, width - 2)), fg: "warning", bold: true }], width))
    // The counts shorten before they are cut: `41 imports · 3 imported by · 180 calls`, then `41 out · 3 in · 180 calls`.
    const counts = [`${plural(file.imports, "import")} · ${file.importedBy} imported by · ${plural(file.calls, "call")}`, `${file.imports} out · ${file.importedBy} in · ${plural(file.calls, "call")}`, `${file.imports} out · ${file.importedBy} in`]
    focus.push(text(counts.find((row) => textWidth(row) <= width) ?? counts.at(-1)!, "muted"))
    const lists = [{ caption: "imports", total: file.imports, paths: file.topImports }, { caption: "imported by", total: file.importedBy, paths: file.topImportedBy }].filter((list) => list.paths.length > 0)
    if (!lists.length) focus.push(text(COPY.noImports, "muted"))
    // Each list gets the same share of what is left under the two heading rows: its caption and its most connected files.
    const each = Math.max(1, Math.floor((rows.focus - 2) / Math.max(1, lists.length)) - 1)
    for (const list of lists) {
      const shown = list.paths.slice(0, each)
      focus.push(text(list.total > shown.length ? `${list.caption} · top ${shown.length} of ${list.total}` : list.caption, "muted"))
      for (const path of shown) focus.push(fit([{ text: `  ${glyph} `, fg: color }, { text: shortenMiddle(path, Math.max(1, width - 4)), fg: "text" }], width))
    }
  }

  const short = uniquePaths(report.files.map((entry) => entry.path))
  const ranked = report.files.slice(0, Math.max(1, rows.top))
  const peak = Math.max(1, ...ranked.map((entry) => entry.degree))
  // The session Top card's columns: one meter column for every row, counts right-aligned, the name takes what is left.
  const countCells = Math.max(1, ...ranked.map((entry) => String(entry.degree).length))
  const barCells = Math.min(10, Math.max(3, Math.floor(width / 5)))
  const markCells = 4
  const labelCells = Math.max(1, width - markCells - 1 - barCells - 1 - countCells)
  const top: Line[] = ranked.length ? ranked.map((entry) => {
    const selected = entry === file
    const left: Line = fit([{ text: `${selected ? ascii ? ">" : "▸" : " "} `, fg: "warning" }, { text: `${glyph} `, fg: color }, { text: truncateEnd(short.get(entry.path) ?? entry.path, labelCells), fg: selected ? "warning" : "text" }], markCells + labelCells)
    return fit([...left, { text: " " }, ...meter({ ratio: entry.degree / peak, cells: barCells, color, ascii }), { text: ` ${String(entry.degree).padStart(countCells)}`, fg: "muted" }], width)
  }) : [text(COPY.empty, "muted")]
  const plain = (lines: Line[]) => (ascii ? lines.map((line) => fit(line.map((span) => ({ ...span, text: span.text.replace(/·/g, "|").replace(/…/g, "~").replace(/[^\x20-\x7e]/g, "?") })), width)) : lines)
  return { focus: plain(focus.slice(0, Math.max(1, rows.focus))), top: plain(top) }
}
