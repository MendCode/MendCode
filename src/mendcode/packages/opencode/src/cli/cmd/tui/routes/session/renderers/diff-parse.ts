import path from "path"

export type TimelineDiffRowKind = "file" | "context" | "added" | "removed" | "meta"

export type TimelineDiffRow = {
  kind: TimelineDiffRowKind
  oldLine?: number
  newLine?: number
  text: string
}

export type TimelineDiffFileStatus = "added" | "removed" | undefined

export function timelineDiffFileStatus(diff: string): TimelineDiffFileStatus {
  if (/^(?:new file mode|--- \/dev\/null)/m.test(diff)) return "added"
  if (/^(?:deleted file mode|\+\+\+ \/dev\/null)/m.test(diff)) return "removed"
  return undefined
}

export function parseTimelineDiffRows(diff: string): TimelineDiffRow[] {
  const rows: TimelineDiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let currentFile: string | undefined
  const lines = diff.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  const cleanPath = (input: string) => {
    const withoutPrefix = input.replace(/^[ab]\//, "")
    if (!path.isAbsolute(withoutPrefix)) return withoutPrefix

    const relative = path.relative(process.cwd(), withoutPrefix)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return withoutPrefix
    return relative.split(path.sep).join("/")
  }
  const pushFile = (file: string) => {
    const text = cleanPath(file.trim())
    if (!text || text === "/dev/null" || text === currentFile) return
    currentFile = text
    rows.push({ kind: "file", text })
  }

  for (const line of lines) {
    if (!line && rows.length === 0) continue

    const gitFile = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (gitFile) {
      pushFile(gitFile[2])
      continue
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }

    if (line.startsWith("Index: ")) {
      pushFile(line.replace(/^Index:\s*/, ""))
      continue
    }

    if (line.startsWith("+++ ")) {
      pushFile(line.slice(4))
      continue
    }

    if (
      line.startsWith("--- ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ kind: "added", newLine, text: line.slice(1) })
      newLine += 1
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ kind: "removed", oldLine, text: line.slice(1) })
      oldLine += 1
      continue
    }

    if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: line.slice(1) })
      oldLine += 1
      newLine += 1
      continue
    }

    if (line.startsWith("\\ No newline")) {
      rows.push({ kind: "meta", text: "No newline at end of file" })
      continue
    }

    if (line.startsWith("===")) continue
    rows.push({ kind: "meta", text: line })
  }

  return rows
}
