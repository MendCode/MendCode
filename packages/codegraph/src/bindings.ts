import type { ExportBinding, ImportBinding } from "./types"
import { indexLines, lineAt } from "./mask"

const IDENT = /^[A-Za-z_$][\w$]*$/

/** The mask keeps string delimiters and offsets, so comments and string contents cannot invent imports. */
export function scriptBindings({ text, masked }: { text: string; masked: string }): { bindings: ImportBinding[]; exports: ExportBinding[] } {
  const bindings: ImportBinding[] = []
  const exports: ExportBinding[] = []
  const lines = indexLines(masked)
  const sourceOf = (match: RegExpMatchArray): string => {
    const raw = text.slice(match.index!, match.index! + match[0].length)
    const quote = Math.max(raw.lastIndexOf('"'), raw.lastIndexOf("'"))
    const start = raw.lastIndexOf(raw[quote]!, quote - 1)
    return raw.slice(start + 1, quote)
  }
  const names = (clause: string, separator: RegExp) => clause.split(",").flatMap((part) => {
    const value = part.trim()
    if (/^type\s/.test(value)) return []
    const [original, alias = original] = value.split(separator).map((word) => word.trim())
    return original && alias && IDENT.test(original) && IDENT.test(alias) ? [{ original, alias }] : []
  })
  for (const match of masked.matchAll(/^[ \t]*import\s+(?!type\s)([\w$*{},\s]+?)\s+from\s*(['"])[^'"]*\2/gm)) {
    const clause = match[1]!.trim()
    const source = sourceOf(match)
    const first = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)
    if (first) bindings.push({ local: first[1]!, imported: "default", source })
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (namespace) bindings.push({ local: namespace[1]!, imported: "*", source })
    const named = /\{([^}]*)\}/.exec(clause)
    if (named) for (const { original, alias } of names(named[1]!, /\s+as\s+/)) bindings.push({ local: alias, imported: original, source })
  }
  for (const match of masked.matchAll(/^[ \t]*(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])[^'"]*\2\s*\)/gm)) {
    if (lines.depth[lineAt({ starts: lines.starts, offset: match.index })] !== 0) continue
    const clause = match[1]!
    const source = sourceOf(match)
    if (clause.startsWith("{")) {
      for (const { original, alias } of names(clause.slice(1, -1), /\s*:\s*/)) bindings.push({ local: alias, imported: original, source })
    } else bindings.push({ local: clause, imported: "*", source })
  }
  for (const match of masked.matchAll(/^[ \t]*export\s*\{([^}]*)\}(?:\s*from\s*(['"])[^'"]*\2)?/gm)) {
    const source = match[2] ? sourceOf(match) : undefined
    for (const { original, alias } of names(match[1]!, /\s+as\s+/)) exports.push({ exported: alias, local: original, ...(source ? { source } : {}) })
  }
  for (const match of masked.matchAll(/^[ \t]*export\s+\*\s+from\s*(['"])[^'"]*\1/gm)) exports.push({ exported: "*", local: "*", source: sourceOf(match) })
  for (const match of masked.matchAll(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*(?=;|$)/gm)) exports.push({ exported: "default", local: match[1]! })
  return { bindings, exports }
}

/** Module-level Python aliases. Local/dynamic imports are deliberately not assigned global bindings. */
export function pythonBindings(masked: string): ImportBinding[] {
  const bindings: ImportBinding[] = []
  for (const match of masked.matchAll(/^import[ \t]+([^\n]+)/gm)) {
    for (const part of match[1]!.split(",")) {
      const [source, alias] = part.trim().split(/\s+as\s+/)
      if (source && /^[\w.]+$/.test(source) && (alias || !source.includes("."))) bindings.push({ local: alias ?? source, imported: "*", source })
    }
  }
  for (const match of masked.matchAll(/^from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm)) {
    for (const part of match[2]!.replace(/[()]/g, "").split(",")) {
      const [imported, alias] = part.trim().split(/\s+as\s+/)
      if (imported && IDENT.test(imported) && (!alias || IDENT.test(alias))) bindings.push({ local: alias ?? imported, imported, source: match[1]! })
    }
  }
  return bindings
}
