/**
 * Multiline prompt editor (S4). Positions are grapheme indices so accents and emoji move as one unit.
 * Pure state: key handling returns what happened; rendering is elsewhere.
 */
import { EDIT_KEYS, type EditAction } from "./editor-actions"
import { textWidth } from "./wrap"
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
/** Exported so other pure view modules (mentions) index text the same way the editor does. */
export const graphemes = (text: string) => [...segmenter.segment(text)].map((s) => s.segment)

export type EditorAction = "submit" | "changed" | "none"

/** Undo steps kept; older ones are dropped. */
export const EDIT_HISTORY_LIMIT = 200

type Snapshot = { text: string; row: number; col: number }
/** What the last edit was, so a run of word characters or of backspaces is one undo step. `move` ends a run; `kill` and `yank` chain the kill ring. */
type EditKind = "type" | "space" | "delete" | "other" | "move" | "kill" | "yank"

/** Kills kept for yank; the oldest goes first. */
export const KILL_RING_LIMIT = 30

/** A run of graphemes the editor treats as one character: an inline attachment token such as `[Image #1]`. Offsets are into the whole text. */
export type TokenSpan = { start: number; end: number }

const NO_SPANS: readonly TokenSpan[] = []

/**
 * Where any of `labels` stands in `text`, as grapheme ranges in order. A label that is not on grapheme boundaries (it follows a
 * combining mark) is not a token; two labels that overlap keep the first.
 */
export function tokenSpans(text: string, labels: readonly string[]): TokenSpan[] {
  if (!text || !labels.length) return []
  const hits: Array<{ from: number; to: number }> = []
  for (const label of labels) {
    if (!label) continue
    for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + label.length)) hits.push({ from: at, to: at + label.length })
  }
  if (!hits.length) return []
  hits.sort((a, b) => a.from - b.from)
  const wanted = new Set<number>()
  for (const hit of hits) (wanted.add(hit.from), wanted.add(hit.to))
  const last = hits.reduce((max, hit) => Math.max(max, hit.to), 0)
  const at = new Map<number, number>()
  let units = 0
  let index = 0
  for (const piece of segmenter.segment(text)) {
    if (wanted.has(units)) at.set(units, index)
    units += piece.segment.length
    index++
    if (units > last) break
  }
  if (wanted.has(units)) at.set(units, index)
  const out: TokenSpan[] = []
  for (const hit of hits) {
    const start = at.get(hit.from)
    const end = at.get(hit.to)
    if (start === undefined || end === undefined || start === end || (out.length && start < out[out.length - 1]!.end)) continue
    out.push({ start, end })
  }
  return out
}

/** Lossless visual rows with grapheme offsets: spaces remain editable, only oversized words hard-break. A token is never split across rows unless it is wider than a row. */
export function editorRows(text: string, width: number, wordWrap = false, tokens: readonly TokenSpan[] = NO_SPANS) {
  const out: Array<{ text: string; start: number; end: number }> = []
  let offset = 0
  for (const raw of text.split("\n")) {
    const chars = graphemes(raw)
    let start = 0
    do {
      let end = start
      let used = 0
      let boundary = start
      while (end < chars.length && used + textWidth(chars[end]!) <= width) {
        used += textWidth(chars[end]!)
        // A space inside a token is not a place to break.
        if (/\s/u.test(chars[end]!) && !tokens.some((span) => span.start <= offset + end && offset + end < span.end)) boundary = end + 1
        end++
      }
      if (wordWrap && end < chars.length && !/\s/u.test(chars[end]!) && boundary > start) end = boundary
      // The row ends where the cut would fall inside a token; the token starts the next row.
      const cut = tokens.find((span) => span.start < offset + end && offset + end < span.end && span.start - offset > start)
      if (cut) end = cut.start - offset
      if (end === start && end < chars.length) end++
      out.push({ text: chars.slice(start, end).join(""), start: offset + start, end: offset + end })
      start = end
    } while (start < chars.length)
    offset += chars.length + 1
  }
  return out
}

export type EditorRow = ReturnType<typeof editorRows>[number]

