export const LANGUAGES = ["typescript", "javascript", "python", "go", "rust", "swift"] as const
export type Language = (typeof LANGUAGES)[number]

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "variable" | "struct" | "trait" | "impl" | "namespace"

export const SYMBOL_KINDS: ReadonlySet<string> = new Set<SymbolKind>([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "struct",
  "trait",
  "impl",
  "namespace",
])

/** One declaration of a file. `start`/`end` are 1-based lines; 0 means the source gave no span. */
export type SymbolRec = {
  name: string
  kind: SymbolKind
  start: number
  end: number
  exported: boolean
  parent?: string | undefined
  /** Set by the graft source, which has its own ids. */
  id?: string | undefined
}

/** A call made inside `symbols[from]`: by name (resolved when the graph is derived) or to a known `target` id. */
export type CallRec = {
  from: number
  name: string
  /** `this.name(` / `self.name(`: a sibling method of the caller's type. */
  self?: boolean | undefined
  /** `Type.name(` / `Type::name(`: a method of the named type. */
  qualifier?: string | undefined
  /** With `qualifier`: reached through `.` (so an unmatched one is a library call, never a project function). */
  dot?: boolean | undefined
  target?: string | undefined
}

export type ImportBinding = { local: string; imported: string; source: string }
export type ExportBinding = { exported: string; local: string; source?: string | undefined }

export type FileRec = {
  mtimeMs: number
  ctimeMs: number
  size: number
  language: Language
  source: "scan" | "graft"
  /** Raw import specifiers (relative paths, packages, or repo paths from graft). */
  imports: string[]
  bindings?: ImportBinding[] | undefined
  exports?: ExportBinding[] | undefined
  symbols: SymbolRec[]
  calls: CallRec[]
}

export type WorkspacePackage = { name: string; dir: string; entries: Record<string, string[]> }

export const CACHE_VERSION = 2
export type CacheFile = {
  version: typeof CACHE_VERSION
  cwd: string
  builtAt: number
  /** mtime of the graft wiring.json the graft-sourced records came from, or null. */
  graftMtimeMs: number | null
  graftStamp?: string | null | undefined
  partial: boolean
  files: Record<string, FileRec>
  packages?: WorkspacePackage[] | undefined
}

export const EXTENSION_LANGUAGE: Readonly<Record<string, Language>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".swift": "swift",
}

export const MAX_INDEXED_FILES = 20_000
export const MAX_FILE_BYTES = 512 * 1024
export const MAX_RESULTS = 50
