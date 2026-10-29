import { open, realpath } from "node:fs/promises"
import { join, relative, isAbsolute } from "node:path"
import type { Graph, GraphNode } from "./graph"
import { MAX_FILE_BYTES } from "./types"

/** One bounded read per file, shared by all requested symbols. Source remains untrusted tool output. */
export async function sourceExcerpts({ graph, nodes, signal }: { graph: Graph; nodes: GraphNode[]; signal: AbortSignal }): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const root = await realpath(graph.cwd)
  const files = new Map<string, GraphNode[]>()
  for (const node of nodes) files.set(node.path, [...(files.get(node.path) ?? []), node])
  for (const [path, symbols] of files) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError")
    let rows: string[] | undefined
    try {
      const target = await realpath(join(root, path))
      const rel = relative(root, target)
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue
      const file = await open(target, "r")
      try {
        const info = await file.stat()
        const indexed = graph.files.get(path)
        if (!info.isFile() || info.size > MAX_FILE_BYTES || info.mtimeMs !== indexed?.mtimeMs || info.ctimeMs !== indexed.ctimeMs) continue
        const buffer = Buffer.alloc(info.size + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        const after = await file.stat()
        if (bytesRead !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) continue
        rows = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)
      } finally { await file.close() }
    } catch { continue }
    for (const node of symbols) {
      if (node.start < 1 || node.end < node.start || node.start > rows.length) continue
      const end = Math.min(node.end, node.start + 7, rows.length)
      const excerpt = rows.slice(node.start - 1, end).map((line, index) => `  ${node.start + index} | ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`)
      if (end < node.end) excerpt.push(`  … L${end + 1}-L${node.end} omitted`)
      result.set(node.id, excerpt.join("\n"))
    }
  }
  if (signal.aborted) throw new DOMException("aborted", "AbortError")
  return result
}
