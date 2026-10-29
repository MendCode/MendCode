import { extname } from "node:path"
import { pythonBindings, scriptBindings } from "./bindings"
import { GO_MASK, indexLines, lineAt, maskCode, maskPython, RUST_MASK, SCRIPT_MASK, SWIFT_MASK } from "./mask"
import { finalizeDecls, findBody, matchBrace, statementEnd, type CallOptions, type Decl } from "./scan-util"
import { EXTENSION_LANGUAGE, type CallRec, type ExportBinding, type ImportBinding, type Language, type SymbolRec } from "./types"

export type ScanResult = { imports: string[]; symbols: SymbolRec[]; calls: CallRec[]; bindings?: ImportBinding[]; exports?: ExportBinding[] }

export const languageOf = (path: string): Language | undefined => EXTENSION_LANGUAGE[extname(path).toLowerCase()]

const SCRIPT_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "async", "super", "import", "require", "void", "delete", "throw", "with", "of", "in"])
const SCRIPT_CALLS: CallOptions = { generics: true, keywords: SCRIPT_KEYWORDS, declarationWords: new Set(["function"]) }

const SCRIPT_DECL =
  /^[ \t]*(export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(function\*?|class|interface|type|enum|const[ \t]+enum|const|let|var|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm
const SCRIPT_MEMBER =
  /^[ \t]*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor)[ \t]+)*(?:(?:get|set)[ \t]+)?\*?[ \t]*(#?[A-Za-z_$][\w$]*)[ \t]*(?:<[^>\n(]*>)?[ \t]*\(/gm
const SCRIPT_ARROW_MEMBER =
  /^[ \t]*(?:(?:public|private|protected|static|readonly|override)[ \t]+)*(#?[A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?(?:\([^\n]*=>|[A-Za-z_$][\w$]*[ \t]*=>)/gm
const SCRIPT_EXPORT_LIST = /^[ \t]*export[ \t]*\{([^}]*)\}/gm
const SCRIPT_IMPORT_LINE = /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom[ \t]*['"]([^'"\n]+)['"]|^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm
const FALLBACK_IMPORT = /(?:\bfrom|\bimport|\brequire\()[ \t]*['"]([^'"\n]+)['"]/g

type ScriptLoader = "ts" | "tsx" | "js" | "jsx"
/**
 * One transpiler per loader for the whole process. Each instance owns native memory the collector does not see, so one
 * per file kept it alive until a collection: a 2,872-file repository peaked at about 360 MB in the daemon, 235 with one each.
 */
const transpilers = new Map<ScriptLoader, InstanceType<typeof Bun.Transpiler>>()
const transpilerFor = (loader: ScriptLoader) => {
  let transpiler = transpilers.get(loader)
  if (!transpiler) transpilers.set(loader, (transpiler = new Bun.Transpiler({ loader })))
  return transpiler
}

function scriptImports({ text, path, masked }: { text: string; path: string; masked: string }): string[] {
  const found = new Set<string>()
  const addMatches = (pattern: RegExp) => {
    for (const match of masked.matchAll(pattern)) {
      const quote = match[0].search(/['"]/)
      if (quote >= 0) found.add(text.slice(match.index + quote + 1, match.index + match[0].length - 1))
    }
  }
  try {
    const ext = extname(path).toLowerCase()
    const loader = ext === ".tsx" ? "tsx" : [".ts", ".mts", ".cts"].includes(ext) ? "ts" : ext === ".jsx" ? "jsx" : "js"
    for (const entry of transpilerFor(loader).scanImports(text)) found.add(entry.path)
  } catch {
    addMatches(FALLBACK_IMPORT)
  }
  addMatches(SCRIPT_IMPORT_LINE)
  return [...found]
}

const ARROW_HEAD = /^\s*(?::[^=]+)?=\s*(async\s+)?(function\b|[A-Za-z_$][\w$]*\s*=>|\(|<)/

function scanScript({ text, path }: { text: string; path: string }): ScanResult {
  const masked = maskCode(text, SCRIPT_MASK)
  const lines = indexLines(masked)
  const bindings = scriptBindings({ text, masked })
  const listed = new Set<string>()
  for (const match of masked.matchAll(SCRIPT_EXPORT_LIST)) {
    for (const part of (match[1] as string).split(",")) {
      const local = part.trim().split(/\s+as\s+/)[0]?.trim()
      if (local) listed.add(local)
    }
  }
  const decls: Decl[] = []
  for (const match of masked.matchAll(SCRIPT_DECL)) {
    const line = lineAt({ starts: lines.starts, offset: match.index })
    if (lines.depth[line] !== 0) continue
    const word = (match[2] as string).replace(/\s+/g, " ")
    const name = match[3] as string
    if (name === "extends" || name === "implements") continue
    const nameEnd = match.index + match[0].length
    const nameIdx = nameEnd - name.length
    let kind: Decl["kind"]
    let endIdx: number
    if (word.startsWith("function") || word === "class" || word === "interface" || word === "enum" || word === "const enum" || word === "namespace") {
      kind = word.startsWith("function") ? "function" : word === "const enum" ? "enum" : (word as Decl["kind"])
      endIdx = findBody({ masked, from: nameEnd }) ?? statementEnd({ masked, from: nameEnd })
    } else {
      endIdx = statementEnd({ masked, from: nameEnd })
      if (word === "type") kind = "type"
      else {
        const head = masked.slice(nameEnd, Math.min(endIdx, nameEnd + 300))
        const arrow = ARROW_HEAD.exec(head)
        const isFunction = arrow !== null && ((arrow[2] as string).startsWith("function") || (arrow[2] as string).endsWith("=>") || head.includes("=>"))
        kind = isFunction ? "function" : "variable"
      }
    }
    if (match[1] !== undefined) bindings.exports.push({ exported: /\bdefault\b/.test(match[0]) ? "default" : name, local: name })
    decls.push({ name, kind, exported: match[1] !== undefined || listed.has(name), startIdx: match.index, endIdx, nameIdx, selfWords: ["this"], member: false })
    if (kind === "class") decls.push(...classMembers({ masked, lines, className: name, from: nameEnd, to: endIdx }))
  }
  return { imports: scriptImports({ text, path, masked }), ...bindings, ...finalizeDecls({ masked, lines, decls, options: SCRIPT_CALLS }) }
}

function classMembers({ masked, lines, className, from, to }: { masked: string; lines: ReturnType<typeof indexLines>; className: string; from: number; to: number }): Decl[] {
  const out: Decl[] = []
  const inBody = (index: number) => index >= from && index < to && lines.depth[lineAt({ starts: lines.starts, offset: index })] === 1
  for (const match of masked.slice(0, to).matchAll(SCRIPT_MEMBER)) {
    if (!inBody(match.index)) continue
    const name = match[1] as string
    const nameEnd = match.index + match[0].length - 1
    const endIdx = findBody({ masked, from: nameEnd }) ?? statementEnd({ masked, from: nameEnd })
    out.push({
      name,
      kind: "method",
      exported: false,
      parent: className,
      startIdx: match.index,
      endIdx,
      nameIdx: masked.indexOf(name, match.index),
      selfWords: ["this"],
      member: true,
    })
  }
  for (const match of masked.slice(0, to).matchAll(SCRIPT_ARROW_MEMBER)) {
    if (!inBody(match.index)) continue
    const name = match[1] as string
    const nameIdx = masked.indexOf(name, match.index)
    out.push({
      name,
      kind: "method",
      exported: false,
      parent: className,
      startIdx: match.index,
      endIdx: statementEnd({ masked, from: nameIdx + name.length }),
      nameIdx,
      selfWords: ["this"],
      member: true,
    })
  }
  return out
}

const PY_KEYWORDS = new Set(["if", "elif", "while", "for", "def", "class", "return", "not", "in", "and", "or", "lambda", "assert", "with", "except", "yield", "await", "del", "raise", "import", "from", "is", "print"])
const PY_CALLS: CallOptions = { generics: false, keywords: PY_KEYWORDS, declarationWords: new Set(["def", "class"]) }
const PY_DEF = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/
const PY_CLASS = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)/

function scanPython({ text }: { text: string }): ScanResult {
  const masked = maskPython(text)
  const lines = indexLines(masked)
  const rows = masked.split("\n")
  const indentOf = (row: string) => row.length - row.trimStart().length
  const isBlank = (row: string) => row.trim() === ""
  const imports = new Set<string>()
  const decls: Decl[] = []
  let current: { name: string; bodyIndent: number | undefined } | undefined
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as string
    if (isBlank(row)) continue
    const indent = indentOf(row)
    const importMatch = /^[ \t]*import[ \t]+(.+)$/.exec(row)
    if (importMatch) {
      for (const part of (importMatch[1] as string).split(",")) {
        const spec = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (spec) imports.add(spec)
      }
    }
    const fromMatch = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import\b/.exec(row)
    if (fromMatch) imports.add(fromMatch[1] as string)
    if (indent === 0 && !PY_CLASS.test(row)) current = undefined
    else if (current && current.bodyIndent === undefined && indent > 0) current.bodyIndent = indent
    const classMatch = PY_CLASS.exec(row)
    const defMatch = PY_DEF.exec(row)
    if (!classMatch && !defMatch) continue
    const match = (classMatch ?? defMatch) as RegExpExecArray
    const name = match[2] as string
    const defIndent = (match[1] as string).length
    const isMethod = defMatch !== null && defIndent > 0 && current !== undefined && current.bodyIndent === defIndent
    if (defIndent > 0 && !isMethod) continue
    let header = i
    let level = 0
    for (; header < rows.length; header++) {
      for (const ch of rows[header] as string) {
        if (ch === "(" || ch === "[" || ch === "{") level++
        else if (ch === ")" || ch === "]" || ch === "}") level--
      }
      if (level <= 0) break
    }
    let last = header
    for (let j = header + 1; j < rows.length; j++) {
      const next = rows[j] as string
      if (isBlank(next)) continue
      if (indentOf(next) <= defIndent) break
      last = j
    }
    const nameIdx = (lines.starts[i] as number) + (match[0].length - name.length)
    decls.push({
      name,
      kind: classMatch ? "class" : isMethod ? "method" : "function",
      exported: !name.startsWith("_"),
      parent: isMethod ? (current as { name: string }).name : undefined,
      startIdx: lines.starts[i] as number,
      endIdx: lines.starts[last + 1] ?? masked.length,
      nameIdx,
      selfWords: ["self", "cls"],
      member: isMethod,
    })
    if (classMatch && defIndent === 0) current = { name, bodyIndent: undefined }
  }
  return { imports: [...imports], bindings: pythonBindings(masked), ...finalizeDecls({ masked, lines, decls, options: PY_CALLS }) }
}

const GO_KEYWORDS = new Set(["if", "for", "switch", "select", "func", "return", "go", "defer", "range", "make", "new", "len", "cap", "append", "panic", "recover", "string", "int", "bool", "byte", "error"])
const GO_CALLS: CallOptions = { generics: false, keywords: GO_KEYWORDS, declarationWords: new Set(["func", "type"]) }
const GO_FUNC = /^func[ \t]*(?:\([ \t]*(?:(\w+)[ \t]+)?\*?[ \t]*([A-Za-z_][\w.]*)(?:\[[^\]\n]*\])?[ \t]*\)[ \t]*)?([A-Za-z_]\w*)/gm
const GO_TYPE = /^type[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[^\]\n]*\][ \t]*)?(struct|interface)?/gm
const GO_VALUE = /^(?:var|const)[ \t]+([A-Za-z_]\w*)/gm

