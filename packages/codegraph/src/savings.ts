import { estimateTokens } from "@mendcode/protocol/wire"
import type { Graph, GraphNode } from "./graph"

/**
 * What a graph lookup kept out of the context, estimated against the alternative the model would really have used (`rg -n`
 * for a name, reading a symbol's line range, reading a file), never against whole files it would not have opened. Everything
 * comes from what the graph already holds in memory (file sizes and line counts, symbol spans, call edges): no file is read.
 * An alternative the graph cannot size is `undefined` and the lookup reports no saving.
 */


/** A query that matches more symbols than this is not priced: summing thousands of hits costs CPU on every call, and no one reads that many lines. */
export const MAX_PRICED_MATCHES = 2000

/**
 * Bytes per line assumed for every file. The graph records no line counts (adding one would grow its cache), and the symbol spans
 * cannot give a file's length. Measured over MendCode's own TypeScript sources it is 61 (including newlines); 50 keeps the
 * figures a floor on projects with shorter lines.
 */
export const LINE_BYTES = 50

/** The characters `rg -n` prints for a hit at `line` of `path`: `path:line:`, a line of that file and its newline. */
export function hitChars({ path, line }: { path: string; line: number }): number {
  return path.length + 2 + String(Math.max(1, line)).length + LINE_BYTES
}

/** The `rg -n` hit for a symbol's declaration line (or, for a caller, the line its body starts at: the line of the call is somewhere after it). */
export const nodeHitChars = ({ node }: { node: GraphNode }): number => hitChars({ path: node.path, line: node.start })

/** The characters of reading a symbol's line range (`read` with offset and limit). Undefined for a symbol without a span. */
export function rangeChars({ node }: { node: GraphNode }): number | undefined {
  if (node.start < 1 || node.end < node.start) return undefined
  return (node.end - node.start + 1) * LINE_BYTES
}

/** The characters of reading a whole indexed file. */
export function fileChars({ graph, path }: { graph: Graph; path: string }): number | undefined {
  return graph.files.get(path)?.size
}

/** Adds up sizes; one unknown part makes the whole alternative unknown rather than smaller. */
export function sumChars(parts: Iterable<number | undefined>): number | undefined {
  let total = 0
  for (const part of parts) {
    if (part === undefined) return undefined
    total += part
  }
  return total
}

/**
 * What `rg -n <name>` prints for symbols named like the query: a hit for each declaration and for each distinct caller (one line
 * per calling symbol, so a floor: a symbol that calls twice prints twice, and a mention that is not a call prints too). The same
 * caller of two matches is one line.
 */
export function grepChars({ graph, declarations }: { graph: Graph; declarations: readonly GraphNode[] }): number | undefined {
  const callers = new Set<string>()
  const parts: Array<number | undefined> = []
  for (const node of declarations) {
    parts.push(nodeHitChars({ node }))
    for (const id of graph.callers.get(node.id) ?? []) {
      if (callers.has(id)) continue
      callers.add(id)
      const caller = graph.byId.get(id)
      if (caller) parts.push(nodeHitChars({ node: caller }))
    }
  }
  return sumChars(parts)
}

/** Estimated tokens saved: the alternative's size against the result the model got, never negative; undefined when nothing was saved or the alternative is unknown. */
export function lookupSavings({ alternativeChars, output }: { alternativeChars: number | undefined; output: string }): number | undefined {
  if (alternativeChars === undefined) return undefined
  const saved = estimateTokens(alternativeChars) - estimateTokens(output.length)
  return saved > 0 ? saved : undefined
}
