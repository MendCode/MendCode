/**
 * Reading a workflow script without running it: the pure-literal `export const meta = {...}` at its top, the body that
 * follows, and a token-aware scan for the one construct a stripped global scope cannot remove (`import`, which is syntax, not
 * a global). No imports and no zod here: the sandboxed host process loads this module.
 */

export type ScriptParts = { meta: unknown; body: string; bodyLine: number }
export type ScriptSplit = ({ ok: true } & ScriptParts) | { ok: false; problem: string }

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])
const MAX_DEPTH = 12

class LiteralError extends Error {}

/** The literal parser: JSON plus the JavaScript spellings people write (single quotes, unquoted keys, comments, trailing commas). Nothing is evaluated. */
function parseLiteralAt(text: string, start: number): { value: unknown; end: number } {
  let i = start
  const fail = (message: string): never => {
    const line = text.slice(0, i).split("\n").length
    throw new LiteralError(`meta must be a pure literal: ${message} (line ${line})`)
  }
  const skip = () => {
    for (;;) {
      const ch = text[i]
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") i++
      else if (ch === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++
      else if (ch === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2)
        if (close < 0) fail("unterminated comment")
        i = close + 2
      } else return
    }
  }
  const string = (quote: string): string => {
    let out = ""
    i++
    for (;;) {
      const ch = text[i]
      if (ch === undefined || ch === "\n" && quote !== "`") fail("unterminated string")
      if (ch === quote) {
        i++
        return out
      }
      if (quote === "`" && ch === "$" && text[i + 1] === "{") fail("template interpolation is not a literal")
      if (ch === "\\") {
        const next = text[i + 1]
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`", "/": "/", $: "$" }
        if (next === "u") {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad unicode escape")
          out += String.fromCharCode(Number.parseInt(hex, 16))
          i += 6
        } else if (next !== undefined && next in simple) {
          out += simple[next]
          i += 2
        } else if (next === "\n") i += 2
        else fail("unsupported escape")
        continue
      }
      out += ch
      i++
    }
  }
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail("nested too deeply")
    skip()
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === "`") return string(ch)
    if (ch === "[") {
      i++
      const list: unknown[] = []
      for (;;) {
        skip()
        if (text[i] === "]") {
          i++
          return list
        }
        list.push(value(depth + 1))
        skip()
        if (text[i] === ",") i++
        else if (text[i] !== "]") fail("expected , or ]")
        if (list.length > 256) fail("array too long")
      }
    }
    if (ch === "{") {
      i++
      const object: Record<string, unknown> = {}
      for (;;) {
        skip()
        if (text[i] === "}") {
          i++
          return object
        }
        let key: string
        const first = text[i]
        if (first === '"' || first === "'") key = string(first)
        else {
          const word = /^[A-Za-z_$][A-Za-z0-9_$]*|^-?\d+(?:\.\d+)?/.exec(text.slice(i))?.[0]
          if (!word) return fail("expected a key")
          key = word
          i += word.length
        }
        if (FORBIDDEN_KEYS.has(key)) fail(`key ${key} is not allowed`)
        skip()
        if (text[i] !== ":") fail("expected :")
        i++
        object[key] = value(depth + 1)
        skip()
        if (text[i] === ",") i++
        else if (text[i] !== "}") fail("expected , or }")
      }
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i))?.[0]
    if (number) {
      i += number.length
      return Number(number)
    }
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, i) && !/[A-Za-z0-9_$]/.test(text[i + word.length] ?? "")) {
        i += word.length
        return result
      }
    }
    return fail("only strings, numbers, booleans, null, arrays and objects are allowed (no variables, calls, spreads or expressions)")
  }
  const result = value(0)
  return { value: result, end: i }
}

const HEADER = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*export\s+const\s+meta\s*=\s*/

