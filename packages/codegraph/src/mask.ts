/**
 * Blanks comments and string contents while keeping every offset and newline, so regexes and brace
 * matching over the result never see text inside strings or comments.
 */

export type MaskOptions = {
  templates: boolean
  regexLiterals: boolean
  /** Go raw strings: a backtick runs to the next backtick, no escapes. */
  rawBacktick: boolean
  /** Rust: `'x'` is a character, `'a` a lifetime. */
  charLiterals: boolean
  /** `'…'` is a string (TS, JS, Go runes). */
  singleQuoteStrings: boolean
  /** Double-quoted strings may span lines (Rust). */
  multilineStrings: boolean
}

export const SCRIPT_MASK: MaskOptions = { templates: true, regexLiterals: true, rawBacktick: false, charLiterals: false, singleQuoteStrings: true, multilineStrings: false }
export const GO_MASK: MaskOptions = { templates: false, regexLiterals: false, rawBacktick: true, charLiterals: false, singleQuoteStrings: true, multilineStrings: false }
/** Swift: `"…"` and `"""…"""` only; a `"""` block reads as an empty string, a string that spans the lines, and an empty string. */
export const SWIFT_MASK: MaskOptions = { templates: false, regexLiterals: false, rawBacktick: false, charLiterals: false, singleQuoteStrings: false, multilineStrings: true }
export const RUST_MASK: MaskOptions = { templates: false, regexLiterals: false, rawBacktick: false, charLiterals: true, singleQuoteStrings: false, multilineStrings: true }

const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^"
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "of", "in", "void", "delete", "throw", "yield", "await"])
const isWordChar = (c: string) => /[\w$]/.test(c)

export function maskCode(text: string, options: MaskOptions): string {
  const n = text.length
  const out = text.split("")
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      const ch = out[k]
      if (ch !== "\n" && ch !== "\r") out[k] = " "
    }
  }
  const quoted = (start: number, quote: string, multiline: boolean): number => {
    let k = start + 1
    while (k < n) {
      const ch = text[k] as string
      if (ch === "\\") {
        k += 2
        continue
      }
      if (ch === quote) break
      if (ch === "\n" && !multiline) break
      k++
    }
    blank(start + 1, k)
    return k < n && text[k] === quote ? k + 1 : k
  }
  /** Masks template text up to the next `${` (returns true) or the closing backtick (false). */
  const template = (start: number): { next: number; open: boolean } => {
    let k = start
    while (k < n) {
      const ch = text[k] as string
      if (ch === "\\") {
        k += 2
        continue
      }
      if (ch === "`") {
        blank(start, k)
        return { next: k + 1, open: false }
      }
      if (ch === "$" && text[k + 1] === "{") {
        blank(start, k)
        return { next: k + 2, open: true }
      }
      k++
    }
    blank(start, n)
    return { next: n, open: false }
  }

  const templateStack: number[] = []
  let brace = 0
  let previous = ""
  let previousWord = ""
  let i = 0
  while (i < n) {
    const c = text[i] as string
    const d = text[i + 1]
    if (c === "/" && d === "/") {
      let end = text.indexOf("\n", i)
      if (end < 0) end = n
      blank(i, end)
      i = end
      continue
    }
    if (c === "/" && d === "*") {
      const close = text.indexOf("*/", i + 2)
      const end = close < 0 ? n : close + 2
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || (c === "'" && options.singleQuoteStrings)) {
      i = quoted(i, c, options.multilineStrings && c === '"')
      previous = c
      previousWord = ""
      continue
    }
    if (c === "'" && options.charLiterals) {
      const literal = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(text.slice(i, i + 12))
      if (literal) {
        blank(i + 1, i + literal[0].length - 1)
        i += literal[0].length
      } else i++
      previous = "'"
      previousWord = ""
      continue
    }
    if (c === "`" && options.rawBacktick) {
      const close = text.indexOf("`", i + 1)
      const end = close < 0 ? n : close
      blank(i + 1, end)
      i = close < 0 ? n : close + 1
      previous = "`"
      previousWord = ""
      continue
    }
    if (c === "`" && options.templates) {
      const scanned = template(i + 1)
      if (scanned.open) templateStack.push(brace)
      i = scanned.next
      previous = "`"
      previousWord = ""
      continue
    }
    if (c === "/" && options.regexLiterals && (previous === "" || REGEX_PRECEDERS.includes(previous) || REGEX_KEYWORDS.has(previousWord))) {
      let k = i + 1
      let inClass = false
      let closed = false
      while (k < n) {
        const ch = text[k] as string
        if (ch === "\\") {
          k += 2
          continue
        }
        if (ch === "\n") break
        if (ch === "[") inClass = true
        else if (ch === "]") inClass = false
        else if (ch === "/" && !inClass) {
          closed = true
          break
        }
        k++
      }
      if (closed) {
        blank(i + 1, k)
        i = k + 1
        previous = ")"
        previousWord = ""
        continue
      }
    }
    if (c === "{") brace++
    else if (c === "}") {
      const top = templateStack[templateStack.length - 1]
      if (top !== undefined && brace === top) {
        templateStack.pop()
        const scanned = template(i + 1)
        if (scanned.open) templateStack.push(brace)
        i = scanned.next
        previous = "`"
        previousWord = ""
        continue
      }
      brace = Math.max(0, brace - 1)
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++
      continue
    }
    if (isWordChar(c)) {
      let k = i + 1
      while (k < n && isWordChar(text[k] as string)) k++
      previousWord = text.slice(i, k)
      previous = previousWord.slice(-1)
      i = k
      continue
    }
    previous = c
    previousWord = ""
    i++
  }
  return out.join("")
}

/** Python: `#` comments and ordinary/triple-quoted strings blanked. */
export function maskPython(text: string): string {
  const n = text.length
  const out = text.split("")
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      const ch = out[k]
      if (ch !== "\n" && ch !== "\r") out[k] = " "
    }
  }
  let i = 0
  while (i < n) {
    const c = text[i] as string
    if (c === "#") {
      let end = text.indexOf("\n", i)
      if (end < 0) end = n
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i)
      if (triple) {
        const close = text.indexOf(c.repeat(3), i + 3)
        const end = close < 0 ? n : close
        blank(i + 3, end)
        i = close < 0 ? n : close + 3
        continue
      }
      let k = i + 1
      while (k < n) {
        const ch = text[k] as string
        if (ch === "\\") {
          k += 2
          continue
        }
        if (ch === c || ch === "\n") break
        k++
      }
      blank(i + 1, k)
      i = k < n && text[k] === c ? k + 1 : k
      continue
    }
    i++
  }
  return out.join("")
}

export type Lines = {
  /** Offset of each line's first character. */
  starts: number[]
  /** ( { [ nesting at the start of each line. */
  depth: number[]
}

export function indexLines(masked: string): Lines {
  const starts = [0]
  const depth = [0]
  let level = 0
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if (c === "(" || c === "{" || c === "[") level++
    else if (c === ")" || c === "}" || c === "]") level = Math.max(0, level - 1)
    else if (c === "\n") {
      starts.push(i + 1)
      depth.push(level)
    }
  }
  return { starts, depth }
}

/** 0-based line index containing `offset`. */
export function lineAt({ starts, offset }: { starts: number[]; offset: number }): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((starts[mid] as number) <= offset) low = mid
    else high = mid - 1
  }
  return low
}