function scanGo({ text }: { text: string }): ScanResult {
  const masked = maskCode(text, GO_MASK)
  const lines = indexLines(masked)
  const imports = new Set<string>()
  for (const block of text.matchAll(/^import[ \t]*\(([^)]*)\)/gm)) {
    for (const spec of (block[1] as string).matchAll(/"([^"\n]+)"/g)) imports.add(spec[1] as string)
  }
  for (const single of text.matchAll(/^import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) imports.add(single[1] as string)
  const decls: Decl[] = []
  const exported = (name: string) => /^[A-Z]/.test(name)
  for (const match of masked.matchAll(GO_FUNC)) {
    const name = match[3] as string
    const nameEnd = match.index + match[0].length
    const endIdx = findBody({ masked, from: nameEnd }) ?? statementEnd({ masked, from: nameEnd })
    const receiver = match[2]
    decls.push({
      name,
      kind: receiver ? "method" : "function",
      exported: exported(name),
      parent: receiver,
      startIdx: match.index,
      endIdx,
      nameIdx: nameEnd - name.length,
      selfWords: match[1] ? [match[1]] : [],
      member: receiver !== undefined,
    })
  }
  for (const match of masked.matchAll(GO_TYPE)) {
    const name = match[1] as string
    const nameEnd = match.index + match[0].length
    const body = match[2]
    let endIdx: number
    if (body) {
      const open = masked.indexOf("{", nameEnd - body.length)
      endIdx = open < 0 ? statementEnd({ masked, from: nameEnd }) : matchBrace({ masked, open })
    } else endIdx = statementEnd({ masked, from: nameEnd })
    decls.push({
      name,
      kind: body === "interface" ? "interface" : body === "struct" ? "struct" : "type",
      exported: exported(name),
      startIdx: match.index,
      endIdx,
      nameIdx: masked.indexOf(name, match.index),
      selfWords: [],
      member: false,
    })
  }
  for (const match of masked.matchAll(GO_VALUE)) {
    const name = match[1] as string
    const nameEnd = match.index + match[0].length
    decls.push({ name, kind: "variable", exported: exported(name), startIdx: match.index, endIdx: statementEnd({ masked, from: nameEnd }), nameIdx: nameEnd - name.length, selfWords: [], member: false })
  }
  const topLevel = decls.filter((decl) => lines.depth[lineAt({ starts: lines.starts, offset: decl.startIdx })] === 0)
  return { imports: [...imports], ...finalizeDecls({ masked, lines, decls: topLevel, options: GO_CALLS }) }
}

