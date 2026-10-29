/**
 * Vim mode for the prompt composer (`/vim`). A small modal layer over the editor: normal, insert, visual and visual-line,
 * counts, the common motions, operators d c y with motions and text objects, put, undo/redo and dot repeat.
 * Pure state: `key()` says whether the key was consumed ("handled") or should go on to the prompt ("pass"); the app
 * shows `label` in the prompt chrome and `cursorShape` for the terminal cursor.
 */
import { graphemes, type Editor } from "./editor"

export type VimMode = "insert" | "normal" | "visual" | "visual-line"
export type VimResult = "handled" | "pass"

type Operator = "d" | "c" | "y"
type Register = { text: string; linewise: boolean }
type Motion = { target: number; linewise?: boolean; inclusive?: boolean }
type Parsed = { count: number; counted: boolean; op?: Operator; cmd: string; arg?: string }

const ESC = "\x1b"
const REDO = "\x12"
const MOTIONS = new Set(["h", "l", "j", "k", "w", "b", "e", "0", "^", "$", "gg", "G", "f", "F", "t", "T"])
const CHANGES = new Set(["i", "a", "I", "A", "o", "O", "x", "X", "D", "C", "s", "S", "p", "P", "r"])
const ARROWS: Readonly<Record<string, string>> = { "\x1b[D": "h", "\x1bOD": "h", "\x1b[C": "l", "\x1bOC": "l", "\x1b[A": "k", "\x1bOA": "k", "\x1b[B": "j", "\x1bOB": "j", "\x7f": "h" }

const klass = (char: string) => (/\s/u.test(char) ? 0 : /[\p{L}\p{N}_]/u.test(char) ? 1 : 2)

/** Line geometry of one text: offsets are grapheme indexes, the same ones the editor uses. */
function model(chars: string[], tokens: readonly { start: number; end: number }[] = []) {
  const size = chars.length
  /** What a word motion sees: an attachment token is one word of letters, whatever its label is made of. */
  const kinds = tokens.length ? chars.map((char, index) => (tokens.some((span) => index >= span.start && index < span.end) ? "a" : char)) : chars
  const starts = [0]
  chars.forEach((char, index) => char === "\n" && starts.push(index + 1))
  const lineOf = (at: number) => Math.max(0, starts.findLastIndex((start) => start <= at))
  const lineStart = (at: number) => starts[lineOf(at)]!
  const lineEnd = (at: number) => {
    let end = Math.min(at, size)
    while (end < size && chars[end] !== "\n") end++
    return end
  }
  const firstNonBlank = (at: number) => {
    const start = lineStart(at)
    const end = lineEnd(at)
    let k = start
    while (k < end && /[ \t]/.test(chars[k]!)) k++
    return k < end ? k : Math.max(start, end - 1)
  }
  const emptyLineAt = (at: number) => chars[at] === "\n" && (at === 0 || chars[at - 1] === "\n")
  return { chars, kinds, size, starts, lineOf, lineStart, lineEnd, firstNonBlank, emptyLineAt }
}
type Model = ReturnType<typeof model>

function wordForward({ m, from, count }: { m: Model; from: number; count: number }) {
  let i = from
  for (let step = 0; step < count && i < m.size; step++) {
    const c = klass(m.kinds[i]!)
    if (c !== 0) while (i < m.size && klass(m.kinds[i]!) === c) i++
    else i++
    while (i < m.size && klass(m.kinds[i]!) === 0 && !m.emptyLineAt(i)) i++
  }
  return i
}

function wordBackward({ m, from, count }: { m: Model; from: number; count: number }) {
  let i = from
  for (let step = 0; step < count && i > 0; step++) {
    i--
    while (i > 0 && klass(m.kinds[i]!) === 0 && !m.emptyLineAt(i)) i--
    const c = klass(m.kinds[i]!)
    if (c !== 0) while (i > 0 && klass(m.kinds[i - 1]!) === c) i--
  }
  return i
}

function wordEnd({ m, from, count }: { m: Model; from: number; count: number }) {
  let i = from
  for (let step = 0; step < count && i < m.size - 1; step++) {
    i++
    while (i < m.size && klass(m.kinds[i]!) === 0) i++
    if (i >= m.size) return m.size - 1
    const c = klass(m.kinds[i]!)
    while (i + 1 < m.size && klass(m.kinds[i + 1]!) === c) i++
  }
  return i
}

