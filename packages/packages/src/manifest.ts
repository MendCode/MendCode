import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { PackageAuthorManifest } from "@mendcode/protocol"
import { packageDirs, packageKey, packagesRoot, PACKAGE_NAME, type ExtensionSource } from "./layers"

export const MANIFEST_FILE = "mendcode-package.json"
export const INSTALL_RECORD_FILE = ".mendcode-install.json"
const MAX_MANIFEST_BYTES = 32 * 1024

export const packageManifestSchema = z.strictObject({
  name: z.string().regex(PACKAGE_NAME, "lowercase letters, digits, . _ - (max 64)"),
  version: z.string().min(1).max(40),
  description: z.string().min(1).max(500),
  author: z.string().max(200).optional(),
  homepage: z.string().max(500).optional(),
  license: z.string().max(100).optional(),
  /** `true` when the package ships TypeScript extensions in `extensions/` (code that runs in the daemon), `false` for none. Checked at install. */
  extensions: z.boolean().optional(),
  capabilities: z.array(z.enum(["hooks", "tools", "commands", "network", "processes", "filesystem"])).max(32).optional(),
}).extend(PackageAuthorManifest.shape)
export type PackageManifest = z.infer<typeof packageManifestSchema>

export const installRecordSchema = z.object({ source: z.string(), commit: z.string().optional(), integrity: z.string().optional(), pinned: z.boolean().optional(), installedAt: z.number() })
export type InstallRecord = z.infer<typeof installRecordSchema>

/** What a package adds, counted from its kind folders (nothing is loaded or run to count it). */
export type PackageContents = { tools: number; skills: number; commands: number; themes: number; mcp: boolean; extensions: number; agents: number }

export type PackageInfo = {
  name: string
  source: ExtensionSource
  key: string
  dir: string
  enabled: boolean
  manifest?: PackageManifest
  install?: InstallRecord
  contents: PackageContents
  /** Why the manifest cannot be used; the package's files still load, like any folder of extensions. */
  problem?: string
}

export function readManifest(dir: string): { manifest: PackageManifest } | { problem: string } {
  const file = path.join(dir, MANIFEST_FILE)
  const size = statSync(file, { throwIfNoEntry: false })?.size
  if (size === undefined) return { problem: `no ${MANIFEST_FILE}` }
  if (size > MAX_MANIFEST_BYTES) return { problem: `${MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES / 1024} KB` }
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    return { problem: `invalid JSON in ${MANIFEST_FILE}: ${(error as Error).message}` }
  }
  const parsed = packageManifestSchema.safeParse(json)
  if (!parsed.success) return { problem: `invalid ${MANIFEST_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` }
  return { manifest: parsed.data }
}

function readInstallRecord(dir: string): InstallRecord | undefined {
  try {
    const parsed = installRecordSchema.safeParse(JSON.parse(readFileSync(path.join(dir, INSTALL_RECORD_FILE), "utf8")))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])

function countMarkdown(dir: string): number {
  let count = 0
  for (const entry of entries(dir)) count += entry.isDirectory() ? countMarkdown(path.join(dir, entry.name)) : entry.name.endsWith(".md") ? 1 : 0
  return count
}

const EXTENSION_FILE = /\.(ts|js)$/

/** The extension modules the daemon would find (`extensions/*.ts|js`, `extensions/<name>/index.ts|js`), counted without importing any. */
function countExtensions(dir: string): number {
  const root = path.join(dir, "extensions")
  return entries(root).filter((entry) => {
    if (entry.name.startsWith(".")) return false
    if (entry.isFile()) return EXTENSION_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")
    return entry.isDirectory() && ["index.ts", "index.js"].some((file) => existsSync(path.join(root, entry.name, file)))
  }).length
}

/** Why the manifest's `extensions` declaration and the folder disagree, if they do: a package must say honestly whether it ships code. */
export function extensionsProblem({ manifest, dir }: { manifest: PackageManifest; dir: string }): string | undefined {
  if (manifest.extensions === undefined) return undefined
  const found = countExtensions(dir)
  if (manifest.extensions && found === 0) return `${MANIFEST_FILE} declares extensions but extensions/ has no extensions/*.ts|js or extensions/<name>/index.ts|js`
  if (!manifest.extensions && found > 0) return `${MANIFEST_FILE} declares no extensions but extensions/ holds ${found}`
  return undefined
}

export function packageContents(dir: string): PackageContents {
  return {
    tools: entries(path.join(dir, "tools")).filter((e) => e.isFile() && e.name.endsWith(".json")).length,
    skills: entries(path.join(dir, "skills")).filter((e) => e.isDirectory() && existsSync(path.join(dir, "skills", e.name, "SKILL.md"))).length,
    commands: countMarkdown(path.join(dir, "commands")),
    themes: entries(path.join(dir, "themes")).filter((e) => e.isFile() && e.name.endsWith(".json")).length,
    mcp: existsSync(path.join(dir, "mcp.json")),
    extensions: countExtensions(dir),
    agents: entries(path.join(dir, "agents")).filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".")).length,
  }
}

/** Every installed package of both scopes, user first, with what it adds and whether it is enabled. */
export function listPackages({ userDir, directory, disabled = [] }: { userDir: string; directory: string; disabled?: readonly string[] }): PackageInfo[] {
  const off = new Set(disabled)
  const out: PackageInfo[] = []
  for (const source of ["user", "project"] as const) {
    for (const { name, dir } of packageDirs(packagesRoot({ source, userDir, directory }))) {
      const read = readManifest(dir)
      const install = readInstallRecord(dir)
      const key = packageKey(source, name)
      const mismatch = "manifest" in read && read.manifest.name !== name ? `folder is "${name}" but ${MANIFEST_FILE} says "${read.manifest.name}"` : undefined
      out.push({
        name,
        source,
        key,
        dir,
        enabled: !off.has(key),
        ...("manifest" in read ? { manifest: read.manifest } : {}),
        ...(install ? { install } : {}),
        contents: packageContents(dir),
        ...("problem" in read ? { problem: read.problem } : mismatch ? { problem: mismatch } : {}),
      })
    }
  }
  return out
}
