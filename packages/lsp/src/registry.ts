import { readFile } from "node:fs/promises"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { z } from "zod"
import { WEB_SERVERS } from "./web-presets"
import { OTHER_LANGUAGE_IDS, OTHER_SERVERS } from "./other-presets"

export type LspServerSpec = {
  id: string
  /** Command and arguments; the first entry is looked up on PATH. */
  command: string[]
  /** Tried in order when `command[0]` is not installed. */
  fallbacks?: string[][]
  /** Extensions including the dot, lowercase. */
  extensions: string[]
  filenames?: string[]
  enabled?: boolean
  /** Files whose presence marks a project root, nearest ancestor wins. */
  rootMarkers: string[]
  rootRequired?: boolean
  rootExcludes?: string[]
  rootGroups?: string[][]
  rootFallback?: "git"
  env?: Record<string, string>
  initialization?: Record<string, unknown>
  bootstrap?: boolean
  disableDownload?: boolean
}

export type LspIssue = { source: string; server?: string; message: string }
export type LoadedRegistry = { servers: LspServerSpec[]; issues: LspIssue[]; disableDownload?: boolean }

export const DEFAULT_SERVERS: readonly LspServerSpec[] = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    rootExcludes: ["deno.json", "deno.jsonc"],
  },
  {
    id: "python",
    command: ["pyright-langserver", "--stdio"],
    fallbacks: [["basedpyright-langserver", "--stdio"]],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pyrightconfig.json"],
  },
  { id: "go", command: ["gopls"], extensions: [".go"], rootMarkers: ["go.work", "go.mod"] },
  { id: "rust", command: ["rust-analyzer"], extensions: [".rs"], rootMarkers: ["Cargo.toml"] },
  ...WEB_SERVERS,
  ...OTHER_SERVERS,
]

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
  ".vue": "vue", ".svelte": "svelte", ".astro": "astro", ".yaml": "yaml", ".yml": "yaml", ".lua": "lua",
  ".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript", ".ksh": "shellscript",
  ".json": "json", ".jsonc": "jsonc", ".css": "css", ".graphql": "graphql", ".gql": "graphql", ".html": "html",
  ...OTHER_LANGUAGE_IDS,
}

export function matchesFile(spec: LspServerSpec, file: string): boolean {
  return spec.enabled !== false && (spec.extensions.includes(extname(file).toLowerCase()) || spec.filenames?.includes(basename(file)) === true)
}

export function languageIdForFile(file: string, server?: string): string {
  const extension = extname(file)
  return basename(file) === "Dockerfile" ? "dockerfile" : extension ? languageIdFor(extension) : server ?? ""
}

/** LSP `languageId` for a file extension (the extension itself, without the dot, when unknown). */
export function languageIdFor(extension: string): string {
  return LANGUAGE_IDS[extension.toLowerCase()] ?? extension.replace(/^\./, "")
}

const overrideSchema = z.object({
  command: z.array(z.string().min(1)).min(1).optional(),
  extensions: z.array(z.string().regex(/^\.[^./\\]+$/, 'extensions look like ".ts"')).min(1).optional(),
  filenames: z.array(z.string().min(1).regex(/^[^/\\]+$/)).optional(),
  rootMarkers: z.array(z.string().min(1)).optional(),
  rootRequired: z.boolean().optional(),
  rootExcludes: z.array(z.string().min(1)).optional(),
  disabled: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  initialization: z.record(z.string(), z.unknown()).optional(),
  bootstrap: z.boolean().optional(),
  disableDownload: z.boolean().optional(),
})
const fileSchema = z.object({ servers: z.record(z.string(), z.unknown()).default({}), disabled: z.boolean().optional(), disableDownload: z.boolean().optional() })