const RUST_KEYWORDS = new Set(["if", "while", "for", "match", "loop", "fn", "return", "Some", "Ok", "Err", "Box", "Vec", "String", "Option", "Result", "impl", "where", "unsafe", "move", "let", "in", "as"])
const RUST_CALLS: CallOptions = { generics: false, keywords: RUST_KEYWORDS, declarationWords: new Set(["fn", "struct", "enum", "trait", "type", "mod"]) }
const RUST_ITEM =
  /^[ \t]*(pub(?:\([^)]*\))?[ \t]+)?(?:(?:async|unsafe|const|extern(?:[ \t]+"[^"\n]*")?)[ \t]+)*(fn|struct|enum|trait|union|type|mod|static|const)[ \t]+(?:mut[ \t]+)?([A-Za-z_]\w*)/gm
const RUST_IMPL = /^[ \t]*(?:unsafe[ \t]+)?impl\b(?:<[^>{\n]*>)?[ \t]+(?:!?([\w:<>, &']+?)[ \t]+for[ \t]+)?([A-Za-z_][\w:]*)/gm
const RUST_FN = /^[ \t]*(pub(?:\([^)]*\))?[ \t]+)?(?:(?:async|unsafe|const|extern(?:[ \t]+"[^"\n]*")?)[ \t]+)*fn[ \t]+([A-Za-z_]\w*)/gm
const RUST_USE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm

/** `fn` items one level inside an impl or trait body spanning `from`..`to`. */
function rustMembers({ masked, lines, parent, from, to }: { masked: string; lines: ReturnType<typeof indexLines>; parent: string; from: number; to: number }): Decl[] {
  const out: Decl[] = []
  for (const fn of masked.slice(0, to).matchAll(RUST_FN)) {
    if (fn.index < from || lines.depth[lineAt({ starts: lines.starts, offset: fn.index })] !== 1) continue
    const name = fn[2] as string
    const nameEnd = fn.index + fn[0].length
    out.push({
      name,
      kind: "method",
      exported: fn[1] !== undefined,
      parent,
      startIdx: fn.index,
      endIdx: findBody({ masked, from: nameEnd }) ?? statementEnd({ masked, from: nameEnd }),
      nameIdx: nameEnd - name.length,
      selfWords: ["self", "Self"],
      member: true,
    })
  }
  return out
}

function scanRust({ text }: { text: string }): ScanResult {
  const masked = maskCode(text, RUST_MASK)
  const lines = indexLines(masked)
  const imports = new Set<string>()
  for (const match of masked.matchAll(RUST_USE)) imports.add((match[1] as string).replace(/\s+/g, " ").trim())
  const decls: Decl[] = []
  const depthAt = (offset: number) => lines.depth[lineAt({ starts: lines.starts, offset })]
  for (const match of masked.matchAll(RUST_ITEM)) {
    if (depthAt(match.index) !== 0) continue
    const word = match[2] as string
    const name = match[3] as string
    const nameEnd = match.index + match[0].length
    const braced = word === "fn" || word === "struct" || word === "enum" || word === "trait" || word === "union" || word === "mod"
    const endIdx = braced ? (findBody({ masked, from: nameEnd }) ?? statementEnd({ masked, from: nameEnd })) : statementEnd({ masked, from: nameEnd })
    const kind = word === "fn" ? "function" : word === "mod" ? "namespace" : word === "static" || word === "const" ? "variable" : word === "union" ? "struct" : (word as Decl["kind"])
    decls.push({ name, kind, exported: match[1] !== undefined, startIdx: match.index, endIdx, nameIdx: nameEnd - name.length, selfWords: [], member: false })
    if (word === "trait") decls.push(...rustMembers({ masked, lines, parent: name, from: nameEnd, to: endIdx }))
  }
  for (const match of masked.matchAll(RUST_IMPL)) {
    if (depthAt(match.index) !== 0) continue
    const name = match[2] as string
    const nameEnd = match.index + match[0].length
    const endIdx = findBody({ masked, from: nameEnd })
    if (endIdx === undefined) continue
    const typeName = name.split("::").pop() as string
    decls.push({ name: typeName, kind: "impl", exported: false, startIdx: match.index, endIdx, nameIdx: nameEnd - name.length, selfWords: [], member: false })
    decls.push(...rustMembers({ masked, lines, parent: typeName, from: nameEnd, to: endIdx }))
  }
  return { imports: [...imports], ...finalizeDecls({ masked, lines, decls, options: RUST_CALLS }) }
}

const SWIFT_KEYWORDS = new Set(["if", "guard", "while", "for", "switch", "catch", "func", "return", "init", "super", "self", "in", "is", "as", "try", "await", "throw", "where", "case", "let", "var", "defer", "repeat"])
const SWIFT_CALLS: CallOptions = { generics: false, keywords: SWIFT_KEYWORDS, declarationWords: new Set(["func", "class", "struct", "enum", "protocol", "extension", "actor", "typealias"]) }
const SWIFT_PREFIX = String.raw`^[ \t]*((?:@\w+(?:\([^)\n]*\))?[ \t]+|(?:public|open|internal|private|fileprivate|package|final|static|class|override|mutating|nonmutating|nonisolated|indirect|required|convenience|dynamic|distributed)(?:\(set\))?[ \t]+)*)`
const SWIFT_ITEM = new RegExp(`${SWIFT_PREFIX}(func|class|struct|enum|protocol|extension|actor|typealias|var|let)[ \\t]+([A-Za-z_][\\w.]*)`, "gm")
const SWIFT_INIT = new RegExp(`${SWIFT_PREFIX}(init)[?!]?[ \\t]*[(<]`, "gm")
const SWIFT_IMPORT = /^[ \t]*(?:@\w+[ \t]+)*import[ \t]+(?:(?:struct|class|enum|protocol|typealias|func|let|var)[ \t]+)?([\w.]+)/gm
const SWIFT_KIND: Record<string, Decl["kind"]> = { func: "function", class: "class", actor: "class", struct: "struct", enum: "enum", protocol: "interface", extension: "impl", typealias: "type", var: "variable", let: "variable" }
const SWIFT_TYPES = new Set(["class", "actor", "struct", "enum", "protocol", "extension"])

/**
 * Types at any nesting, their `func` and `init` members, and top-level functions and values. Stored properties and locals are left out.
 * Everything not marked `private` or `fileprivate` counts as exported: a Swift module sees it without an import.
 */
function scanSwift({ text }: { text: string }): ScanResult {
  const masked = maskCode(text, SWIFT_MASK)
  const lines = indexLines(masked)
  const depthAt = (offset: number) => lines.depth[lineAt({ starts: lines.starts, offset })] ?? 0
  const visible = (modifiers: string) => !/\b(?:private|fileprivate)\b(?!\(set\))/.test(modifiers)
  const decls: Decl[] = []
  /** Type bodies still open at the offset being read, outermost first. */
  const open: Array<{ name: string; depth: number; end: number }> = []
  const found = [...masked.matchAll(SWIFT_ITEM), ...masked.matchAll(SWIFT_INIT)].sort((a, b) => a.index - b.index)
  for (const match of found) {
    while (open.length > 0 && match.index >= open[open.length - 1]!.end) open.pop()
    const owner = open[open.length - 1]
    const depth = depthAt(match.index)
    // Directly in the file or directly in a type body; anything deeper is a local of a function.
    if (depth !== (owner ? owner.depth + 1 : 0)) continue
    const word = match[2] as string
    const nameEnd = word === "init" ? match.index + match[0].length - 1 : match.index + match[0].length
    const written = word === "init" ? "init" : (match[3] as string)
    const name = written.split(".").pop() as string
    const kind = SWIFT_KIND[word] ?? "method"
    if (kind === "variable" && owner) continue
    const braced = kind !== "variable" && kind !== "type"
    const endIdx = braced ? (findBody({ masked, from: nameEnd }) ?? statementEnd({ masked, from: nameEnd })) : statementEnd({ masked, from: nameEnd })
    const member = owner !== undefined && (kind === "function" || word === "init")
    decls.push({
      name,
      kind: member ? "method" : kind,
      exported: visible(match[1] ?? ""),
      ...(member ? { parent: owner.name } : {}),
      startIdx: match.index,
      endIdx,
      nameIdx: word === "init" ? masked.indexOf("init", match.index + (match[1]?.length ?? 0)) : nameEnd - written.length,
      selfWords: member ? ["self", "Self"] : [],
      member,
    })
    if (SWIFT_TYPES.has(word)) open.push({ name, depth, end: endIdx })
  }
  const imports = new Set<string>()
  for (const match of masked.matchAll(SWIFT_IMPORT)) imports.add(match[1] as string)
  return { imports: [...imports], ...finalizeDecls({ masked, lines, decls, options: SWIFT_CALLS }) }
}

/** Declarations, imports and calls of one source file (the indexer's own scanner; no native parser). */
export function scanSource({ path, text }: { path: string; text: string }): ScanResult | undefined {
  const language = languageOf(path)
  if (language === "typescript" || language === "javascript") return scanScript({ text, path })
  if (language === "python") return scanPython({ text })
  if (language === "go") return scanGo({ text })
  if (language === "rust") return scanRust({ text })
  if (language === "swift") return scanSwift({ text })
  return undefined
}
