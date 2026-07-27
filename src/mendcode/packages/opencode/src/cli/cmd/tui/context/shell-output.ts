const LIVE_SHELL_OUTPUT_PREVIEW_LIMIT = 30_000
const MAX_TERMINAL_CURSOR_ROWS = 2_000
const MAX_TERMINAL_CURSOR_COLUMNS = LIVE_SHELL_OUTPUT_PREVIEW_LIMIT
const MAX_RENDERED_TERMINAL_CELLS = LIVE_SHELL_OUTPUT_PREVIEW_LIMIT + 5
const MAX_TERMINAL_PREVIEW_LINE_CHARS = 2_048
const MAX_REPLAY_OVERLAP = 8_192

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
  const input = clampLiveShellOutput(text)
  const lines = input.split("\n")
  const limit = Math.max(1, Math.floor(maxLines))
  const hasOversizedLine = lines.some((line) => line.length > MAX_TERMINAL_PREVIEW_LINE_CHARS)
  if (lines.length <= limit && !hasOversizedLine) return { text: input, overflow: false, hiddenLines: 0 }

  const tail = lines.slice(-limit).map((line) => {
    if (line.length <= MAX_TERMINAL_PREVIEW_LINE_CHARS) return line
    return "..." + line.slice(-MAX_TERMINAL_PREVIEW_LINE_CHARS)
  })
  const hintLines = lines.filter((line) => /(?:full output|output excerpt).*saved to:/i.test(line) || line.includes("...output truncated...")).slice(0, 3)
  const previewLines = ["...", ...hintLines.filter((line) => !tail.includes(line)), ...tail]
  return {
    text: previewLines.join("\n"),
    overflow: true,
    hiddenLines: lines.length - limit,
  }
}

export function renderTerminalOutput(text: string) {
  const input = clampLiveShellOutput(text)
  const lines: string[][] = [[]]
  let row = 0
  let column = 0
  let savedRow = 0
  let savedColumn = 0
  let renderedCells = 0

  const ensureLine = (index: number) => {
    while (lines.length <= index) lines.push([])
  }

  const clampCursorRow = (value: number) => Math.max(0, Math.min(value, lines.length + MAX_TERMINAL_CURSOR_ROWS))
  const clampColumn = (value: number) => Math.max(0, Math.min(value, MAX_TERMINAL_CURSOR_COLUMNS))
  const currentLine = () => {
    ensureLine(row)
    return lines[row]!
  }

  const fill = (line: string[], start: number, end: number, value: string) => {
    const from = Math.max(0, start)
    const to = Math.min(end, line.length, MAX_TERMINAL_CURSOR_COLUMNS + 1)
    for (let index = from; index < to; index++) line[index] = value
  }

  const extend = (line: string[], end: number) => {
    const to = Math.min(
      end,
      MAX_TERMINAL_CURSOR_COLUMNS + 1,
      line.length + Math.max(0, MAX_RENDERED_TERMINAL_CELLS - renderedCells),
    )
    if (to <= line.length) return
    const previousLength = line.length
    line.length = to
    renderedCells += to - previousLength
    fill(line, previousLength, to, " ")
  }

  const truncate = (line: string[], length: number) => {
    const nextLength = Math.max(0, Math.min(length, line.length))
    renderedCells -= line.length - nextLength
    line.length = nextLength
  }

  const writeCharacter = (value: string) => {
    const line = currentLine()
    extend(line, column + 1)
    if (column >= line.length) return
    line[column] = value
    column = clampColumn(column + 1)
  }

  const csiValue = (params: string[], index: number, fallback: number) => {
    const value = Number.parseInt(params[index] ?? "", 10)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (char === "\r" && input[index + 1] === "\n") {
      row++
      ensureLine(row)
      column = 0
      index++
      continue
    }
    if (char === "\u001b") {
      const next = input[index + 1]
      if (next === "]") {
        const bell = input.indexOf("\u0007", index + 2)
        const terminator = input.indexOf("\u001b\\", index + 2)
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
      while (end < input.length) {
        const code = input.charCodeAt(end)
        if (code >= 0x40 && code <= 0x7e) break
        end++
      }
      if (end >= input.length) break
      const sequence = input.slice(index, end + 1)
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
        if (mode === 2) truncate(line, 0)
        if (mode === 1) fill(line, 0, column + 1, " ")
        if (mode === 0) truncate(line, column)
      }
      if (final === "J") {
        const mode = Number.parseInt(params[0] ?? "0", 10) || 0
        if (mode === 2 || mode === 3) {
          renderedCells = 0
          lines.splice(0, lines.length, [])
          row = 0
          column = 0
        }
        if (mode === 1) {
          for (let lineIndex = 0; lineIndex < row; lineIndex++) {
            renderedCells -= lines[lineIndex]?.length ?? 0
            lines[lineIndex] = []
          }
          fill(currentLine(), 0, column + 1, " ")
        }
        if (mode === 0) {
          truncate(currentLine(), column)
          const removed = lines.splice(row + 1)
          renderedCells -= removed.reduce((sum, line) => sum + line.length, 0)
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
        fill(line, column, column + Math.min(count, Math.max(0, line.length - column)), " ")
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
      extend(currentLine(), nextTabColumn)
      column = nextTabColumn
      continue
    }
    if (char < " " && char !== "\t") continue

    writeCharacter(char)
  }

  const rendered = lines.map((line) => line.join(""))
  const visible = rendered.length > MAX_TERMINAL_CURSOR_ROWS ? rendered.slice(-MAX_TERMINAL_CURSOR_ROWS) : rendered
  return visible.join("\n")
}

function replayCandidate(text: string) {
  return text.length >= 4
}

function overlapLength(current: string, delta: string) {
  const max = Math.min(current.length, delta.length, MAX_REPLAY_OVERLAP)
  if (max < 4) return 0

  const prefix = delta.slice(0, max)
  const table = new Array<number>(max).fill(0)
  for (let index = 1, size = 0; index < max; index++) {
    while (size > 0 && prefix[index] !== prefix[size]) size = table[size - 1] ?? 0
    if (prefix[index] === prefix[size]) size++
    table[index] = size
  }

  let size = 0
  const suffix = current.slice(-max)
  for (let index = 0; index < suffix.length; index++) {
    const char = suffix[index]
    while (size > 0 && char !== prefix[size]) size = table[size - 1] ?? 0
    if (char === prefix[size]) size++
    if (size === max) return max
  }
  return size >= 4 ? size : 0
}

export function appendLiveShellOutput(current: unknown, delta: string, options?: { replayProtection?: boolean }) {
  const existing = clampLiveShellOutput(String(current ?? ""))
  if (!delta) return clampLiveShellOutput(existing)
  const incoming = clampLiveShellOutput(delta)
  if (!existing) return incoming
  if (options?.replayProtection === false) return clampLiveShellOutput(existing + incoming)

  if (replayCandidate(incoming) && existing.endsWith(incoming)) return clampLiveShellOutput(existing)
  if (replayCandidate(existing) && incoming.startsWith(existing)) return clampLiveShellOutput(incoming)

  const overlap = overlapLength(existing, incoming)
  if (overlap > 0) return clampLiveShellOutput(existing + incoming.slice(overlap))

  return clampLiveShellOutput(existing + incoming)
}
