import path from "path"

export type TimelineDiffRowKind = "file" | "context" | "added" | "removed" | "meta"

export type TimelineDiffRow = {
  kind: TimelineDiffRowKind
  oldLine?: number
  newLine?: number
  text: string
}

export type TimelineDiffFileStatus = "added" | "removed" | undefined

const MAX_RENDER_DIFF_CHARS = 2_000_000
const MAX_RENDER_DIFF_ROWS = 20_000
export const TIMELINE_DIFF_TRUNCATION_PREFIX = "Diff preview truncated:"
const NON_TEXT_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/
const BINARY_PATCH_PATTERN = /^Binary files .+ differ(?: \(([^)]+) bytes\))?$/m
export const TIMELINE_BINARY_PATCH_PREFIX = "Binary/non-text patch omitted"

export function timelineDiffHasPreviewMarker(diff: string) {
  return diff.includes(TIMELINE_DIFF_TRUNCATION_PREFIX)
}

export function timelineDiffIsTruncationRow(row: TimelineDiffRow) {
  return row.kind === "meta" && row.text.startsWith(TIMELINE_DIFF_TRUNCATION_PREFIX)
}

export function timelineDiffFileStatus(diff: string): TimelineDiffFileStatus {
  if (/^(?:new file mode|--- \/dev\/null)/m.test(diff)) return "added"
  if (/^(?:deleted file mode|\+\+\+ \/dev\/null)/m.test(diff)) return "removed"
  return undefined
}

function diffFileLabel(diff: string) {
  for (const line of diff.slice(0, 8192).split(/\r?\n/)) {
    const index = line.match(/^Index:\s*(.+)$/)
    if (index) return index[1].trim()

    const gitFile = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (gitFile) return gitFile[2].trim()

    if (line.startsWith("+++ ")) {
      const file = line.slice(4).trim()
      if (file && file !== "/dev/null") return file
    }

    if (line.startsWith("--- ")) {
      const file = line.slice(4).trim()
      if (file && file !== "/dev/null") return file
    }
  }
}

function cleanDiffPath(input: string) {
  const withoutPrefix = input.replace(/^[ab]\//, "")
  if (!path.isAbsolute(withoutPrefix)) return withoutPrefix

  const relative = path.relative(process.cwd(), withoutPrefix)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return withoutPrefix
  return relative.split(path.sep).join("/")
}

function nonTextDiffRows(diff: string): TimelineDiffRow[] | undefined {
  const sample = diff.length <= 64_000 ? diff : `${diff.slice(0, 32_000)}\n${diff.slice(-32_000)}`
  const binary = BINARY_PATCH_PATTERN.exec(sample)
  if (!binary && !NON_TEXT_PATTERN.test(sample)) return
  const rows: TimelineDiffRow[] = []
  const file = diffFileLabel(diff)
  if (file) rows.push({ kind: "file", text: cleanDiffPath(file) })
  rows.push({
    kind: "meta",
    text: binary?.[1]
      ? `${TIMELINE_BINARY_PATCH_PREFIX} (${binary[1]} bytes)`
      : `${TIMELINE_BINARY_PATCH_PREFIX} (${diff.length.toLocaleString()} chars)`,
  })
  return rows
}

export function timelineDiffIsNonText(diff: string) {
  return nonTextDiffRows(diff) !== undefined
}

export function parseTimelineDiffRows(diff: string): TimelineDiffRow[] {
  const nonText = nonTextDiffRows(diff)
  if (nonText) return nonText

  const rows: TimelineDiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let currentFile: string | undefined
  const truncated = diff.length > MAX_RENDER_DIFF_CHARS
  const renderDiff = truncated ? diff.slice(0, MAX_RENDER_DIFF_CHARS) : diff
  const lines = renderDiff.split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  const pushFile = (file: string) => {
    const text = cleanDiffPath(file.trim())
    if (!text || text === "/dev/null" || text === currentFile) return
    currentFile = text
    rows.push({ kind: "file", text })
  }

  for (const line of lines) {
    if (rows.length >= MAX_RENDER_DIFF_ROWS) {
      rows.push({
        kind: "meta",
        text: `${TIMELINE_DIFF_TRUNCATION_PREFIX} too large to render safely (${diff.length.toLocaleString()} chars total). Show more from the full diff.`,
      })
      return rows
    }

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

  if (truncated) {
    rows.push({
      kind: "meta",
      text: `${TIMELINE_DIFF_TRUNCATION_PREFIX} too large to render safely (${diff.length.toLocaleString()} chars total). Show more from the full diff.`,
    })
  }

  return rows
}
