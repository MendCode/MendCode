import { lineAt, type Lines } from "./mask"
import type { CallRec, SymbolKind, SymbolRec } from "./types"

/** A declaration found by a language scanner, with offsets into the masked text. */
export type Decl = {
  name: string
  kind: SymbolKind
  exported: boolean
  parent?: string | undefined
  startIdx: number
  endIdx: number
  /** Start offset of the name token where it is declared (so the call pass ignores it). */
  nameIdx: number
  /** Words that, before `.` or `::`, mean "a method of the same type" (this, self, a Go receiver). */
  selfWords: string[]
  member: boolean
}

export type CallOptions = {
  /** Enables `name<T>(` calls (TypeScript). */
  generics: boolean
  keywords: ReadonlySet<string>
  /** Words that, directly before a name, make it a declaration rather than a call. */
  declarationWords: ReadonlySet<string>
}

const SPACE = /[ \t\r\n]/

/** Offset just past the `}` matching the `{` at `open` (end of text when unmatched). */
export function matchBrace({ masked, open }: { masked: string; open: number }): number {
  let level = 0
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]
    if (c === "{") level++
    else if (c === "}") {
      level--
      if (level === 0) return i + 1
    }
  }
  return masked.length
}

const HEADER_LINE_CONTINUES = ":|&,=<(."
const HEADER_NEXT_CONTINUES = "{|&:,=.?"

/** After a signature's parameter list, whether the header goes on past the newline at `at` (a return type, `where`, the body brace). */
function headerContinues({ masked, at }: { masked: string; at: number }): boolean | "where" {
  let back = at - 1
  while (back >= 0 && SPACE.test(masked[back] as string)) back--
  const last = masked[back] ?? ""
  if (last !== "" && HEADER_LINE_CONTINUES.includes(last)) return true
  if (last === ">" && masked[back - 1] === "=") return true
  let next = at + 1
  while (next < masked.length && SPACE.test(masked[next] as string)) next++
  if (masked.startsWith("where", next)) return "where"
  const first = masked[next] ?? ""
  return first !== "" && HEADER_NEXT_CONTINUES.includes(first)
}

/**
 * End offset of the first `{ … }` body after `from`, skipping parameter lists, generics and a
 * `): { … } {` return-type literal; undefined when a `;` comes first (no body).
 */
export function findBody({ masked, from }: { masked: string; from: number }): number | undefined {
  let paren = 0
  let bracket = 0
  let angle = 0
  let closedParams = false
  let inWhere = false
  for (let i = from; i < masked.length; i++) {
    const c = masked[i] as string
    if (c === "(") paren++
    else if (c === ")") {
      paren--
      if (paren === 0) closedParams = true
    } else if (c === "[") bracket++
    else if (c === "]") bracket--
    else if (paren <= 0 && bracket <= 0) {
      if (c === "\n" && closedParams && angle === 0 && !inWhere) {
        const goesOn = headerContinues({ masked, at: i })
        if (goesOn === "where") inWhere = true
        else if (!goesOn) return undefined
      }
      if (c === "<") angle++
      else if (c === ">") {
        if (masked[i - 1] !== "=") angle = Math.max(0, angle - 1)
      } else if (c === ";") return undefined
      else if (c === "{" && angle === 0) {
        let end = matchBrace({ masked, open: i })
        let next = end
        while (masked[next] === " " || masked[next] === "\t") next++
        while (masked[next] === "{") {
          end = matchBrace({ masked, open: next })
          next = end
          while (masked[next] === " " || masked[next] === "\t") next++
        }
        return end
      }
    }
  }
  return undefined
}

const LINE_CONTINUES = "=,+-*/%&|?:(<.!~^"
const NEXT_CONTINUES = ".?:|&,+-*/%="

/** End offset of a statement that has no braces of its own (`const x = …`, `type X = …`). */
export function statementEnd({ masked, from }: { masked: string; from: number }): number {
  const n = masked.length
  let level = 0
  for (let i = from; i < n; i++) {
    const c = masked[i] as string
    if (c === "(" || c === "[" || c === "{") level++
    else if (c === ")" || c === "]" || c === "}") {
      level--
      if (level < 0) return i
    } else if (level === 0) {
      if (c === ";") return i + 1
      if (c === "\n") {
        let back = i - 1
        while (back >= from && SPACE.test(masked[back] as string)) back--
        const last = masked[back] ?? ""
        let next = i + 1
        while (next < n && SPACE.test(masked[next] as string)) next++
        if (next >= n) return n
        const first = masked[next] as string
        const arrow = last === ">" && masked[back - 1] === "="
        if ((LINE_CONTINUES.includes(last) && last !== "") || arrow || NEXT_CONTINUES.includes(first)) continue
        return i
      }
    }
  }
  return n
}

