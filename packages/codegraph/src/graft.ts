import { stat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { SYMBOL_KINDS, type CallRec, type SymbolKind, type SymbolRec } from "./types"

/** Where Graft keeps its prebuilt graph, relative to the project root. */
export const GRAFT_WIRING = "graft/.graph/wiring.json"

export type GraftFile = { imports: string[]; symbols: SymbolRec[]; calls: CallRec[] }
export type Wiring = { mtimeMs: number; files: Map<string, GraftFile> }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

function parseSpan(span: unknown): { start: number; end: number } {
  const match = typeof span === "string" ? /^L?(\d+)(?:-L?(\d+))?$/.exec(span.trim()) : null
  if (!match) return { start: 0, end: 0 }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : start
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end > 10_000_000) return { start: 0, end: 0 }
  return { start, end }
}

export async function wiringStamp(cwd: string): Promise<{ mtimeMs: number; key: string } | undefined> {
  const info = await stat(join(cwd, GRAFT_WIRING)).catch(() => undefined)
  return info?.isFile() ? { mtimeMs: info.mtimeMs, key: `${info.mtimeMs}:${info.ctimeMs}:${info.size}` } : undefined
}

/**
 * Graft's wiring.json: `nodes [{id,name,kind,path,span?,exported?}]`, `edges [{source,target,relation}]`.
 * File nodes give the covered paths and (through `imports` edges) their imports; every other node is a
 * symbol; `calls` edges between symbols become call records with a known target.
 */
export async function readWiring(cwd: string): Promise<Wiring | undefined> {
  const stamp = await wiringStamp(cwd)
  if (!stamp) return undefined
  const { mtimeMs } = stamp
  let data: unknown
  try {
    data = JSON.parse(await readFile(join(cwd, GRAFT_WIRING), "utf8"))
  } catch {
    return undefined
  }
  if (!isObject(data) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) return undefined
  const files = new Map<string, GraftFile>()
  const nodeNames = new Map<string, string>()
  const symbolsByPath = new Map<string, Array<{ id: string; rec: SymbolRec }>>()
  for (const node of data.nodes) {
    if (!isObject(node)) continue
    const id = text(node.id)
    const path = text(node.path)
    const name = text(node.name)
    if (!id || !path || !name) continue
    nodeNames.set(id, name)
    if (node.kind === "file") {
      if (!files.has(path)) files.set(path, { imports: [], symbols: [], calls: [] })
      continue
    }
    const kind: SymbolKind = typeof node.kind === "string" && SYMBOL_KINDS.has(node.kind) ? (node.kind as SymbolKind) : "variable"
    const hash = id.indexOf("#")
    const qualified = hash >= 0 ? id.slice(hash + 1) : name
    const dot = qualified.lastIndexOf(".")
    const span = parseSpan(node.span)
    const rec: SymbolRec = { name, kind, start: span.start, end: span.end, exported: node.exported === true, id }
    if (dot > 0) rec.parent = qualified.slice(0, dot)
    const list = symbolsByPath.get(path) ?? []
    list.push({ id, rec })
    symbolsByPath.set(path, list)
  }
  const located = new Map<string, { path: string; index: number }>()
  for (const [path, list] of symbolsByPath) {
    list.sort((a, b) => a.rec.start - b.rec.start || a.rec.name.localeCompare(b.rec.name))
    const file = files.get(path) ?? { imports: [], symbols: [], calls: [] }
    files.set(path, file)
    list.forEach((entry, index) => {
      file.symbols.push(entry.rec)
      located.set(entry.id, { path, index })
    })
  }
  for (const edge of data.edges) {
    if (!isObject(edge)) continue
    const source = text(edge.source)
    const target = text(edge.target)
    if (!source || !target) continue
    if (edge.relation === "imports") files.get(source)?.imports.push(target)
    else if (edge.relation === "calls") {
      const from = located.get(source)
      if (!from) continue
      const hash = target.indexOf("#")
      const name = nodeNames.get(target) ?? (hash >= 0 ? target.slice(hash + 1).split(".").pop() : undefined)
      if (name) files.get(from.path)?.calls.push({ from: from.index, name, target })
    }
  }
  return { mtimeMs, files }
}
