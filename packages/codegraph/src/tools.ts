import { estimateTokens } from "@mendcode/protocol/wire"
import { existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { cancelled, defineTool, errorMessage, fail, succeed, truncateText, type Tool, type ToolContext, type ToolResult } from "@mendcode/tools"
import { z } from "zod"
import type { Graph, GraphNode } from "./graph"
import { holdsHome, type GraphGate, type GraphSkipReason } from "./index-gate"
import { createIndexer, type Indexer, type IndexStatus } from "./indexer"
import { JG_TIMEOUT_MS, literalSearch, parseJgOutput, runJg, type JgHit } from "./jg"
import { findSymbols, inDegree, loc, projectMap, projectRelative, resolveSymbol, traverseCalls, under } from "./query"
import { languageOf } from "./scan"
import { sourceExcerpts } from "./source"
import { MAX_RESULTS, SYMBOL_KINDS, type SymbolKind } from "./types"

export type CodeGraphOptions = {
  /** Directory for the per-project JSON caches (`<sha1(cwd) first 16 hex>.json`). */
  cacheDir: string
  /** The `jg` semantic-search binary; default: `jg` on PATH. */
  jgBin?: string | undefined
  /** Clock for cache timestamps. */
  now?: (() => number) | undefined
  /** Timeout of one `jg` run, default 60 s. */
  jgTimeoutMs?: number | undefined
  /** Called for every file the own scanner reads; lets tests count re-scans. */
  onScan?: ((path: string) => void) | undefined
  /** Indexed-file cap, default 20000; beyond it the graph is marked partial. */
  maxFiles?: number | undefined
  /** Index counts for a client's footer: called at the first build of a project and whenever a refresh changed it. */
  onIndex?: ((status: IndexStatus) => void) | undefined
  /** An indexer the caller also uses elsewhere (the daemon's `codegraph.overview`), so both share one graph per project; default: a new one from the options above. */
  indexer?: Indexer | undefined
  /** Whether a folder is indexed (`index-gate.ts`: the mode the settings give the project, git repository, size); default: every folder but the home folder and above. */
  gate?: ((cwd: string, signal: AbortSignal) => Promise<GraphGate>) | undefined
}

const GRAPH_EDGE_LIMIT = 24
const LABEL_LIMIT = 120
/** Direct neighbours drawn on the side of a call map the tool was not asked about. */
const OTHER_SIDE_ROWS = 12
/** Hubs the project map's table lists in the `full` view; the rest are in the opened card. */
const HUB_TABLE_ROWS = 6
/** Symbols the file API's table lists in the `full` view. */
const SYMBOL_TABLE_ROWS = 6
/** Distinct files of a `graph_find` result its saving counts: the ones a grep-and-read would have opened. */
const FIND_SAVING_FILES = 3
/** Rows of a list node in a render spec (the protocol's RENDER_LIMITS.rows). */
const RENDER_ROWS = 50

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const partialNote = (graph: Graph): string => (graph.partial ? `\n[partial: ${graph.files.size} files indexed; file cap, oversized or unreadable sources may omit results]` : "")
const callDepth = z.union([z.number().int().min(1).max(20), z.literal("all")]).optional()

type Edge = { from: string; to: string; relation?: string }

const withRender = (result: ToolResult, render: unknown): ToolResult => ({ ...result, render })

/**
 * Estimated tokens a lookup kept out of the context: reading every file it points at whole (bytes / 4) instead of the
 * result it returned (chars / 4). Never negative; undefined when nothing was saved or no listed file has a known size,
 * so a caller shows no figure rather than an invented one.
 */
export function lookupSavings({ graph, paths, output }: { graph: Graph; paths: Iterable<string>; output: string }): number | undefined {
  let bytes = 0
  for (const path of new Set(paths)) bytes += graph.files.get(path)?.size ?? 0
  const saved = estimateTokens(bytes) - estimateTokens(output.length)
  return saved > 0 ? saved : undefined
}

/** `meta` entries that feed the `/usage` savings tally (`savedTokens`, source `graph`), or nothing when the saving is unknown. */
const savingsMeta = (saved: number | undefined) => (saved === undefined ? {} : { savedTokens: saved, filter: "graph" })

/** One symbol of a codemap render: where it lives, how many hops from the centre and, past the first hop, the entry it was reached through. */
function mapEntry({ node, depth, via }: { node: GraphNode; depth?: number | undefined; via?: GraphNode | undefined }) {
  return { label: clip(node.label, LABEL_LIMIT), file: clip(node.path, 240), ...(node.start > 0 ? { line: node.start } : {}), kind: node.kind, ...(depth !== undefined ? { depth } : {}), ...(via !== undefined && depth !== undefined && depth > 1 ? { via: clip(via.label, LABEL_LIMIT) } : {}) }
}

const row = (node: GraphNode): string => clip(`${loc(node)}  ${node.kind} ${node.label}${node.exported ? " (export)" : ""}`, 300)

export { holdsHome }

/** What a refused lookup tells the model, per reason of the gate: what was not done, and what to use instead. */
const SKIPPED: Record<GraphSkipReason, string> = {
  off: "the code graph is switched off for this project (/graph on enables it)",
  "home folder": "this folder holds the whole home folder, so nothing was indexed",
  "no git repo": "this folder is not inside a git repository, so it is not indexed automatically (/graph on indexes it)",
  "several repos": "this folder holds several git repositories; open one of them (or /graph on indexes all)",
  "large folder": "this repository is too large to index automatically (/graph on indexes it)",
}

async function withGraph({
  indexer,
  gate,
  context,
  title,
  run,
}: {
  indexer: Indexer
  gate: CodeGraphOptions["gate"]
  context: ToolContext
  title: string
  run: (graph: Graph) => Promise<ToolResult> | ToolResult
}): Promise<ToolResult> {
  if (context.signal.aborted) return cancelled(title)
  const verdict: GraphGate = gate ? await gate(context.cwd, context.signal).catch(() => ({ index: true as const })) : holdsHome(context.cwd) ? { index: false, reason: "home folder" } : { index: true }
  if (context.signal.aborted) return cancelled(title)
  if (!verdict.index) return fail({ title, message: `code graph is off here: ${SKIPPED[verdict.reason]}. Use glob, grep and read.` })
  try {
    const graph = await indexer.graph({ cwd: context.cwd, signal: context.signal })
    return await run(graph)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return cancelled(title)
    return fail({ title, message: `code graph failed: ${errorMessage(error)}` })
  }
}

type Gate = CodeGraphOptions["gate"]

/** The folder at or above `absolute` whose code graph already exists (in memory or as a cache file); none is built for this. */
export function indexedRootOf(indexer: Indexer, absolute: string): string | undefined {
  for (let dir = absolute; ; dir = dirname(dir)) {
    if (indexer.peek(dir) || existsSync(indexer.cachePath(dir))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * A graph tool asked about a `path` outside the session's project answers from the graph of the project that holds it, when that
 * project was indexed before (an attached or added folder the user works in); otherwise it says the path is outside the project. An
 * outside folder is never indexed for this, and the permission engine has already judged the path as an external-directory read.
 */
function acrossProjects(indexer: Indexer, tool: Tool): Tool {
  return {
    ...tool,
    async execute(args, context) {
      const path = (args as { path?: unknown }).path
      if (typeof path !== "string" || projectRelative({ cwd: context.cwd, input: path }) !== undefined) return tool.execute(args, context)
      const absolute = resolve(context.cwd, path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))
      const root = indexedRootOf(indexer, absolute)
      if (!root || root === context.cwd) return tool.execute(args, context)
      const result = await tool.execute({ ...(args as object), path: absolute }, { ...context, cwd: root })
      return result.isError ? result : { ...result, output: `From the code graph of ${root} (its paths are relative to that folder):\n${result.output}` }
    },
  }
}

function findTool(indexer: Indexer, gate: Gate): Tool {
  return defineTool({
    name: "graph_find",
    description:
      "Where code is: symbols ranked by name, with file:line, from the project index. Ask this before grep or reading files to find a function, class or type. TS/JS/Python/Go/Rust/Swift.",
    permission: "read",
    args: z.object({
      query: z.string().trim().min(1).describe("Name or Class.method"),
      kind: z.string().optional().describe("Declaration kind, e.g. function, class, method"),
      path: z.string().optional().describe("File/directory scope"),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe("Max results (default 20)"),
      source: z.boolean().optional().describe("8 source lines/match"),
    }),
    async execute({ query, kind, path, limit, source }, context) {
      const title = `Graph find ${clip(query, 60)}`
      if (kind !== undefined && !SYMBOL_KINDS.has(kind)) return fail({ title, message: `unknown kind "${kind}"` })
      const scope = path === undefined ? undefined : projectRelative({ cwd: context.cwd, input: path })
      if (scope === undefined && path !== undefined) return fail({ title, message: `${path}: outside the project, and no code graph of another project covers it (read, glob and grep reach it)` })
      return withGraph({
        indexer,
        gate,
        context,
        title,
        async run(graph) {
          const found = findSymbols({ graph, query, path: scope, kind: kind as SymbolKind | undefined })
          const shown = found.slice(0, limit ?? 20).map((entry) => entry.node)
          const meta = { results: shown.length, total: found.length, files: graph.files.size, symbols: graph.nodes.length, partial: graph.partial }
          if (shown.length === 0) {
            return succeed({ title, output: `No symbols match "${query}" (${graph.nodes.length} symbols in ${graph.files.size} files). Try code_search for text or concepts.${partialNote(graph)}`, meta })
          }
          const excerpts = source ? await sourceExcerpts({ graph, nodes: shown, signal: context.signal }) : undefined
          const lines = shown.map((node) => {
            const callers = inDegree({ graph, id: node.id })
            const header = `${loc(node)}  ${node.kind} ${node.label}${node.exported ? " (export)" : ""}${callers > 0 ? `  callers:${callers}` : ""}`
            return excerpts ? `${header}\n${excerpts.get(node.id) ?? "  [source unavailable or changed since indexing]"}` : header
          })
          if (found.length > shown.length) lines.push(`[${found.length - shown.length} more matches; narrow the query or pass path/kind]`)
          const capped = truncateText({ text: lines.join("\n") + partialNote(graph) })
          // A search replaces a grep and the few best files opened after it, not every file of every match: only the top files count.
          const opened = [...new Set(shown.map((node) => node.path))].slice(0, FIND_SAVING_FILES)
          const saved = lookupSavings({ graph, paths: opened, output: capped.text })
          const render = {
            type: "codemap",
            center: { label: clip(`search: ${query}`, LABEL_LIMIT), kind: "search" },
            left: { title: "", entries: [] },
            right: { title: "matches", entries: shown.map((node) => mapEntry({ node })), more: found.length - shown.length, flow: "none" },
            ...(saved !== undefined ? { saved } : {}),
          }
          return withRender(succeed({ title, output: capped.text, truncated: capped.truncated || found.length > shown.length, meta: { ...meta, ...savingsMeta(saved) } }), render)
        },
      })
    },
  })
}

function callersTool(indexer: Indexer, gate: Gate): Tool {
  return defineTool({
    name: "graph_callers",
    description:
      "Who calls a symbol, or what it calls, across files; ask before changing it. Follows aliases/re-exports; dynamic dispatch may be missing.",
    permission: "read",
    args: z.object({
      symbol: z.string().trim().min(1).describe("Symbol, Class.method or path#name"),
      direction: z.enum(["in", "out"]).default("in").describe("in = callers, out = callees"),
      depth: callDepth.describe("Default 1; all = full reach, capped output"),
      path: z.string().optional().describe("Disambiguate by file or directory"),
    }),
    async execute({ symbol, direction, depth, path }, context) {
      const title = `${direction === "in" ? "Callers of" : "Callees of"} ${clip(symbol, 60)}`
      const scope = path === undefined ? undefined : projectRelative({ cwd: context.cwd, input: path })
      if (scope === undefined && path !== undefined) return fail({ title, message: `${path}: outside the project, and no code graph of another project covers it (read, glob and grep reach it)` })
      return withGraph({
        indexer,
        gate,
        context,
        title,
        run(graph) {
          const resolved = resolveSymbol({ graph, symbol, path: scope })
          if ("suggestions" in resolved) {
            const hint = resolved.suggestions.length > 0 ? ` Did you mean: ${resolved.suggestions.map((node) => node.label).join(", ")}?` : ""
            return fail({ title, message: `No symbol "${symbol}" in the graph.${hint}` })
          }
          const start = resolved.node
          const levels = depth ?? 1
          const { rows, more } = traverseCalls({ graph, start, direction, depth: levels, cap: MAX_RESULTS })
          const meta = { results: rows.length, direction, depth: levels, symbol: start.id, partial: graph.partial }
          const header = [`${start.label} (${start.kind}) ${loc(start)}`]
          if (resolved.others.length > 0) header.push(`Also matches: ${resolved.others.slice(0, 5).map(loc).join(", ")}`)
          const body =
            rows.length === 0
              ? [`No ${direction === "in" ? "callers" : "callees"} found (syntactic graph; dynamic dispatch and unknown receivers may be missing).`]
              : [
                  `${direction === "in" ? "Callers" : "Callees"}, depth ${levels}: ${rows.length}${more > 0 ? ` shown, ${more} more` : ""}`,
                  ...rows.map((entry) => `d${entry.depth}  ${loc(entry.node)}  ${entry.node.kind} ${entry.node.label}${entry.depth > 1 ? `  (${direction === "in" ? "calls" : "called by"} ${entry.via.label})` : ""}`),
                ]
          const capped = truncateText({ text: [...header, ...body].join("\n") + partialNote(graph) })
          // The other side of the map costs one level: the model asked for one direction, the user sees both.
          const other = traverseCalls({ graph, start, direction: direction === "in" ? "out" : "in", depth: 1, cap: OTHER_SIDE_ROWS })
          const side = (title: string, flow: "in" | "out", found: { rows: typeof rows; more: number }) => ({ title, entries: found.rows.map((entry) => mapEntry({ node: entry.node, depth: entry.depth, via: entry.via })), more: found.more, flow })
          const callers = direction === "in" ? { rows, more } : other
          const callees = direction === "out" ? { rows, more } : other
          // Only the files the model was told about count; the other side of the map is for the user.
          const saved = lookupSavings({ graph, paths: [start.path, ...rows.map((entry) => entry.node.path)], output: capped.text })
          const render = {
            type: "codemap",
            center: mapEntry({ node: start }),
            left: side("callers", "in", callers),
            right: side("callees", "out", callees),
            ...(saved !== undefined ? { saved } : {}),
          }
          return withRender(succeed({ title, output: capped.text, truncated: capped.truncated || more > 0, meta: { ...meta, ...savingsMeta(saved) } }), render)
        },
      })
    },
  })
}

function fileApiTool(indexer: Indexer, gate: Gate): Tool {
  return defineTool({
    name: "graph_file_api",
    description: "One file's symbols with line spans and imports, without its contents; ask before reading a large file whole.",
    permission: "read",
    args: z.object({ path: z.string().min(1).describe("Project-relative file") }),
    async execute({ path }, context) {
      const title = `File API ${clip(path, 80)}`
      const rel = projectRelative({ cwd: context.cwd, input: path })
      if (rel === undefined || rel === "") return fail({ title, message: `${path}: not a file inside the project` })
      return withGraph({
        indexer,
        gate,
        context,
        title,
        run(graph) {
          const nodes = graph.byPath.get(rel)
          const file = graph.files.get(rel)
          if (!nodes || !file) {
            const why = languageOf(rel) === undefined ? "unsupported language (TypeScript, JavaScript, Python, Go, Rust)" : "not indexed (missing, ignored, over 512 KB, or beyond the file cap)"
            return fail({ title, message: `${rel}: ${why}` })
          }
          const shown = nodes.slice(0, MAX_RESULTS)
          const lines = [`${rel} (${file.language}, ${nodes.length} symbols)`]
          if (file.imports.length > 0) lines.push(`imports: ${file.imports.slice(0, 10).join(", ")}${file.imports.length > 10 ? `, +${file.imports.length - 10}` : ""}`)
          for (const node of shown) {
            const span = node.start > 0 ? `L${node.start}-L${node.end}` : "L?"
            lines.push(`${span}  ${node.parent ? "  " : ""}${node.kind} ${node.parent ? node.name : node.label}${node.exported ? " (export)" : ""}`)
          }
          if (nodes.length > shown.length) lines.push(`[${nodes.length - shown.length} more symbols not shown]`)
          if (nodes.length === 0) lines.push("(no symbols found)")
          const capped = truncateText({ text: lines.join("\n") + partialNote(graph) })
          const saved = lookupSavings({ graph, paths: [rel], output: capped.text })
          // One summary row; the top symbols as a table in the `full` view; the whole listing once the card is opened.
          const top = nodes.filter((node) => !node.parent).sort((a, b) => Number(b.exported) - Number(a.exported) || a.start - b.start).slice(0, SYMBOL_TABLE_ROWS)
          const render = {
            type: "stack",
            children: [
              { type: "text", text: clip([file.language, `${nodes.length} ${nodes.length === 1 ? "symbol" : "symbols"}`, ...(file.imports.length > 0 ? [`${file.imports.length} ${file.imports.length === 1 ? "import" : "imports"}`] : [])].join(" · "), 300), tone: "muted" },
              ...(top.length > 0 ? [{ type: "detail", at: "preview", children: [{ type: "table", columns: ["symbol", "kind", "line"], rows: top.map((node) => [clip(node.label, 60), node.kind, node.start > 0 ? `L${node.start}` : "L?"]) }] }] : []),
              { type: "detail", at: "open", children: [{ type: "list", items: lines.slice(1, 1 + RENDER_ROWS).map((text) => clip(text, 300)) }] },
            ],
          }
          return withRender(succeed({ title, output: capped.text, truncated: capped.truncated || nodes.length > shown.length, meta: { symbols: nodes.length, language: file.language, partial: graph.partial, ...savingsMeta(saved) } }), render)
        },
      })
    },
  })
}

const SHORT_LANGUAGE = { typescript: "ts", javascript: "js", python: "py", go: "go", rust: "rs", swift: "swift" } as const

function mapTool(indexer: Indexer, gate: Gate): Tool {
  return defineTool({
    name: "graph_map",
    description: "Project directories, languages and most-called symbols.",
    permission: "read",
    args: z.object({
      path: z.string().optional().describe("Only under this directory"),
      depth: z.number().int().min(1).max(3).optional().describe("Directory levels to group by (default 2)"),
    }),
    async execute({ path, depth }, context) {
      const title = `Code map${path ? ` ${clip(path, 60)}` : ""}`
      const scope = path === undefined ? undefined : projectRelative({ cwd: context.cwd, input: path })
      if (scope === undefined && path !== undefined) return fail({ title, message: `${path}: outside the project, and no code graph of another project covers it (read, glob and grep reach it)` })
      return withGraph({
        indexer,
        gate,
        context,
        title,
        run(graph) {
          const map = projectMap({ graph, scope, depth: depth ?? 2, hubLimit: 20 })
          const meta = { files: map.files, symbols: map.symbols, directories: map.dirs.length, hubs: map.hubs.length, partial: graph.partial }
          if (map.files === 0) return succeed({ title, output: `No indexed source files${scope ? ` under ${scope}` : ""}.${partialNote(graph)}`, meta })
          const dirShown = map.dirs.slice(0, MAX_RESULTS)
          const dirRows = dirShown.map((entry) => {
            const languages = Object.entries(entry.languages)
              .sort((a, b) => b[1] - a[1])
              .map(([language, count]) => `${SHORT_LANGUAGE[language as keyof typeof SHORT_LANGUAGE]} ${count}`)
              .join(", ")
            return `${entry.dir}  ${entry.files} files  ${languages}`
          })
          const hubRows = map.hubs.map((hub) => `${hub.node.label}  ${loc(hub.node)}  callers:${hub.callers}`)
          const lines = [
            `${map.files} files, ${map.symbols} symbols${scope ? ` under ${scope}` : ""}, indexed ${new Date(graph.builtAt).toISOString()}`,
            `Directories (depth ${depth ?? 2}):`,
            ...dirRows,
            ...(map.dirs.length > dirShown.length ? [`[${map.dirs.length - dirShown.length} more directories]`] : []),
            "Hub symbols (most callers):",
            ...(hubRows.length > 0 ? hubRows : ["(no call edges found)"]),
          ]
          const capped = truncateText({ text: lines.join("\n") + partialNote(graph) })
          const root = clip(basename(context.cwd) || "project", LABEL_LIMIT)
          const used = new Set<string>([root])
          const unique = (label: string) => {
            let candidate = clip(label, LABEL_LIMIT)
            if (used.has(candidate)) candidate = clip(`${label} (hub)`, LABEL_LIMIT)
            used.add(candidate)
            return candidate
          }
          const topDirs = map.dirs.slice(0, 8).map((entry) => ({ dir: entry.dir, label: unique(entry.dir) }))
          const edges: Edge[] = topDirs.map((entry) => ({ from: root, to: entry.label, relation: "dir" }))
          for (const hub of map.hubs.slice(0, GRAPH_EDGE_LIMIT - edges.length)) {
            const owner = topDirs.filter((entry) => entry.dir !== "." && under({ path: hub.node.path, prefix: entry.dir })).sort((a, b) => b.dir.length - a.dir.length)[0]
            edges.push({ from: owner?.label ?? root, to: unique(hub.node.label), relation: `${hub.callers} callers` })
          }
          // The visual is the content: one muted summary row, a short hub table for the `full` view, the lists only once the card is opened.
          const stem = (file: string) => (file.split("/").at(-1) ?? file).replace(/\.[^.]+$/, "")
          const summary = [`${map.dirs.length} ${map.dirs.length === 1 ? "dir" : "dirs"}`, `${map.files.toLocaleString("en-US")} ${map.files === 1 ? "file" : "files"}`, ...(map.hubs.length > 0 ? [`hubs: ${map.hubs.slice(0, 3).map((hub) => `${hub.node.label} ${hub.callers}`).join(" · ")}`] : [])].join(" · ")
          const render = {
            type: "stack",
            children: [
              { type: "graph", root, edges, title: "Project map" },
              { type: "text", text: clip(summary, 300), tone: "muted" },
              ...(map.hubs.length > 0 ? [{ type: "detail", at: "preview", children: [{ type: "table", columns: ["hub", "file", "callers"], rows: map.hubs.slice(0, HUB_TABLE_ROWS).map((hub) => [clip(hub.node.label, 60), clip(stem(hub.node.path), 40), String(hub.callers)]) }] }] : []),
              {
                type: "detail",
                at: "open",
                children: [
                  { type: "text", text: "Directories", bold: true },
                  { type: "list", items: dirRows.map((text) => clip(text, 300)) },
                  { type: "text", text: "Hub symbols", bold: true },
                  { type: "list", items: hubRows.map((text) => clip(text, 300)) },
                ],
              },
            ],
          }
          const saved = lookupSavings({ graph, paths: map.hubs.map((hub) => hub.node.path), output: capped.text })
          return withRender(succeed({ title, output: capped.text, truncated: capped.truncated, meta: { ...meta, ...savingsMeta(saved) } }), render)
        },
      })
    },
  })
}

const STOPWORDS = new Set(["the", "and", "for", "how", "does", "what", "where", "which", "with", "from", "this", "that", "are", "into", "work", "works"])

function queryWords(query: string): string[] {
  const words = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
  const stems = words.flatMap((word) => {
    const stem = word.replace(/(ing|ed|s)$/, "")
    return stem.length >= 4 && stem !== word ? [word, stem] : [word]
  })
  return [...new Set(stems)].slice(0, 8)
}

function hitLines(hits: JgHit[]): string[] {
  return hits.slice(0, MAX_RESULTS).map((hit) => `${hit.path}:${hit.line}${hit.text ? `  ${hit.text}` : ""}`)
}

function searchTool({ indexer, options }: { indexer: Indexer; options: CodeGraphOptions }): Tool {
  const gate = options.gate
  return defineTool({
    name: "code_search",
    description:
      "Concept search via jg; falls back to symbols and literal text.",
    permission: "read",
    args: z.object({
      query: z.string().trim().min(1).describe("Concept or identifier"),
      path: z.string().optional().describe("File/directory scope (default: the whole project)"),
    }),
    async execute({ query, path }, context) {
      const title = `Code search ${clip(query, 60)}`
      if (context.signal.aborted) return cancelled(title)
      const scope = path === undefined ? "" : projectRelative({ cwd: context.cwd, input: path })
      if (scope === undefined) return fail({ title, message: `${path}: outside the project, and no code graph of another project covers it (read, glob and grep reach it)` })
      const jg = Bun.which(options.jgBin ?? "jg", { PATH: process.env.PATH ?? "" })
      let reason = "jg is not installed"
      if (jg) {
        const outcome = await runJg({ bin: jg, query, path: scope === "" ? context.cwd : join(context.cwd, scope), cwd: context.cwd, signal: context.signal, timeoutMs: options.jgTimeoutMs ?? JG_TIMEOUT_MS })
        if (outcome.kind === "aborted") return cancelled(title)
        if (outcome.kind === "ok") {
          const parsed = parseJgOutput({ text: outcome.stdout, cwd: context.cwd })
          if (parsed.hits.length > 0 || parsed.summary !== "") {
            const lines = [...(parsed.summary ? [parsed.summary] : []), ...(parsed.hits.length > 0 ? [`Hits (${Math.min(parsed.hits.length, MAX_RESULTS)}${parsed.hits.length > MAX_RESULTS ? ` of ${parsed.hits.length}` : ""}):`, ...hitLines(parsed.hits)] : [])]
            const capped = truncateText({ text: lines.join("\n") })
            return succeed({ title, output: capped.text, truncated: capped.truncated || parsed.hits.length > MAX_RESULTS, meta: { engine: "jg", hits: Math.min(parsed.hits.length, MAX_RESULTS) } })
          }
          reason = "jg output had no readable hits"
        } else reason = outcome.reason
      }
      return withGraph({
        indexer,
        gate,
        context,
        title,
        async run(graph) {
          const words = queryWords(query)
          const scores = new Map<string, { node: GraphNode; score: number }>()
          for (const term of [query, ...words]) {
            for (const entry of findSymbols({ graph, query: term, path: scope })) {
              const previous = scores.get(entry.node.id)
              scores.set(entry.node.id, { node: entry.node, score: (previous?.score ?? 0) + entry.score })
            }
          }
          const symbols = [...scores.values()].sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path)).slice(0, 25).map((entry) => entry.node)
          const symbolFiles = new Set(symbols.map((node) => node.path))
          const files = [...graph.files.keys()].filter((file) => under({ path: file, prefix: scope })).sort((a, b) => Number(symbolFiles.has(b)) - Number(symbolFiles.has(a)) || a.localeCompare(b))
          let hits = await literalSearch({ cwd: context.cwd, files, needles: [query], limit: 20, signal: context.signal })
          if (hits.length === 0 && words.length > 0) hits = await literalSearch({ cwd: context.cwd, files, needles: words, limit: 20, signal: context.signal })
          if (context.signal.aborted) return cancelled(title)
          const lines = [`[graph search: ${reason}]`]
          if (symbols.length > 0) lines.push("Symbols:", ...symbols.map(row))
          if (hits.length > 0) lines.push("Text matches:", ...hitLines(hits))
          if (symbols.length === 0 && hits.length === 0) lines.push(`No symbols or text match "${query}".`)
          const capped = truncateText({ text: lines.join("\n") + partialNote(graph) })
          return succeed({ title, output: capped.text, truncated: capped.truncated, meta: { engine: "graph", hits: hits.length, symbols: symbols.length, fallback: reason } })
        },
      })
    },
  })
}

function impactTool(indexer: Indexer): Tool {
  return defineTool({
    name: "graph_impact",
    tier: "balanced",
    description: "Cached transitive callers/importers. No scan; not safety proof.",
    permission: "read",
    args: z.object({ path: z.string().min(1).max(4096), depth: callDepth.describe("Default 2, or all") }),
    async execute({ path, depth }, context) {
      const title = "Cached graph impact"
      if (context.signal.aborted) return cancelled(title)
      const scope = projectRelative({ cwd: context.cwd, input: path })
      if (scope === undefined) return fail({ title, message: "path is outside the project" })
      const graph = indexer.peek(context.cwd)
      if (!graph) return succeed({ title, output: "Graph impact unavailable: no cached orientation. No safety conclusion can be drawn." })
      const symbols = graph.byPath.get(scope)
      if (!symbols) return succeed({ title, output: `Graph impact unavailable: ${scope} was not indexed in the cached graph. New symbols and files require a fresh graph lookup; no safety conclusion can be drawn.` })
      const levels = depth ?? 2
      const direct = new Set<string>()
      for (const symbol of symbols) for (const id of graph.callers.get(symbol.id) ?? []) if (graph.byId.get(id)?.path !== scope) direct.add(id)
      const { rows, more } = traverseCalls({ graph, start: symbols, direction: "in", depth: levels, cap: 24 })
      const dependentFiles = new Set<string>([scope])
      let frontier = [scope]
      for (let hop = 1; hop <= (levels === "all" ? Infinity : levels) && frontier.length; hop++) {
        const next: string[] = []
        for (const file of frontier) for (const importer of graph.importers.get(file) ?? []) {
          if (dependentFiles.has(importer)) continue
          dependentFiles.add(importer)
          next.push(importer)
        }
        frontier = next
      }
      dependentFiles.delete(scope)
      const imports = [...dependentFiles].sort()
      const shownImports = imports.slice(0, 12)
      const output = [
        `[cached pre-edit graph: ${scope}] ${symbols.length} symbols, ${direct.size} direct callers, ${rows.length + more} reachable callers (depth ${levels}); ${imports.length} importing files.`,
        `Snapshot ${new Date(graph.builtAt).toISOString()}; dynamic calls and new symbols may be missing. Not a safety proof.`,
        ...rows.map((entry) => `d${entry.depth} ${row(entry.node)}`),
        ...(more ? [`[${more} more callers]`] : []),
        ...(shownImports.length ? ["Import dependents:", ...shownImports] : []),
        ...(imports.length > shownImports.length ? [`[${imports.length - shownImports.length} more importing files]`] : []),
      ].join("\n") + partialNote(graph)
      const capped = truncateText({ text: output })
      const saved = lookupSavings({ graph, paths: [...rows.map((entry) => entry.node.path), ...shownImports], output: capped.text })
      return succeed({ title, output: capped.text, truncated: capped.truncated || more > 0 || imports.length > shownImports.length, meta: { callers: direct.size, reachable: rows.length + more, importingFiles: imports.length, symbols: symbols.length, cached: true, builtAt: graph.builtAt, partial: graph.partial, ...savingsMeta(saved) } })
    },
  })
}

/** Read-only code-graph tools; indexing is lazy and incremental, impact uses only the cached graph. */
export function createCodeGraphTools(options: CodeGraphOptions): Tool[] {
  const indexer = options.indexer ?? createIndexer({ cacheDir: options.cacheDir, now: options.now ?? Date.now, onScan: options.onScan, onIndex: options.onIndex, maxFiles: options.maxFiles })
  return [findTool(indexer, options.gate), callersTool(indexer, options.gate), fileApiTool(indexer, options.gate), mapTool(indexer, options.gate), searchTool({ indexer, options }), impactTool(indexer)].map((tool) => acrossProjects(indexer, tool))
}