export function lastCodeOffset({ masked, before }: { masked: string; before: number }): number {
  let i = Math.min(before, masked.length - 1)
  while (i > 0 && SPACE.test(masked[i] as string)) i--
  return Math.max(0, i)
}

function locate({ list, offset }: { list: Array<{ decl: Decl; index: number }>; offset: number }): { decl: Decl; index: number } | undefined {
  let low = 0
  let high = list.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((list[mid] as { decl: Decl }).decl.startIdx <= offset) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  const hit = found >= 0 ? (list[found] as { decl: Decl; index: number }) : undefined
  return hit && offset < hit.decl.endIdx ? hit : undefined
}

function wordBefore({ masked, end }: { masked: string; end: number }): string {
  let p = end
  while (p >= 0 && SPACE.test(masked[p] as string)) p--
  let start = p
  while (start >= 0 && /[\w$]/.test(masked[start] as string)) start--
  return masked.slice(start + 1, p + 1)
}

const CALL_RE = /([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g
const GENERIC_CALL_RE = /([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?(?:<[^<>()\n]*>\s*)?\(/g

/**
 * Turns declarations into symbol records and finds the calls inside them: an identifier followed by
 * `(`, attributed to the innermost declaration around it. Qualifiers are retained for namespace,
 * static and self calls; the graph resolver decides which receivers are actually known.
 */
export function finalizeDecls({
  masked,
  lines,
  decls,
  options,
}: {
  masked: string
  lines: Lines
  decls: Decl[]
  options: CallOptions
}): { symbols: SymbolRec[]; calls: CallRec[] } {
  const sorted = [...decls].sort((a, b) => a.startIdx - b.startIdx || Number(a.member) - Number(b.member))
  const symbols: SymbolRec[] = sorted.map((decl) => {
    const start = lineAt({ starts: lines.starts, offset: decl.startIdx }) + 1
    const end = lineAt({ starts: lines.starts, offset: lastCodeOffset({ masked, before: decl.endIdx - 1 }) }) + 1
    const record: SymbolRec = { name: decl.name, kind: decl.kind, start, end: Math.max(start, end), exported: decl.exported }
    if (decl.parent !== undefined) record.parent = decl.parent
    return record
  })
  const indexed = sorted.map((decl, index) => ({ decl, index }))
  const tops = indexed.filter((entry) => !entry.decl.member)
  const members = indexed.filter((entry) => entry.decl.member)
  const declaredNames = new Set(sorted.map((decl) => decl.nameIdx))
  const seen = new Set<string>()
  const calls: CallRec[] = []
  const regex = new RegExp((options.generics ? GENERIC_CALL_RE : CALL_RE).source, "g")
  for (const match of masked.matchAll(regex)) {
    const name = match[1] as string
    const at = match.index
    if (options.keywords.has(name) || declaredNames.has(at)) continue
    const owner = locate({ list: members, offset: at }) ?? locate({ list: tops, offset: at })
    if (!owner) continue
    let p = at - 1
    while (p >= 0 && SPACE.test(masked[p] as string)) p--
    const prev = masked[p]
    let self = false
    let qualifier = ""
    if (prev === "." && masked[p - 1] !== ".") {
      let end = masked[p - 1] === "?" ? p - 2 : p - 1
      while (end >= 0 && SPACE.test(masked[end] as string)) end--
      const word = wordBefore({ masked, end })
      let before = end - word.length
      while (before >= 0 && SPACE.test(masked[before] as string)) before--
      // Do not mistake obj.this.f() or obj.Namespace.f() for a known receiver.
      if (masked[before] === "." || word === "") continue
      if (owner.decl.selfWords.includes(word)) self = true
      else qualifier = word
    } else if (prev === ":" && masked[p - 1] === ":") {
      const word = wordBefore({ masked, end: p - 2 })
      if (owner.decl.selfWords.includes(word)) self = true
      else if (word) qualifier = word
    } else if (options.declarationWords.has(wordBefore({ masked, end: p }))) continue
    const key = `${owner.index}:${name}:${self}:${qualifier}`
    if (seen.has(key)) continue
    seen.add(key)
    const call: CallRec = { from: owner.index, name }
    if (self) call.self = true
    if (qualifier !== "") {
      call.qualifier = qualifier
      if (prev === ".") call.dot = true
    }
    calls.push(call)
  }
  return { symbols, calls }
}
