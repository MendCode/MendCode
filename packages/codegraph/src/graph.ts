import { posix } from "node:path"
import type { FileRec, Language, SymbolKind, WorkspacePackage } from "./types"
import { workspaceTargets } from "./workspace"

export type GraphNode = {
  id: string
  name: string
  /** `Parent.name` for members, else `name`. */
  label: string
  kind: SymbolKind
  path: string
  /** 1-based lines; 0 when the source gave no span. */
  start: number
  end: number
  exported: boolean
  parent?: string | undefined
  language: Language
}

export type GraphFile = { path: string; language: Language; /** Bytes on disk when it was indexed. */ size: number; mtimeMs: number; ctimeMs: number; symbols: number; imports: string[] }

/** The derived, query-ready graph: nodes, name/path indexes and resolved call edges. */
export type Graph = {
  cwd: string
  partial: boolean
  builtAt: number
  nodes: GraphNode[]
  byId: Map<string, GraphNode>
  byName: Map<string, GraphNode[]>
  byPath: Map<string, GraphNode[]>
  callers: Map<string, string[]>
  callees: Map<string, string[]>
  files: Map<string, GraphFile>
  importers: Map<string, string[]>
}

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
const CALLABLE: ReadonlySet<SymbolKind> = new Set(["function", "class", "variable", "struct"])

function resolveImport({ from, spec, language, known, packages }: { from: string; spec: string; language: Language; known: ReadonlySet<string>; packages: readonly WorkspacePackage[] }): string | undefined {
  if (known.has(spec)) return spec
  const dir = posix.dirname(from)
  if (language === "typescript" || language === "javascript") {
    const bases = spec.startsWith(".") ? [posix.normalize(posix.join(dir, spec))] : workspaceTargets(spec, packages)
    for (const base of bases) {
      const stem = base.replace(/\.(m|c)?jsx?$/, "")
      const typed = base.endsWith(".mjs") ? `${stem}.mts` : base.endsWith(".cjs") ? `${stem}.cts` : `${stem}.ts`
      // The candidates in order of preference, built only until one is indexed.
      if (known.has(base)) return base
      if (known.has(typed)) return typed
      for (const ext of SCRIPT_EXTENSIONS) if (known.has(base + ext)) return base + ext
      for (const ext of SCRIPT_EXTENSIONS) if (known.has(`${base}/index${ext}`)) return `${base}/index${ext}`
      for (const ext of SCRIPT_EXTENSIONS) if (known.has(stem + ext)) return stem + ext
    }
    return undefined
  }
  if (language === "python") {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0
    const rest = spec.slice(dots).replaceAll(".", "/")
    let base = rest
    if (dots > 0) {
      let root = dir
      for (let i = 1; i < dots; i++) root = posix.dirname(root)
      base = rest === "" ? root : posix.join(root, rest)
    }
    return [`${base}.py`, `${base}/__init__.py`].find((candidate) => known.has(candidate))
  }
  return undefined
}