/** The visual row a cursor at grapheme offset `at` is drawn on: a soft wrap's boundary offset belongs to the row that starts there. */
export const rowIndexAt = (rows: readonly EditorRow[], at: number) => Math.max(0, rows.findLastIndex((row) => row.start <= at))

/**
 * The furthest offset a cursor can take on row `index`. A row that wraps into the next one ends one grapheme early (its own end is
 * the next row's start); the last row of a line may end past its last grapheme, except in vim's normal mode, which rests on a character.
 */
export function rowLimit({ rows, index, normal = false }: { rows: readonly EditorRow[]; index: number; normal?: boolean }) {
  const row = rows[index]!
  const wraps = rows[index + 1]?.start === row.end
  return row.end > row.start && (wraps || normal) ? row.end - 1 : row.end
}

/** The offset on row `index` drawn at cell `column` (the grapheme under that cell, or the row's limit past its text). */
export function offsetAtColumn({ rows, chars, index, column, normal = false }: { rows: readonly EditorRow[]; chars: readonly string[]; index: number; column: number; normal?: boolean }) {
  const limit = rowLimit({ rows, index, normal })
  let at = rows[index]!.start
  let used = 0
  while (at < limit && used + textWidth(chars[at]!) <= column) used += textWidth(chars[at++]!)
  return at
}

/** Cells between the start of the cursor's row and grapheme offset `at`. */
export function columnOf({ rows, chars, at }: { rows: readonly EditorRow[]; chars: readonly string[]; at: number }) {
  let used = 0
  for (let i = rows[rowIndexAt(rows, at)]!.start; i < at; i++) used += textWidth(chars[i]!)
  return used
}

/**
 * Moves `count` visual rows up (-1) or down (1) from offset `at`, keeping the cell column `goal` (the cursor's own column when none is
 * given) so a short row in between does not lose it. Wrapped rows count as rows and wide characters take their two cells. Undefined when
 * there is no row to move to; a count that runs past the edge stops at the last row.
 */
export function stepRows({ rows, chars, at, direction, goal, count = 1, normal = false }: { rows: readonly EditorRow[]; chars: readonly string[]; at: number; direction: -1 | 1; goal?: number; count?: number; normal?: boolean }) {
  const from = rowIndexAt(rows, at)
  const index = Math.max(0, Math.min(rows.length - 1, from + direction * count))
  if (index === from) return undefined
  const column = goal ?? columnOf({ rows, chars, at })
  return { target: offsetAtColumn({ rows, chars, index, column, normal }), goal: column }
}

/**
 * `tokens` names the inline attachment tokens the text may hold (`[Image #1]`): wherever one of those labels stands in the text it is
 * one character. The cursor never rests inside it, a deletion takes all of it, a word motion steps over it and a row break never cuts it.
 * The text is plain text with the label in it, so copying, history and undo need no knowledge of tokens.
 */