/** Where a motion lands. `forOp` lets `l` and `$` reach the line end, as an operator needs. Undefined: the motion cannot move. */
function motionTarget(input: { m: Model; key: string; count: number; counted: boolean; at: number; want: number; arg?: string; forOp?: boolean }): Motion | undefined {
  const { m, key, count, counted, at, want, arg, forOp } = input
  const start = m.lineStart(at)
  const end = m.lineEnd(at)
  const last = m.starts.length - 1
  switch (key) {
    case "h": return at <= start ? undefined : { target: Math.max(start, at - count) }
    case "l": {
      const limit = forOp ? end : Math.max(start, end - 1)
      return at >= limit ? undefined : { target: Math.min(limit, at + count) }
    }
    case "j":
    case "k": {
      const line = m.lineOf(at)
      const to = Math.max(0, Math.min(last, line + (key === "j" ? count : -count)))
      if (to === line) return undefined
      const from = m.starts[to]!
      const to_end = m.lineEnd(from)
      return { target: Math.min(from + want, forOp ? to_end : Math.max(from, to_end - 1)), linewise: true }
    }
    case "w": {
      const target = wordForward({ m, from: at, count })
      return target === at ? undefined : { target: forOp ? target : Math.min(target, Math.max(0, m.size - 1)) }
    }
    case "b": {
      const target = wordBackward({ m, from: at, count })
      return target === at ? undefined : { target }
    }
    case "e": {
      const target = wordEnd({ m, from: at, count })
      return target === at && !forOp ? undefined : { target, inclusive: true }
    }
    case "0": return { target: start }
    case "^": return { target: m.firstNonBlank(at) }
    case "$": {
      const to = m.starts[Math.min(last, m.lineOf(at) + count - 1)]!
      const to_end = m.lineEnd(to)
      return to_end > to ? { target: to_end - 1, inclusive: true } : { target: to }
    }
    case "gg":
    case "G": {
      const line = counted ? Math.min(last, count - 1) : key === "gg" ? 0 : last
      return { target: m.firstNonBlank(m.starts[line]!), linewise: true }
    }
    case "f":
    case "t": {
      let found = at
      for (let n = 0; n < count; n++) {
        found++
        while (found < end && m.chars[found] !== arg) found++
        if (found >= end) return undefined
      }
      return { target: key === "t" ? found - 1 : found, inclusive: true }
    }
    case "F":
    case "T": {
      let found = at
      for (let n = 0; n < count; n++) {
        found--
        while (found >= start && m.chars[found] !== arg) found--
        if (found < start) return undefined
      }
      return { target: key === "T" ? found + 1 : found }
    }
  }
  return undefined
}

/** `iw` / `aw` around `at`: the word (or blank run) under the cursor, with its trailing blanks for `aw`. */
function wordObject({ m, at, around }: { m: Model; at: number; around: boolean }): { start: number; end: number } {
  const start = m.lineStart(at)
  const end = m.lineEnd(at)
  if (end === start) return { start: at, end: at }
  const c = klass(m.chars[at]!)
  let from = at
  let to = at + 1
  while (from > start && klass(m.chars[from - 1]!) === c) from--
  while (to < end && klass(m.chars[to]!) === c) to++
  if (!around) return { start: from, end: to }
  if (c === 0) {
    const next = to < end ? klass(m.chars[to]!) : 0
    if (next !== 0) while (to < end && klass(m.chars[to]!) === next) to++
    return { start: from, end: to }
  }
  if (to < end && klass(m.chars[to]!) === 0) while (to < end && klass(m.chars[to]!) === 0) to++
  else while (from > start && klass(m.chars[from - 1]!) === 0) from--
  return { start: from, end: to }
}