export function buildGraph({ cwd, files, partial, builtAt, packages = [] }: { cwd: string; files: Record<string, FileRec>; partial: boolean; builtAt: number; packages?: readonly WorkspacePackage[] }): Graph {
  const nodes: GraphNode[] = []
  const byId = new Map<string, GraphNode>()
  const byName = new Map<string, GraphNode[]>()
  const byPath = new Map<string, GraphNode[]>()
  const localIds = new Map<string, string[]>()
  const paths = Object.keys(files).sort()
  for (const path of paths) {
    const rec = files[path] as FileRec
    const ids: string[] = []
    const inFile: GraphNode[] = []
    rec.symbols.forEach((symbol) => {
      const base = symbol.id ?? `${path}#${symbol.parent ? `${symbol.parent}.` : ""}${symbol.name}`
      let id = base
      for (let suffix = 1; byId.has(id); suffix++) id = `${base}:${symbol.start}:${suffix}`
      const node: GraphNode = {
        id,
        name: symbol.name,
        label: symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name,
        kind: symbol.kind,
        path,
        start: symbol.start,
        end: symbol.end,
        exported: symbol.exported,
        parent: symbol.parent,
        language: rec.language,
      }
      ids.push(id)
      inFile.push(node)
      nodes.push(node)
      byId.set(id, node)
      const named = byName.get(symbol.name)
      if (named) named.push(node)
      else byName.set(symbol.name, [node])
    })
    localIds.set(path, ids)
    byPath.set(path, inFile)
  }
  const known: ReadonlySet<string> = new Set(paths)
  // Every call through an import binding resolves its file's specifier again, and each resolution builds candidate paths:
  // answered once per (file, specifier), a 2,872-file graph builds in about 90 ms instead of 125.
  const resolvedImports = new Map<string, string | undefined>()
  const targetFile = (from: string, spec: string) => {
    const key = `${from}\0${spec}`
    if (resolvedImports.has(key)) return resolvedImports.get(key)
    const target = resolveImport({ from, spec, language: files[from]!.language, known, packages })
    resolvedImports.set(key, target)
    return target
  }
  const graphFiles = new Map<string, GraphFile>()
  const importedFiles = new Map<string, Set<string>>()
  const importers = new Map<string, string[]>()
  for (const path of paths) {
    const rec = files[path] as FileRec
    const resolved = new Set<string>()
    for (const spec of rec.imports) {
      const target = targetFile(path, spec)
      if (target && target !== path) resolved.add(target)
    }
    importedFiles.set(path, resolved)
    for (const target of resolved) {
      const back = importers.get(target)
      if (back) back.push(path)
      else importers.set(target, [path])
    }
    graphFiles.set(path, { path, language: rec.language, size: rec.size, mtimeMs: rec.mtimeMs, ctimeMs: rec.ctimeMs, symbols: rec.symbols.length, imports: [...resolved].sort() })
  }
  const callers = new Map<string, string[]>()
  const callees = new Map<string, string[]>()
  const linked = new Set<string>()
  const link = (from: string, to: string) => {
    if (linked.has(`${from}\0${to}`)) return
    linked.add(`${from}\0${to}`)
    const out = callees.get(from)
    if (out) out.push(to)
    else callees.set(from, [to])
    const back = callers.get(to)
    if (back) back.push(from)
    else callers.set(to, [from])
  }
  const exported = (path: string, name: string, visiting = new Set<string>()): GraphNode[] => {
    const key = `${path}\0${name}`
    if (visiting.has(key) || visiting.size >= 64) return []
    visiting.add(key)
    const rec = files[path]!
    const found = new Map<string, GraphNode>()
    const add = (nodes: GraphNode[]) => { for (const node of nodes) found.set(node.id, node) }
    if (rec.exports === undefined) add((byPath.get(path) ?? []).filter((node) => (node.exported || rec.language === "python") && node.name === name && !node.parent))
    else {
      const explicit = rec.exports.filter((entry) => entry.exported === name)
      const entries = explicit.length > 0 ? explicit : name === "default" ? [] : rec.exports.filter((entry) => entry.exported === "*")
      for (const entry of entries) {
        if (entry.source) {
          const target = targetFile(path, entry.source)
          if (target) add(exported(target, entry.local === "*" ? name : entry.local, visiting))
        } else {
          const binding = rec.bindings?.find((item) => item.local === entry.local)
          if (binding) {
            const target = targetFile(path, binding.source)
            if (target) add(exported(target, binding.imported, visiting))
          } else add((byPath.get(path) ?? []).filter((node) => !node.parent && node.name === entry.local))
        }
      }
    }
    visiting.delete(key)
    const result = [...found.values()]
    // Conflicting star exports are ambiguous in ESM, not two valid targets.
    if (rec.exports && !rec.exports.some((entry) => entry.exported === name) && new Set(result.map((node) => node.path)).size > 1) return []
    return result
  }
  const exportCache = new Map<string, GraphNode[]>()
  const publicSymbols = (path: string, name: string) => {
    const key = `${path}\0${name}`
    let nodes = exportCache.get(key)
    if (!nodes) { nodes = exported(path, name); exportCache.set(key, nodes) }
    return nodes
  }
  for (const path of paths) {
    const rec = files[path] as FileRec
    const ids = localIds.get(path) as string[]
    const local = byPath.get(path) as GraphNode[]
    const imported = importedFiles.get(path) as Set<string>
    for (const call of rec.calls) {
      const fromId = ids[call.from]
      const caller = local[call.from]
      if (!fromId || !caller) continue
      if (call.target) {
        if (byId.has(call.target)) link(fromId, call.target)
        continue
      }
      if (call.self) {
        const sibling = caller.parent === undefined ? undefined : local.find((node) => node.kind === "method" && node.parent === caller.parent && node.name === call.name)
        if (sibling) link(fromId, sibling.id)
        continue
      }
      const binding = rec.bindings?.find((entry) => entry.local === (call.qualifier ?? call.name))
      if (binding) {
        const target = targetFile(path, binding.source)
        if (target) {
          if (binding.imported === "*" && call.qualifier) {
            for (const node of publicSymbols(target, call.name)) if (CALLABLE.has(node.kind)) link(fromId, node.id)
          } else if (binding.imported !== "*") {
            for (const node of publicSymbols(target, binding.imported)) {
              if (!call.qualifier && CALLABLE.has(node.kind)) link(fromId, node.id)
              else if (call.qualifier && node.kind === "class") {
                for (const method of byPath.get(node.path) ?? []) if (method.kind === "method" && method.parent === node.name && method.name === call.name) link(fromId, method.id)
              }
            }
          }
        }
        // An external/missing import must not fall through to an unrelated same-named symbol.
        continue
      }
      if (call.qualifier) {
        const owned = (byName.get(call.name) ?? []).filter((node) => node.language === rec.language && node.kind === "method" && node.parent === call.qualifier)
        const near = owned.filter((node) => node.path === path)
        const viaImport = rec.bindings === undefined ? owned.filter((node) => imported.has(node.path)) : []
        // A Swift module sees every type of its files without an import, so the named type's method is the target wherever it is declared.
        for (const node of near.length > 0 ? near : viaImport.length > 0 || rec.language !== "swift" ? viaImport : owned) link(fromId, node.id)
        if (owned.length > 0 || call.dot) continue
      }
      const candidates = (byName.get(call.name) ?? []).filter((node) => node.language === rec.language && CALLABLE.has(node.kind))
      const sameFile = candidates.filter((node) => node.path === path)
      const viaImport = candidates.filter((node) => imported.has(node.path) && node.exported)
      // Explicit bindings must not fall through to a coincidental global name.
      const fallback = rec.bindings !== undefined ? [] : candidates.length === 1 ? candidates : []
      const chosen = sameFile.length > 0 ? sameFile : rec.bindings !== undefined ? [] : viaImport.length > 0 ? viaImport : fallback
      for (const node of chosen) link(fromId, node.id)
    }
  }
  return { cwd, partial, builtAt, nodes, byId, byName, byPath, callers, callees, files: graphFiles, importers }
}
