const LIVE_SHELL_OUTPUT_PREVIEW_LIMIT = 30_000
const MAX_TERMINAL_CURSOR_ROWS = 2_000
const MAX_TERMINAL_CURSOR_COLUMNS = LIVE_SHELL_OUTPUT_PREVIEW_LIMIT

function clampLiveShellOutput(output: string) {
  if (output.length <= LIVE_SHELL_OUTPUT_PREVIEW_LIMIT) return output
  return "...\n\n" + output.slice(-LIVE_SHELL_OUTPUT_PREVIEW_LIMIT)
}

export function previewShellOutput(output: string) {
  return clampLiveShellOutput(output)
}

export function selectShellOutput(input: { running: boolean; live?: string; final?: string }) {
  if (input.running) return input.live ?? ""
  return input.final ?? input.live ?? ""
}

export function latestTerminalOutputPreview(text: string, maxLines: number) {
  const lines = text.split("\n")
  const limit = Math.max(1, Math.floor(maxLines))
  if (lines.length <= limit) return { text, overflow: false, hiddenLines: 0 }

  const tail = lines.slice(-limit)
  const hintLines = lines.filter((line) => /(?:full output|output excerpt).*saved to:/i.test(line) || line.includes("...output truncated...")).slice(0, 3)
  const previewLines = ["...", ...hintLines.filter((line) => !tail.includes(line)), ...tail]
  return {
    text: previewLines.join("\n"),
    overflow: true,
    hiddenLines: lines.length - limit,
  }
}