/** A normal-mode command from its keys: `3dw`, `d2w`, `yy`, `ciw`, `fx`, `gg`. "more" waits for the next key. */
function parse(keys: readonly string[], visual = false): Parsed | "more" | "none" {
  let i = 0
  const readCount = () => {
    let digits = ""
    while (i < keys.length && (/^[1-9]$/.test(keys[i]!) || (digits !== "" && keys[i] === "0"))) digits += keys[i++]
    return digits === "" ? undefined : Number(digits)
  }
  const first = readCount()
  if (i >= keys.length) return "more"
  let op: Operator | undefined
  let second: number | undefined
  let key = keys[i++]!
  if (!visual && (key === "d" || key === "c" || key === "y")) {
    op = key
    second = readCount()
    if (i >= keys.length) return "more"
    key = keys[i++]!
    const total = (first ?? 1) * (second ?? 1)
    const counted = first !== undefined || second !== undefined
    if (key === op) return { count: total, counted, op, cmd: "line" }
    if (key === "i" || key === "a") {
      if (i >= keys.length) return "more"
      return keys[i] === "w" ? { count: total, counted, op, cmd: `${key}w` } : "none"
    }
  }
  if (key === "g") {
    if (i >= keys.length) return "more"
    key = `g${keys[i++]}`
  }
  const counted = first !== undefined || second !== undefined
  const count = (first ?? 1) * (second ?? 1)
  let arg: string | undefined
  if ("fFtT".includes(key) && key.length === 1 || (!op && key === "r")) {
    if (i >= keys.length) return "more"
    arg = keys[i++]
  }
  if (op) return MOTIONS.has(key) ? { count, counted, op, cmd: key, ...(arg === undefined ? {} : { arg }) } : "none"
  const known = MOTIONS.has(key) || CHANGES.has(key) || ["u", ".", "v", "V", "y", "d", "c", "Y"].includes(key)
  return known ? { count, counted, cmd: key, ...(arg === undefined ? {} : { arg }) } : "none"
}