/** Splits a script into its literal `meta` and its body (an async function body: `await`, `return` and top-level statements work). */
export function splitScript(source: string): ScriptSplit {
  const text = source.replace(/^﻿/, "").replace(/^#![^\n]*\n/, "\n")
  const header = HEADER.exec(text)
  if (!header) return { ok: false, problem: "a script must begin with `export const meta = { name, description, phases }` (a pure literal)" }
  let parsed: { value: unknown; end: number }
  try {
    parsed = parseLiteralAt(text, header[0].length)
  } catch (error) {
    if (error instanceof LiteralError) return { ok: false, problem: error.message }
    throw error
  }
  let end = parsed.end
  while (text[end] === " " || text[end] === "\t") end++
  if (text[end] === ";") end++
  const body = text.slice(end)
  return { ok: true, meta: parsed.value, body, bodyLine: text.slice(0, end).split("\n").length }
}

const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"])
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "instanceof", "new", "void", "delete", "throw", "yield", "await", "of"])

/**
 * Finds the constructs that survive a stripped global scope: a dynamic `import(...)` or `import.meta` (syntax, not a global),
 * and unicode escapes in identifiers (a way to spell it). It skips strings, template text, comments and regex literals, so a prompt
 * that mentions "import" is fine. Returns a problem, or undefined when the source is clean. Anything it cannot tokenize is refused.
 */
export function scanForbidden(source: string): string | undefined {
  const text = source
  let i = 0
  let last = ""
  let lastWord = ""
  const templates: number[] = []
  let braces = 0
  const line = () => text.slice(0, i).split("\n").length
  while (i < text.length) {
    const ch = text[i]!
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2)
      if (close < 0) return `unterminated comment (line ${line()})`
      i = close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i++
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i++
        if (text[i] === "\n") return `unterminated string (line ${line()})`
        i++
      }
      if (i >= text.length) return `unterminated string (line ${line()})`
      i++
      last = "str"
      lastWord = ""
      continue
    }
    if (ch === "`" || (ch === "}" && templates.length && templates[templates.length - 1] === braces)) {
      if (ch === "}") templates.pop()
      i++
      for (;;) {
        if (i >= text.length) return `unterminated template (line ${line()})`
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === "`") {
          i++
          last = "str"
          lastWord = ""
          break
        }
        if (text[i] === "$" && text[i + 1] === "{") {
          i += 2
          templates.push(braces)
          last = "{"
          lastWord = ""
          break
        }
        i++
      }
      continue
    }
    if (ch === "{") braces++
    if (ch === "}") braces--
    if (ch === "/") {
      const regexOk = last === "" || REGEX_PRECEDERS.has(last) || REGEX_KEYWORDS.has(lastWord)
      if (regexOk) {
        i++
        let inClass = false
        while (i < text.length) {
          const c = text[i]!
          if (c === "\n") return `unterminated regular expression (line ${line()})`
          if (c === "\\") i++
          else if (c === "[") inClass = true
          else if (c === "]") inClass = false
          else if (c === "/" && !inClass) break
          i++
        }
        i++
        while (/[A-Za-z]/.test(text[i] ?? "")) i++
        last = "re"
        lastWord = ""
        continue
      }
    }
    if (ch === "\\") return `unicode escapes in identifiers are not allowed (line ${line()})`
    if (/[\p{ID_Start}$_]/u.test(ch)) {
      const start = i
      i++
      while (i < text.length && /[\p{ID_Continue}$‌‍]/u.test(text[i]!)) i++
      const word = text.slice(start, i)
      if (text[i] === "\\") return `unicode escapes in identifiers are not allowed (line ${line()})`
      if (word === "import" && last !== ".") return `import is not available in a workflow script (line ${line()})`
      last = "id"
      lastWord = word
      continue
    }
    if (/\d/.test(ch)) {
      while (i < text.length && /[\w.]/.test(text[i]!)) i++
      last = "num"
      lastWord = ""
      continue
    }
    if (ch === "." && text[i + 1] === "." && text[i + 2] === ".") {
      i += 3
      last = "..."
      lastWord = ""
      continue
    }
    if (ch === "?" && text[i + 1] === ".") {
      i += 2
      last = "."
      lastWord = ""
      continue
    }
    last = ch
    lastWord = ""
    i++
  }
  return undefined
}