export function renderTerminalOutput(text: string) {
  const lines = [""]
  let row = 0
  let column = 0
  let savedRow = 0
  let savedColumn = 0

  const ensureLine = (index: number) => {
    while (lines.length <= index) lines.push("")
  }

  const clampCursorRow = (value: number) => Math.max(0, Math.min(value, lines.length + MAX_TERMINAL_CURSOR_ROWS))
  const clampColumn = (value: number) => Math.max(0, Math.min(value, MAX_TERMINAL_CURSOR_COLUMNS))
  const currentLine = () => lines[row] ?? ""

  const writeLine = (value: string) => {
    ensureLine(row)
    lines[row] = value
  }

  const csiValue = (params: string[], index: number, fallback: number) => {
    const value = Number.parseInt(params[index] ?? "", 10)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === "\r" && text[index + 1] === "\n") {
      row++
      ensureLine(row)
      column = 0
      index++
      continue
    }
    if (char === "\u001b") {
      const next = text[index + 1]
      if (next === "]") {
        const bell = text.indexOf("\u0007", index + 2)
        const terminator = text.indexOf("\u001b\\", index + 2)
        const end = bell < 0 ? terminator : terminator < 0 ? bell : Math.min(bell, terminator)
        if (end < 0) break
        index = end + (end === terminator ? 1 : 0)
        continue
      }
      if (next === "7") {
        savedRow = row
        savedColumn = column
        index++
        continue
      }
      if (next === "8") {
        row = savedRow
        column = savedColumn
        ensureLine(row)
        index++
        continue
      }
      if (next === "D") {
        row = clampCursorRow(row + 1)
        ensureLine(row)
        index++
        continue
      }
      if (next === "E") {
        row = clampCursorRow(row + 1)
        ensureLine(row)
        column = 0
        index++
        continue
      }
      if (next === "M") {
        row = clampCursorRow(row - 1)
        ensureLine(row)
        index++
        continue
      }
      if (next && "#%".includes(next)) {
        index += 2
        continue
      }
      if (next && "=>Hc".includes(next)) {
        index++
        continue
      }
      if (next && "()*+-. /".includes(next)) {
        index += 2
        continue
      }
      if (next !== "[") continue
      let end = index + 2
      while (end < text.length) {
        const code = text.charCodeAt(end)
        if (code >= 0x40 && code <= 0x7e) break
        end++
      }
      if (end >= text.length) break
      const sequence = text.slice(index, end + 1)
      const final = sequence.at(-1)
      const params = sequence.slice(2, -1).split(";")
      if (final === "s") {
        savedRow = row
        savedColumn = column
      }
      if (final === "u") {
        row = savedRow
        column = savedColumn
        ensureLine(row)
      }
      if (final === "K") {
        const mode = Number.parseInt(params[0] ?? "0", 10) || 0
        const line = currentLine()
        if (mode === 2) writeLine("")
        if (mode === 1) writeLine(" ".repeat(Math.min(column + 1, line.length)) + line.slice(column + 1))
        if (mode === 0) writeLine(line.slice(0, column))
      }
      if (final === "J") {
        const mode = Number.parseInt(params[0] ?? "0", 10) || 0
        if (mode === 2 || mode === 3) {
          lines.splice(0, lines.length, "")
          row = 0
          column = 0
        }
        if (mode === 1) {
          for (let lineIndex = 0; lineIndex < row; lineIndex++) lines[lineIndex] = ""
          writeLine(" ".repeat(Math.min(column + 1, currentLine().length)) + currentLine().slice(column + 1))
        }
        if (mode === 0) {
          writeLine(currentLine().slice(0, column))
          lines.splice(row + 1)
        }
      }
      if (final === "A") {
        row = clampCursorRow(row - csiValue(params, 0, 1))
        ensureLine(row)
      }
      if (final === "B") {
        row = clampCursorRow(row + csiValue(params, 0, 1))
        ensureLine(row)
      }
      if (final === "C") column = clampColumn(column + csiValue(params, 0, 1))
      if (final === "D") column = clampColumn(column - csiValue(params, 0, 1))
      if (final === "E") {
        row = clampCursorRow(row + csiValue(params, 0, 1))
        ensureLine(row)
        column = 0
      }
      if (final === "F") {
        row = clampCursorRow(row - csiValue(params, 0, 1))
        column = 0
      }
      if (final === "G") column = clampColumn(csiValue(params, 0, 1) - 1)
      if (final === "H" || final === "f") {
        row = clampCursorRow(csiValue(params, 0, 1) - 1)
        column = clampColumn(csiValue(params, 1, 1) - 1)
        ensureLine(row)
      }
      if (final === "X") {
        const line = currentLine()
        const count = csiValue(params, 0, 1)
        writeLine(line.slice(0, column) + " ".repeat(Math.min(count, Math.max(0, line.length - column))) + line.slice(column + count))
      }
      index = end
      continue
    }
    if (char === "\r") {
      column = 0
      continue
    }
    if (char === "\n") {
      row++
      ensureLine(row)
      column = 0
      continue
    }
    if (char === "\b") {
      column = clampColumn(column - 1)
      continue
    }
    if (char === "\t") {
      const nextTabColumn = clampColumn(column + (8 - (column % 8)))
      const line = currentLine()
      writeLine(line.padEnd(nextTabColumn, " "))
      column = nextTabColumn
      continue
    }
    if (char < " " && char !== "\t") continue

    const line = currentLine()
    const padded = line.length < column ? line.padEnd(column, " ") : line
    writeLine(padded.slice(0, column) + char + padded.slice(column + 1))
    column = clampColumn(column + 1)
  }

  return lines.join("\n")
}

function replayCandidate(text: string) {
  return text.length >= 4
}

function overlapLength(current: string, delta: string) {
  const max = Math.min(current.length, delta.length)
  for (let size = max; size > 0; size--) {
    if (!replayCandidate(delta.slice(0, size))) continue
    if (current.endsWith(delta.slice(0, size))) return size
  }
  return 0
}

export function appendLiveShellOutput(current: unknown, delta: string, options?: { replayProtection?: boolean }) {
  const existing = String(current ?? "")
  if (!delta) return clampLiveShellOutput(existing)
  if (!existing) return clampLiveShellOutput(delta)
  if (options?.replayProtection === false) return clampLiveShellOutput(existing + delta)

  if (replayCandidate(delta) && existing.endsWith(delta)) return clampLiveShellOutput(existing)
  if (replayCandidate(existing) && delta.startsWith(existing)) return clampLiveShellOutput(delta)

  const overlap = overlapLength(existing, delta)
  if (overlap > 0) return clampLiveShellOutput(existing + delta.slice(overlap))

  return clampLiveShellOutput(existing + delta)
}