export function createVim(editor: Editor) {
  let mode: VimMode = "insert"
  let pending: string[] = []
  let register: Register = { text: "", linewise: false }
  let anchor = 0
  let visualAt = 0
  let want: number | undefined
  let last: string[] | undefined
  let recording: string[] = []
  let capture: string[] | undefined
  let replaying = false
  let insertRepeat = 1
  let insertedText = ""

  const here = () => editor.cursorOffset
  const view = () => model(graphemes(editor.text), editor.tokens)

  /** `j` and `k` move by drawn rows (a wrapped line is several), keeping the goal column in cells; `want` holds it between moves. */
  const rowsFrom = ({ at, key, count }: { at: number; key: "j" | "k"; count: number }) => editor.stepRows({ at, direction: key === "j" ? 1 : -1, count, normal: true, ...(want === undefined ? {} : { goal: want }) })

  /** Normal mode rests on a character: never past the last one of a line. */
  function settle() {
    const m = view()
    const at = here()
    const end = m.lineEnd(at)
    if (at >= end && end > m.lineStart(at)) editor.moveTo(end - 1)
  }

  function enterInsert({ repeat = 1, keys }: { repeat?: number; keys?: string[] } = {}) {
    mode = "insert"
    insertRepeat = repeat
    insertedText = ""
    capture = keys && !replaying ? [...keys] : undefined
  }

  function leaveInsert() {
    if (insertRepeat > 1 && insertedText) editor.insert(insertedText.repeat(insertRepeat - 1))
    mode = "normal"
    insertRepeat = 1
    if (capture && !replaying) last = [...capture, ESC]
    capture = undefined
    const m = view()
    const at = here()
    if (at > m.lineStart(at)) editor.moveTo(at - 1)
    settle()
  }

  function syncVisual() {
    const m = view()
    if (mode === "visual-line") {
      const lo = Math.min(anchor, visualAt)
      const hi = Math.max(anchor, visualAt)
      editor.select(m.lineStart(lo), m.lineEnd(hi))
    } else if (visualAt >= anchor) editor.select(anchor, visualAt + 1)
    else editor.select(anchor + 1, visualAt)
  }

  function leaveVisual() {
    mode = "normal"
    editor.moveTo(visualAt)
    settle()
  }

  function putRegister(text: string, linewise: boolean) {
    register = { text, linewise }
  }

  /** Applies `op` to a range. Linewise ranges cover whole lines; the cursor and the register follow vim. */
  function apply(input: { op: Operator; start: number; end: number; linewise: boolean }) {
    const { op } = input
    const { end } = input
    let { start } = input
    const m = view()
    if (input.linewise) start = m.lineStart(start)
    putRegister(m.chars.slice(start, end).join(""), input.linewise)
    if (op === "y") {
      editor.moveTo(input.linewise ? Math.min(here(), end) : start)
      settle()
      return
    }
    if (input.linewise) {
      if (op === "c") {
        editor.replaceRange(start, end, "", start)
        return enterInsert({ keys: recording })
      }
      // The last line takes the newline before it along; any other takes the one after.
      const lastLine = end >= m.size
      const from = lastLine && start > 0 ? start - 1 : start
      editor.replaceRange(from, lastLine ? m.size : end + 1, "", from)
      const after = view()
      editor.moveTo(after.firstNonBlank(Math.min(from, after.size)))
      settle()
      return
    }
    editor.replaceRange(start, end, "", start)
    if (op === "c") return enterInsert({ keys: recording })
    settle()
  }

  function range(input: { m: Model; motion: Motion; at: number }) {
    const { m, motion, at } = input
    if (motion.linewise) {
      const a = Math.min(at, motion.target)
      const b = Math.max(at, motion.target)
      return { start: m.lineStart(a), end: m.lineEnd(b), linewise: true }
    }
    if (motion.target < at) return { start: motion.target, end: at, linewise: false }
    let end = motion.target + (motion.inclusive ? 1 : 0)
    // An exclusive motion that ends in column 0 of a later line stops at the end of the line before (`dw` on the last word).
    if (!motion.inclusive && end > at && end > 0 && m.chars[end - 1] === "\n" && m.lineOf(end) > m.lineOf(at)) end--
    return { start: at, end, linewise: false }
  }

  function put({ before, count }: { before: boolean; count: number }) {
    if (!register.text && !register.linewise) return
    const m = view()
    const at = here()
    const body = register.text
    if (register.linewise) {
      const text = Array.from({ length: count }, () => body).join("\n")
      if (before) {
        const start = m.lineStart(at)
        editor.replaceRange(start, start, `${text}\n`, start)
      } else {
        const end = m.lineEnd(at)
        editor.replaceRange(end, end, `\n${text}`, end + 1)
      }
      editor.moveTo(view().firstNonBlank(here()))
      settle()
      return
    }
    const text = body.repeat(count)
    const empty = m.lineEnd(at) === m.lineStart(at)
    const insertAt = before || empty ? at : at + 1
    editor.replaceRange(insertAt, insertAt, text, insertAt + Math.max(0, graphemes(text).length - 1))
    settle()
  }

  function repeatLast() {
    if (!last) return
    const keys = last
    replaying = true
    try {
      for (const key of keys) run(key)
    } finally {
      replaying = false
      capture = undefined
    }
  }

  function execute(parsed: Parsed) {
    const { count, counted, cmd } = parsed
    let { op } = parsed
    let word = cmd
    // Shorthands are an operator with a motion: x = dl, D = d$, C = c$, s = cl, S = cc, Y = yy, X = dh.
    const shorthand: Record<string, [Operator, string]> = { x: ["d", "l"], X: ["d", "h"], D: ["d", "$"], C: ["c", "$"], s: ["c", "l"], S: ["c", "line"], Y: ["y", "line"] }
    if (!op && shorthand[cmd]) [op, word] = shorthand[cmd]!
    if (!op && (cmd === "d" || cmd === "c" || cmd === "y")) return
    const m = view()
    const at = here()
    if (op) {
      if (word === "line") {
        const first = m.lineOf(at)
        const lastLine = Math.min(m.starts.length - 1, first + count - 1)
        return apply({ op, start: m.starts[first]!, end: m.lineEnd(m.starts[lastLine]!), linewise: true })
      }
      if (word === "iw" || word === "aw") {
        const found = wordObject({ m, at, around: word === "aw" })
        return found.end > found.start ? apply({ op, start: found.start, end: found.end, linewise: false }) : undefined
      }
      let motion: Motion | undefined
      if (op === "c" && word === "w") {
        if (klass(m.chars[at] ?? " ") === 0) motion = { target: Math.min(m.lineEnd(at), at + 1) }
        else {
          let target = wordForward({ m, from: at, count })
          while (target > at && klass(m.chars[target - 1]!) === 0 && m.chars[target - 1] !== "\n") target--
          motion = { target }
        }
      } else motion = motionTarget({ m, key: word, count, counted, at, want: want ?? at - m.lineStart(at), forOp: true, ...(parsed.arg === undefined ? {} : { arg: parsed.arg }) })
      if (!motion) return
      const span = range({ m, motion, at })
      if (span.end === span.start && !span.linewise) return op === "c" ? enterInsert({ keys: recording }) : undefined
      return apply({ op, ...span })
    }
    switch (cmd) {
      case "i": return enterInsert({ repeat: count, keys: recording })
      case "a": return (editor.moveTo(at < m.lineEnd(at) ? at + 1 : at), enterInsert({ repeat: count, keys: recording }))
      case "I": {
        let k = m.lineStart(at)
        while (k < m.lineEnd(at) && /[ \t]/.test(m.chars[k]!)) k++
        editor.moveTo(k)
        return enterInsert({ repeat: count, keys: recording })
      }
      case "A": return (editor.moveTo(m.lineEnd(at)), enterInsert({ repeat: count, keys: recording }))
      case "o": {
        const end = m.lineEnd(at)
        editor.replaceRange(end, end, "\n", end + 1)
        return enterInsert({ keys: recording })
      }
      case "O": {
        const start = m.lineStart(at)
        editor.replaceRange(start, start, "\n", start)
        return enterInsert({ keys: recording })
      }
      case "p":
      case "P": return put({ before: cmd === "P", count })
      case "u": {
        for (let n = 0; n < count; n++) editor.undo()
        return settle()
      }
      case ".": return repeatLast()
      case "v":
      case "V":
        mode = cmd === "v" ? "visual" : "visual-line"
        anchor = at
        visualAt = at
        return syncVisual()
      case "r": {
        const end = m.lineEnd(at)
        if (parsed.arg === undefined || at + count > end) return
        editor.replaceRange(at, at + count, parsed.arg.repeat(count), at + count - 1)
        return
      }
    }
    if (cmd === "j" || cmd === "k") {
      const moved = rowsFrom({ at, key: cmd, count })
      if (!moved) return
      editor.moveTo(moved.target)
      settle()
      want = moved.goal
      return
    }
    const motion = motionTarget({ m, key: cmd, count, counted, at, want: want ?? at - m.lineStart(at), ...(parsed.arg === undefined ? {} : { arg: parsed.arg }) })
    if (!motion) return
    editor.moveTo(motion.target)
    settle()
    want = cmd === "j" || cmd === "k" ? (want ?? at - m.lineStart(at)) : cmd === "$" ? Number.MAX_SAFE_INTEGER : undefined
  }

  function normal(key: string): VimResult {
    if (key === REDO && pending.length === 0) {
      editor.redo()
      settle()
      return "handled"
    }
    if (pending.length === 0 && key === ESC) return "pass"
    if (key === ESC) {
      pending = []
      return "handled"
    }
    if (pending.length === 0) recording = []
    pending.push(key)
    recording.push(key)
    const parsed = parse(pending)
    if (parsed === "more") return "handled"
    pending = []
    if (parsed === "none") return "handled"
    if (parsed.cmd !== "j" && parsed.cmd !== "k") want = undefined
    const entered = mode
    execute(parsed)
    const changed = parsed.op === "d" || parsed.op === "c" || CHANGES.has(parsed.cmd)
    if (changed && !replaying && mode === entered && !capture) last = [...recording]
    return "handled"
  }

  function visual(key: string): VimResult {
    if (key === ESC) {
      pending = []
      leaveVisual()
      return "handled"
    }
    pending.push(key)
    const parsed = parse(pending, true)
    if (parsed === "more") return "handled"
    pending = []
    if (parsed === "none") return "handled"
    const m = view()
    const linewise = mode === "visual-line"
    const lo = Math.min(anchor, visualAt)
    const hi = Math.max(anchor, visualAt)
    const selected = linewise ? { start: m.lineStart(lo), end: m.lineEnd(hi), linewise: true } : { start: lo, end: hi + 1, linewise: false }
    const operate = (op: Operator, whole = false) => {
      mode = "normal"
      editor.moveTo(selected.start)
      recording = []
      apply({ op, ...selected, ...(whole ? { linewise: true, start: m.lineStart(lo), end: m.lineEnd(hi) } : {}) })
    }
    switch (parsed.cmd) {
      case "d":
      case "x": return (operate("d"), "handled")
      case "X":
      case "D": return (operate("d", true), "handled")
      case "y": return (operate("y"), "handled")
      case "Y": return (operate("y", true), "handled")
      case "c":
      case "s": return (operate("c"), "handled")
      case "C":
      case "S": return (operate("c", true), "handled")
      case "v":
        if (mode === "visual") leaveVisual()
        else (mode = "visual", syncVisual())
        return "handled"
      case "V":
        if (mode === "visual-line") leaveVisual()
        else (mode = "visual-line", syncVisual())
        return "handled"
      case "o": {
        ;[anchor, visualAt] = [visualAt, anchor]
        syncVisual()
        return "handled"
      }
    }
    if (parsed.op) return "handled"
    if (parsed.cmd === "j" || parsed.cmd === "k") {
      const moved = rowsFrom({ at: visualAt, key: parsed.cmd, count: parsed.count })
      if (moved) {
        want = moved.goal
        visualAt = moved.target
        syncVisual()
      }
      return "handled"
    }
    const motion = motionTarget({ m, key: parsed.cmd, count: parsed.count, counted: parsed.counted, at: visualAt, want: visualAt - m.lineStart(visualAt), ...(parsed.arg === undefined ? {} : { arg: parsed.arg }) })
    if (motion) {
      want = undefined
      visualAt = motion.target
      syncVisual()
    }
    return "handled"
  }

  /** One key, normal-mode style, also used to replay a recorded change. */
  function run(key: string): VimResult {
    if (mode === "insert") {
      if (key === ESC) {
        leaveInsert()
        return "handled"
      }
      if (replaying) {
        if (key !== "\r") {
          editor.key(key)
          if (graphemes(key).length === 1 && key >= " ") insertedText += key
        }
        return "handled"
      }
      return "pass"
    }
    const mapped = ARROWS[key] ?? key
    if (mapped.startsWith(ESC) && mapped !== ESC) return "pass"
    if (mapped === ESC) return mode === "normal" ? normal(mapped) : visual(mapped)
    if (mapped < " " && mapped !== REDO) return "pass"
    if (mapped === REDO && mode !== "normal") return "handled"
    return mode === "normal" ? normal(mapped) : visual(mapped)
  }

  return {
    get mode() { return mode },
    get pending() { return pending.join("") },
    get label() {
      const name = mode === "insert" ? "INSERT" : mode === "normal" ? "NORMAL" : mode === "visual" ? "VISUAL" : "VISUAL LINE"
      return `-- ${name} --${pending.length ? `  ${pending.join("")}` : ""}`
    },
    get cursorShape(): "bar" | "block" { return mode === "insert" ? "bar" : "block" },
    /** A mouse click at grapheme offset `target`: visual mode and a half-typed command end, and normal mode rests on a character. */
    place(target: number) {
      if (mode === "visual" || mode === "visual-line") mode = "normal"
      pending = []
      want = undefined
      editor.moveTo(target)
      if (mode === "normal") settle()
    },
    /** Back to insert mode with nothing pending: a sent prompt, or vim mode being switched off. */
    reset() {
      if (mode === "visual" || mode === "visual-line") editor.moveTo(visualAt)
      mode = "insert"
      pending = []
      capture = undefined
    },
    /** Whether the key was consumed. Insert mode passes everything but Esc through to the prompt, remembering it for dot repeat. */
    key(seq: string): VimResult {
      if (mode === "insert") {
        const result = run(seq)
        if (result === "pass" && capture && !replaying && seq !== "\r") {
          capture.push(seq)
          if (graphemes(seq).length === 1 && seq >= " ") insertedText += seq
        }
        return result
      }
      const parts = seq.length > 1 && !seq.startsWith(ESC) && seq >= " " ? graphemes(seq) : [seq]
      let result: VimResult = "handled"
      for (const part of parts) result = run(part)
      return result
    },
  }
}
export type Vim = ReturnType<typeof createVim>