/** Defaults plus `<directory>/.mendcode/lsp.json`. Invalid entries are reported, never thrown; `disabled` servers are dropped. */
export async function loadLspRegistry({ directory }: { directory: string }): Promise<LoadedRegistry> {
  const issues: LspIssue[] = []
  let disableDownload = process.env.MENDCODE_DISABLE_LSP_DOWNLOAD === "1"
  const byId = new Map<string, LspServerSpec>(DEFAULT_SERVERS.map((spec) => [spec.id, { ...spec, ...(spec.id === "ty" ? { enabled: process.env.MENDCODE_EXPERIMENTAL_LSP_TY === "1" } : {}) }]))
  const path = join(directory, ".mendcode", "lsp.json")
  let text: string | undefined
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") issues.push({ source: path, message: `cannot read file: ${(error as Error).message}` })
  }
  if (text !== undefined) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      issues.push({ source: path, message: `invalid JSON: ${(error as Error).message}` })
    }
    if (json === false) return { servers: [], issues, disableDownload }
    if (json === true) json = { servers: {} }
    const file = json === undefined ? undefined : fileSchema.safeParse(json)
    if (file && !file.success) issues.push({ source: path, message: 'expected { "servers": { "<id>": { ... } } }' })
    if (file?.success) {
      disableDownload = file.data.disableDownload ?? disableDownload
      if (file.data.disabled) return { servers: [], issues, disableDownload }
      for (const [name, raw] of Object.entries(file.data.servers)) {
        const id = name === "gopls" ? "go" : name === "pyright" ? "python" : name
        const parsed = overrideSchema.safeParse(raw)
        if (!parsed.success) {
          issues.push({ source: path, server: id, message: `invalid server config: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` })
          continue
        }
        const override = parsed.data
        if (override.disabled) {
          byId.delete(id)
          continue
        }
        const base = byId.get(id)
        const command = override.command ?? base?.command
        const extensions = (override.extensions ?? base?.extensions)?.map((e) => e.toLowerCase())
        if (!command || !extensions) {
          issues.push({ source: path, server: id, message: "a new server needs both command and extensions" })
          continue
        }
        const spec: LspServerSpec = { ...base, id, command, extensions, rootMarkers: override.rootMarkers ?? base?.rootMarkers ?? [] }
        if (override.disabled === false) spec.enabled = true
        if (override.filenames) spec.filenames = override.filenames
        if (override.rootMarkers) delete spec.rootGroups
        if (override.command) delete spec.fallbacks
        if (override.rootRequired !== undefined) spec.rootRequired = override.rootRequired
        if (override.rootExcludes) spec.rootExcludes = override.rootExcludes
        if (override.env) spec.env = override.env
        if (override.initialization) spec.initialization = override.initialization
        if (override.bootstrap !== undefined) spec.bootstrap = override.bootstrap
        if (override.disableDownload !== undefined) spec.disableDownload = override.disableDownload
        byId.set(id, spec)
      }
    }
  }
  return { servers: [...byId.values()], issues, disableDownload }
}

/** The command to run for a spec: the first candidate whose binary `which` finds, or undefined. */
export function resolveCommand({ spec, which = Bun.which }: { spec: LspServerSpec; which?: (binary: string) => string | null }): string[] | undefined {
  for (const candidate of [spec.command, ...(spec.fallbacks ?? [])]) {
    const binary = candidate[0]
    if (binary && which(binary)) return candidate
  }
  return undefined
}

/** Nearest ancestor of `file` (not above `cwd` when the file is inside it) holding a root marker, else `cwd`. */
export async function findRoot({ file, cwd, markers, exists }: { file: string; cwd: string; markers: string[]; exists: (path: string) => Promise<boolean> }): Promise<string> {
  const top = resolve(cwd)
  const inside = resolve(file).startsWith(top + sep)
  let dir = dirname(resolve(file))
  for (;;) {
    for (const marker of markers) if (await exists(join(dir, marker))) return dir
    if (dir === top || dirname(dir) === dir) break
    dir = dirname(dir)
    if (inside && !(dir === top || dir.startsWith(top + sep))) break
  }
  return top
}