export function createEditor(options: { wordWrap?: boolean; tokens?: () => readonly string[] } = {}) {
  let lines: string[][] = [[]]
  let row = 0
  let col = 0
  let past: Snapshot[] = []
  let future: Snapshot[] = []
  let lastKind: EditKind = "move"
  let anchor: number | undefined
  let visualWidth = 80
  /** Killed text, newest first. Consecutive kills grow the newest entry; a yank-pop walks `ringAt` back through the rest. */
  let ring: string[] = []
  let ringAt = 0
  let yanked: { start: number; end: number } | undefined
  /** Set by `jump-forward` / `jump-backward`: the next character typed is the target. */
  let jump: 1 | -1 | undefined
  /** The cell column ↑/↓ keep across rows, and the offset the last vertical move left the cursor on (any other move or edit makes it stale). */
  let goal: { column: number; at: number } | undefined

  const current = () => lines[row]!
  const textOf = () => lines.map((l) => l.join("")).join("\n")
  const offset = () => lines.slice(0, row).reduce((sum, line) => sum + line.length + 1, 0) + col
  const range = () => anchor === undefined || anchor === offset() ? undefined : { start: Math.min(anchor, offset()), end: Math.max(anchor, offset()) }
  /** The token spans of the current text; recomputed only when the text or the label list changed. */
  let spanCache: { text: string; labels: string; spans: readonly TokenSpan[] } | undefined
  function spans(): readonly TokenSpan[] {
    const labels = options.tokens?.()
    if (!labels?.length) return NO_SPANS
    const text = textOf()
    const key = labels.join("\u0000")
    if (spanCache?.text === text && spanCache.labels === key) return spanCache.spans
    spanCache = { text, labels: key, spans: tokenSpans(text, labels) }
    return spanCache.spans
  }
  /** The token an offset is strictly inside of (its two edges are legal cursor places). */
  const spanAround = (at: number) => spans().find((span) => span.start < at && at < span.end)
  /** A cursor target inside a token goes to the edge in the direction of travel. */
  const snapTo = (at: number, from: number) => {
    const span = spanAround(at)
    return span ? (at > from ? span.end : span.start) : at
  }
  /** [from, to) grown to take every token it touches whole. */
  function widen(from: number, to: number): [number, number] {
    let a = from
    let b = to
    for (const span of spans()) if (span.start < to && span.end > from) (a = Math.min(a, span.start), b = Math.max(b, span.end))
    return [a, b]
  }
  /** After a change that placed the cursor anywhere: out of a token, to its nearer edge. */
  function settleCursor() {
    const at = offset()
    const span = spanAround(at)
    if (span) seek(at - span.start < span.end - at ? span.start : span.end)
  }
  function seek(index: number) {
    row = 0
    while (row < lines.length - 1 && index > lines[row]!.length) index -= lines[row++]!.length + 1
    col = Math.max(0, Math.min(index, current().length))
  }
  function erase(rawFrom: number, rawTo: number) {
    const [from, to] = widen(rawFrom, rawTo)
    const chars = graphemes(textOf())
    chars.splice(from, to - from)
    lines = chars.join("").split("\n").map(graphemes)
    seek(from)
    anchor = undefined
  }
  function eraseSelection() {
    const selected = range()
    if (selected) erase(selected.start, selected.end)
    anchor = undefined
    return !!selected
  }

  /**
   * Runs an edit and, when it changed the text, records the state before it. Word characters typed one after the
   * other (a space starts the next step) and consecutive deletions share one step; anything else is its own.
   */
  function mutate(kind: Exclude<EditKind, "move">, edit: () => void) {
    const before: Snapshot = { text: textOf(), row, col }
    edit()
    if (textOf() === before.text) return
    const joins = (kind === "type" && (lastKind === "type" || lastKind === "space")) || (kind === "delete" && lastKind === "delete")
    lastKind = kind
    future = []
    if (joins && past.length > 0) return
    past.push(before)
    if (past.length > EDIT_HISTORY_LIMIT) past = past.slice(-EDIT_HISTORY_LIMIT)
  }

  function restore(snapshot: Snapshot) {
    anchor = undefined
    lines = snapshot.text.split("\n").map((line) => graphemes(line))
    row = Math.min(snapshot.row, lines.length - 1)
    col = Math.min(snapshot.col, current().length)
    lastKind = "move"
    settleCursor()
  }

  function insertText(text: string) {
    eraseSelection()
    // Text never lands inside a token: it goes after it.
    const inside = spanAround(offset())
    if (inside) seek(inside.end)
    const parts = text.replace(/\r\n?/g, "\n").split("\n")
    parts.forEach((part, index) => {
      if (index > 0) newline()
      const chars = graphemes(part).filter((g) => g >= " " || g === "\t")
      current().splice(col, 0, ...chars)
      col += chars.length
    })
  }

  function newline() {
    const tail = current().splice(col)
    lines.splice(row + 1, 0, tail)
    row++
    col = 0
  }

  function backspace() {
    if (col > 0) {
      current().splice(--col, 1)
    } else if (row > 0) {
      const line = lines.splice(row, 1)[0]!
      row--
      col = current().length
      current().push(...line)
    }
  }

  function deleteWord() {
    const line = current()
    let start = col
    while (start > 0 && line[start - 1] === " ") start--
    while (start > 0 && line[start - 1] !== " ") start--
    line.splice(start, col - start)
    col = start
  }

  /** The offset one visual row up or down from the cursor, keeping the sticky goal column; undefined at the first or last row. */
  function moveRows(direction: -1 | 1) {
    const here = offset()
    const moved = stepRows({ rows: visualLines(), chars: graphemes(textOf()), at: here, direction, ...(goal?.at === here ? { goal: goal.column } : {}) })
    if (moved) goal = { column: moved.goal, at: moved.target }
    return moved?.target
  }

  function action(name: EditAction): EditorAction {
    const selecting = name.startsWith("select-")
    const base = selecting ? name.slice(7) : name
    const before = offset()
    const chars = graphemes(textOf())
    let target = before
    // The spaces inside a token do not end a word: `[Image #1]` is one.
    const tokenSpaces = new Set<number>()
    for (const span of spans()) for (let i = span.start; i < span.end; i++) tokenSpaces.add(i)
    const word = (direction: number) => {
      let at = before
      const blank = (index: number) => index >= 0 && index < chars.length && /\s/u.test(chars[index]!) && !tokenSpaces.has(index)
      if (direction > 0) {
        while (at < chars.length && !blank(at)) at++
        while (at < chars.length && blank(at)) at++
      } else {
        while (at > 0 && blank(at - 1)) at--
        while (at > 0 && !blank(at - 1)) at--
      }
      return at
    }
    if (base !== "jump-forward" && base !== "jump-backward") jump = undefined
    if (base === "yank" || base === "yank-pop") {
      if (base === "yank" ? ring.length === 0 : lastKind !== "yank" || !yanked || ring.length < 2) return "none"
      mutate("yank", () => {
        eraseSelection()
        const at = offset()
        const from = base === "yank" ? at : yanked!.start
        const to = base === "yank" ? at : yanked!.end
        if (base === "yank") ringAt = 0
        else ringAt = (ringAt + 1) % ring.length
        const text = graphemes(ring[ringAt]!)
        const chars = graphemes(textOf())
        chars.splice(from, to - from, ...text)
        lines = chars.join("").split("\n").map(graphemes)
        seek(from + text.length)
        yanked = { start: from, end: from + text.length }
      })
      return "changed"
    }
    if (base === "jump-forward" || base === "jump-backward") {
      jump = base === "jump-forward" ? 1 : -1
      anchor = undefined
      return "none"
    }
    if (base.startsWith("delete") || base === "backspace" || base === "newline") {
      let killed = false
      mutate(base === "backspace" ? "delete" : "other", () => {
        if (base === "newline") { eraseSelection(); newline(); return }
        if (eraseSelection()) return
        if (base === "backspace") return spans().length ? erase(Math.max(0, before - 1), before) : backspace()
        if (base === "delete") return erase(before, Math.min(chars.length, before + 1))
        const chained = lastKind === "kill"
        const kill = (rawFrom: number, rawTo: number) => {
          const [from, to] = widen(rawFrom, rawTo)
          if (to > from) {
            killed = true
            const text = chars.slice(from, to).join("")
            if (chained && ring.length > 0) ring[0] = from < before ? text + ring[0] : ring[0] + text
            else ring = [text, ...ring].slice(0, KILL_RING_LIMIT)
            ringAt = 0
          }
          erase(from, to)
        }
        if (base === "delete-word-forward") return kill(before, word(1))
        if (base === "delete-word-backward") return kill(word(-1), before)
        if (base === "delete-to-line-end") return kill(before, before - col + current().length)
        if (base === "delete-to-line-start") return kill(before - col, before)
        const start = before - col
        kill(start, start + current().length + (row < lines.length - 1 ? 1 : 0))
      })
      if (killed) lastKind = "kill"
      return "changed"
    }
    if (selecting) anchor ??= before
    else anchor = undefined
    if (base === "move-left" || base === "left") target = Math.max(0, before - 1)
    else if (base === "move-right" || base === "right") target = Math.min(chars.length, before + 1)
    else if (base === "move-up" || base === "up" || base === "move-down" || base === "down") {
      const moved = moveRows(base.endsWith("up") ? -1 : 1)
      if (!moved) return "none"
      target = moved
    } else if (base === "line-home") target = before - col
    else if (base === "line-end") target = before - col + current().length
    else if (base === "buffer-home") target = 0
    else if (base === "buffer-end") target = chars.length
    else if (base === "word-forward") target = word(1)
    else if (base === "word-backward") target = word(-1)
    else if (base === "visual-line-home" || base === "visual-line-end") {
      const visual = visualLines().findLast((line) => line.start <= before)!
      target = base.endsWith("home") ? visual.start : visual.end
    }
    seek(snapTo(target, before))
    lastKind = "move"
    return "changed"
  }

  function visualLines() {
    return editorRows(textOf(), visualWidth, options.wordWrap, spans())
  }

  return {
    action,
    visualLines,
    /** Whether the cursor has a visual row above (-1) or below (1) it: where ↑/↓ stop moving and the prompt's history takes over. */
    canMoveRows(direction: -1 | 1) {
      const rows = visualLines()
      const index = rowIndexAt(rows, offset())
      return direction < 0 ? index > 0 : index < rows.length - 1
    },
    /** `stepRows` over the current text and wrap width, for a caller that keeps its own goal column (vim's `j` and `k`). */
    stepRows(options: { at: number; direction: -1 | 1; goal?: number; count?: number; normal?: boolean }) {
      return stepRows({ rows: visualLines(), chars: graphemes(textOf()), ...options })
    },
    get cursorOffset() { return offset() },
    setVisualWidth(width: number) { visualWidth = Math.max(1, width) },
    get selection() { return range() },
    get selectedText() { const selected = range(); return selected ? graphemes(textOf()).slice(selected.start, selected.end).join("") : "" },
    get text() {
      return textOf()
    },
    get cursor() {
      return { row, col }
    },
    lines: () => lines.map((l) => l.join("")),
    clear() {
      mutate("other", () => {
        anchor = undefined
        lines = [[]]
        row = 0
        col = 0
      })
    },
    isEmpty() {
      return lines.length === 1 && lines[0]!.length === 0
    },
    insert(text: string) {
      mutate("other", () => insertText(text))
    },
    /** The tokens the text holds now, as grapheme ranges. */
    get tokens(): readonly TokenSpan[] {
      return spans()
    },
    /**
     * Puts `label` (one of the `tokens` labels) at the cursor as one undo step. A space goes before it unless the cursor follows a
     * space or starts a line, and after it unless a space or a line break follows; at the very end the space is for what comes next.
     */
    insertToken(label: string) {
      mutate("other", () => {
        eraseSelection()
        const inside = spanAround(offset())
        if (inside) seek(inside.end)
        const line = current()
        const before = col > 0 ? line[col - 1] : undefined
        const after = col < line.length ? line[col] : undefined
        const lead = before !== undefined && !/\s/u.test(before) ? " " : ""
        const trail = after === undefined ? (row === lines.length - 1 ? " " : "") : /\s/u.test(after) ? "" : " "
        insertText(`${lead}${label}${trail}`)
      })
    },
    /** Replaces graphemes [start, end) of the current row with `text` and places the cursor right after it (mention/command completion). */
    replaceCurrentLine(start: number, end: number, text: string) {
      mutate("other", () => {
        const chars = graphemes(text)
        current().splice(start, end - start, ...chars)
        col = start + chars.length
      })
    },
    /** Replaces the whole text in one undo step and puts the cursor at its end (a stash restore, the external editor's result). */
    replaceAll(text: string) {
      mutate("other", () => {
        anchor = undefined
        lines = [[]]
        row = 0
        col = 0
        insertText(text)
      })
    },
    /** Puts the cursor at a grapheme offset; `extend` keeps (or starts) the selection from where it was. Vim mode moves with this. */
    moveTo(target: number, extend = false) {
      if (extend) anchor ??= offset()
      else anchor = undefined
      seek(snapTo(Math.max(0, Math.min(target, graphemes(textOf()).length)), offset()))
      lastKind = "move"
    },
    /** Selects from `from` to `to` (grapheme offsets) with the cursor at `to`; a token at either end is taken whole. */
    select(from: number, to: number) {
      const size = graphemes(textOf()).length
      const a = Math.max(0, Math.min(from, size))
      const b = Math.max(0, Math.min(to, size))
      const [low, high] = widen(Math.min(a, b), Math.max(a, b))
      anchor = a <= b ? low : high
      seek(a <= b ? high : low)
      lastKind = "move"
    },
    /** Replaces graphemes [start, end) with `text` in one undo step; the cursor goes to `cursor`, else right after the text. A token the range touches goes whole; text inserted inside one goes after it. */
    replaceRange(start: number, end: number, text: string, cursor?: number) {
      mutate("other", () => {
        anchor = undefined
        const inside = start === end ? spanAround(start) : undefined
        const [from, to] = inside ? [inside.end, inside.end] : widen(start, end)
        const chars = graphemes(textOf())
        const inserted = graphemes(text)
        chars.splice(from, to - from, ...inserted)
        lines = chars.join("").split("\n").map(graphemes)
        seek(cursor === undefined ? from + inserted.length : Math.max(0, cursor + (from - start)))
        settleCursor()
      })
    },
    /** Steps back to the state before the last edit (or run of typing); false when there is nothing to undo. */
    undo() {
      const target = past.pop()
      if (!target) return false
      future.push({ text: textOf(), row, col })
      restore(target)
      return true
    },
    /** Re-applies the last undone edit; false when nothing was undone since the last edit. */
    redo() {
      const target = future.pop()
      if (!target) return false
      past.push({ text: textOf(), row, col })
      restore(target)
      return true
    },
    get canUndo() {
      return past.length > 0
    },
    get canRedo() {
      return future.length > 0
    },
    /** Killed texts, newest first (the kill ring `yank` reads). */
    get killRing(): readonly string[] {
      return ring
    },
    /** True after `jump-forward` / `jump-backward`, until a character is given or `cancelJump` runs. */
    get jumpPending() {
      return jump !== undefined
    },
    /** Moves to the next (or previous) occurrence of `char` on the cursor's line, as readline's character search; false when there is none. */
    jumpTo(char: string) {
      const direction = jump
      jump = undefined
      if (!direction || [...graphemes(char)].length !== 1) return false
      const line = current()
      let at = direction > 0 ? col + 1 : col - 1
      while (at >= 0 && at < line.length && line[at] !== char) at += direction
      if (at < 0 || at >= line.length) return false
      anchor = undefined
      col = at
      settleCursor()
      lastKind = "move"
      return true
    },
    cancelJump() {
      jump = undefined
    },
    /** Forgets every undo and redo step (the text stays). */
    resetHistory() {
      anchor = undefined
      past = []
      future = []
      lastKind = "move"
    },
    /** Maps a raw terminal key sequence to an edit. Unknown sequences are ignored, never inserted. */
    key(seq: string): EditorAction {
      if (EDIT_KEYS[seq]) return action(EDIT_KEYS[seq]!)
      const move = (run: () => void): EditorAction => {
        run()
        lastKind = "move"
        return "changed"
      }
      switch (seq) {
        case "\r":
          return "submit"
        case "\x1b\r":
        case "\n":
          mutate("other", newline)
          return "changed"
        case "\x7f":
        case "\b":
          mutate("delete", backspace)
          return "changed"
        case "\x1b[3~":
          mutate("delete", () => {
            if (col < current().length) current().splice(col, 1)
            else if (row < lines.length - 1) current().push(...lines.splice(row + 1, 1)[0]!)
          })
          return "changed"
        case "\x1b[D":
          return move(() => {
            if (col > 0) col--
            else if (row > 0) (row--, (col = current().length))
          })
        case "\x1b[C":
          return move(() => {
            if (col < current().length) col++
            else if (row < lines.length - 1) (row++, (col = 0))
          })
        case "\x01":
        case "\x1b[H":
          return move(() => void (col = 0))
        case "\x05":
        case "\x1b[F":
          return move(() => void (col = current().length))
        case "\x15":
          mutate("other", () => {
            current().splice(0, col)
            col = 0
          })
          return "changed"
        case "\x17":
          mutate("other", deleteWord)
          return "changed"
      }
      if (seq.startsWith("\x1b") || seq < " ") return "none"
      // One typed character is a step shared with its word; a paste (several characters) is a step of its own.
      mutate([...seq].length > 1 ? "other" : seq === " " || seq === "\t" ? "space" : "type", () => insertText(seq))
      return "changed"
    },
  }
}
export type Editor = ReturnType<typeof createEditor>
