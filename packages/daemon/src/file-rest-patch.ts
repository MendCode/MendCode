import type { FileContent } from "@mendcode/protocol"
import { FileApiError } from "./file-rest-process"

const tokens = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const equal = (a: string, b: string) => a.endsWith("\n") === b.endsWith("\n") && a.trim() === b.trim()

/** Myers line edits with a work cap; full context matches the donor file-content contract. */
export function fileContentPatch(file: string, original: string, content: string): Pick<FileContent, "patch" | "diff"> {
  const old = tokens(original), next = tokens(content)
  const trace: Map<number, number>[] = []
  const frontier = new Map<number, number>([[1, 0]])
  let work = 0
  let found = false
  for (let distance = 0; distance <= old.length + next.length && !found; distance++) {
    trace.push(new Map(frontier))
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 200_000) throw new FileApiError("File diff complexity limit exceeded")
      let x = diagonal === -distance || diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1) ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1
      let y = x - diagonal
      while (x < old.length && y < next.length && equal(old[x]!, next[y]!)) { x++; y++; if (++work > 200_000) throw new FileApiError("File diff complexity limit exceeded") }
      frontier.set(diagonal, x)
      if (x >= old.length && y >= next.length) { found = true; break }
    }
  }
  const edits: Array<{ kind: " " | "-" | "+"; text: string }> = []
  let x = old.length, y = next.length
  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const values = trace[distance]!, diagonal = x - y
    const previous = diagonal === -distance || diagonal !== distance && (values.get(diagonal - 1) ?? -1) < (values.get(diagonal + 1) ?? -1) ? diagonal + 1 : diagonal - 1
    const previousX = values.get(previous) ?? 0, previousY = previousX - previous
    while (x > previousX && y > previousY) { edits.push({ kind: " ", text: next[--y]! }); x-- }
    if (!distance) break
    if (x === previousX) edits.push({ kind: "+", text: next[--y]! })
    else edits.push({ kind: "-", text: old[--x]! })
  }
  edits.reverse()
  const lines = edits.flatMap((edit) => [edit.kind + edit.text.replace(/\n$/, ""), ...(edit.text.endsWith("\n") ? [] : ["\\ No newline at end of file"])])
  const hunks = edits.some((edit) => edit.kind !== " ") ? [{ oldStart: old.length ? 1 : 0, oldLines: old.length, newStart: next.length ? 1 : 0, newLines: next.length, lines }] : []
  const patch = { oldFileName: file, newFileName: file, oldHeader: "old", newHeader: "new", hunks }
  const range = (start: number, length: number) => `${start}${length === 1 ? "" : `,${length}`}`
  const diff = `Index: ${file}\n${"=".repeat(67)}\n--- ${file}\told\n+++ ${file}\tnew\n${hunks.map((hunk) => `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@\n${hunk.lines.join("\n")}\n`).join("")}`
  return { patch, diff }
}
