import type { RenderNode } from "@mendcode/protocol"
import type { Block } from "./transcript"
import type { OrbitGraph, OrbitNode, OrbitTouch } from "./panel-orbit"

export type PanelFile = { path: string; at: number; activity: number; tools: Set<string> }
const fileTool = /^(read|edit|write|apply_patch|notebook_edit)(?:[:\s]|$)/
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "")

/** The galaxy's bounds: it never draws more, and nothing it computes grows with the session's length past these. */
export const SESSION_GRAPH = { nodes: 96, edges: 256, touches: 256, symbolsPerMap: 24 } as const

type CodemapEntry = { label: string; file?: string | undefined; line?: number | undefined; depth?: number | undefined; via?: string | undefined }
type Codemap = { center: CodemapEntry & { kind?: string | undefined }; left: { entries: readonly CodemapEntry[] }; right: { entries: readonly CodemapEntry[] } }

/** The call map a graph tool declared (`graph_find`, `graph_callers`), at the top of its render or one level into a stack. */
function codemapOf(render: RenderNode | undefined): Codemap | undefined {
  if (!render) return undefined
  if (render.type === "codemap") return render as unknown as Codemap
  if (render.type === "stack") for (const child of render.children) if (child.type === "codemap") return child as unknown as Codemap
  return undefined
}

/**
 * The session's code graph, from what its tools declared: the files it read or changed, the symbols a graph lookup returned and the
 * links between them (a symbol to its file, a caller to the symbol it calls). Every link and every node keeps the time it was last
 * used, which the galaxy turns into a spark that fades. Only declared metadata counts: shell text and tool output are never parsed.
 */
export function panelSession(blocks: readonly Block[], directory: string, tracked: ReadonlyArray<{ path: string; touchedAt?: number | undefined }> = []): { files: PanelFile[]; graph: OrbitGraph; savings: Map<string, number> } {
  const files = new Map<string, PanelFile>()
  const savings = new Map<string, number>()
  const nodes = new Map<string, OrbitNode>()
  const edges = new Map<string, { from: string; to: string; at: number; tool: string }>()
  const local = (raw: string) => {
    const path = clean(raw)
    return path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : path
  }
  const touchNode = (node: Omit<OrbitNode, "activity" | "at">, at: number) => {
    const known = nodes.get(node.id)
    if (known) {
      known.activity++
      known.at = Math.max(known.at ?? 0, at)
      return known.id
    }
    nodes.set(node.id, { ...node, activity: 1, ...(at ? { at } : {}) })
    return node.id
  }
  const fileNode = (path: string, at: number) => touchNode({ id: `file:${path}`, kind: "file", label: path, target: path }, at)
  /** A link between two nodes; one from a node to itself is a touch with nothing to draw (a file read on its own). */
  const link = (from: string, to: string, at: number, tool: string) => {
    const key = `${from}|${to}`
    if (at >= (edges.get(key)?.at ?? -1)) edges.set(key, { from, to, at, tool })
  }
  /** A symbol hangs off its file: its node sits next to the file's on the galaxy and the two are linked. */
  const symbolNode = (entry: CodemapEntry, at: number, tool: string) => {
    const label = clean(entry.label)
    const path = entry.file ? local(entry.file) : undefined
    const parent = path ? fileNode(path, at) : undefined
    const id = touchNode({ id: `sym:${path ?? ""}#${label}`, kind: "symbol", label, target: path ?? label, ...(parent ? { parent } : {}), ...(entry.line ? { line: entry.line } : {}) }, at)
    if (parent) link(parent, id, at, tool)
    return id
  }
  for (const block of blocks) {
    if (block.kind !== "tool_call") continue
    const tool = clean(block.title?.split(/[:\s]/)[0] ?? "tool")
    const at = block.endAt ?? block.at ?? 0
    if (typeof block.meta?.savedTokens === "number" && block.meta.savedTokens > 0) {
      const source = typeof block.meta.filter === "string" ? clean(block.meta.filter) : "graph"
      savings.set(source, (savings.get(source) ?? 0) + block.meta.savedTokens)
    }
    const map = codemapOf(block.render)
    if (map) {
      // A search has no symbol at its centre; a call lookup links each caller to the centre and the centre to each callee, a deeper hop to the entry it came through.
      const search = map.center.kind === "search"
      const centre = search ? undefined : symbolNode(map.center, at, tool)
      for (const [side, entries] of [["in", map.left.entries], ["out", map.right.entries]] as const) {
        const named = new Map<string, string>()
        for (const entry of entries.slice(0, SESSION_GRAPH.symbolsPerMap)) {
          const id = symbolNode(entry, at, tool)
          const depth = entry.depth ?? 1
          named.set(clean(entry.label), id)
          const via = depth > 1 && entry.via ? named.get(clean(entry.via)) : centre
          if (via) side === "in" ? link(id, via, at, tool) : link(via, id, at, tool)
        }
      }
      continue
    }
    if (!fileTool.test(block.title ?? "") || typeof block.meta?.path !== "string") continue
    const path = local(block.meta.path)
    const entry = files.get(path) ?? { path, at: 0, activity: 0, tools: new Set<string>() }
    entry.at = Math.max(entry.at, at)
    entry.activity++
    entry.tools.add(tool)
    files.set(path, entry)
    fileNode(path, at)
    // A file read on its own has no link to light: its node fires, and the recent list names the tool.
    link(`file:${path}`, `file:${path}`, at, tool)
  }
  for (const file of tracked) {
    const path = clean(file.path)
    const entry = files.get(path)
    if (entry) entry.at = Math.max(entry.at, file.touchedAt ?? 0)
    else files.set(path, { path, at: file.touchedAt ?? 0, activity: 1, tools: new Set() })
    if (!nodes.has(`file:${path}`)) fileNode(path, file.touchedAt ?? 0)
  }
  const recent = [...files.values()].sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
  // The newest nodes win the bounded slots; a kept symbol keeps its file when there is room, so it never floats alone.
  const byRecency = [...nodes.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id))
  const kept = new Set<string>()
  for (const node of byRecency) {
    if (kept.size >= SESSION_GRAPH.nodes) break
    if (node.parent && !kept.has(node.parent) && kept.size + 2 > SESSION_GRAPH.nodes) continue
    kept.add(node.id)
    if (node.parent) kept.add(node.parent)
  }
  const shown = byRecency.filter((node) => kept.has(node.id))
  const all = [...edges.values()].sort((a, b) => b.at - a.at)
  const drawn = all.filter((edge) => edge.from !== edge.to && kept.has(edge.from) && kept.has(edge.to)).slice(0, SESSION_GRAPH.edges)
  const touches: OrbitTouch[] = all.filter((edge) => kept.has(edge.from) && kept.has(edge.to)).slice(0, SESSION_GRAPH.touches).map(({ from, to, at, tool }) => ({ from, to, at, tool }))
  const last = touches.reduce((latest, touch) => Math.max(latest, touch.at), 0)
  return { files: recent, graph: { nodes: shown, edges: drawn.map((edge): [string, string] => [edge.from, edge.to]), touches, omitted: nodes.size - shown.length, ...(last ? { at: last } : {}) }, savings }
}
