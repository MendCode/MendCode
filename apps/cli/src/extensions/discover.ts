import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { EXTENSIONS_DIR } from "@mendcode/extension-api"
import { discoverPluginFiles, type PluginFile } from "@mendcode/extension-api/plugin-files"

/**
 * Finds extension modules on disk: `<layer>/extensions/*.ts|js` and `<layer>/extensions/<name>/index.ts|js` for the
 * user dir, its packages, the project's `.mendcode/` and the project's packages. Pure filesystem; it imports nothing
 * from the extensions it finds, so a terminal without any pays one failed `existsSync` per layer and loads nothing.
 */

export type ExtensionSource = "user" | "project"

export type ExtensionFile = {
  /** The module to import. */
  file: string
  /** The extension's own directory: its folder, or `extensions/` for a single file. */
  dir: string
  source: ExtensionSource
  /** The package that ships it, if any. */
  pkg?: string
  plugin?: PluginFile["plugin"]
}

/** Same rule as the daemon's package loader (packages/src/layers.ts). */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PACKAGES_DIR = "packages"
const MODULE_FILE = /^[^.].*\.(ts|js)$/
const INDEX_FILES = ["index.ts", "index.js"]

function isDirectory(target: string) {
  return statSync(target, { throwIfNoEntry: false })?.isDirectory() === true
}

/** The modules of one `extensions/` folder, sorted by name. */
function modulesIn(root: string, source: ExtensionSource, pkg?: string, off: ReadonlySet<string> = new Set()): ExtensionFile[] {
  if (!isDirectory(root)) return []
  const found: ExtensionFile[] = []
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || (pkg && off.has(`${source}:${pkg}/extensions/${name.replace(/\.(ts|js)$/, "")}`))) continue
    const entry = path.join(root, name)
    const base = { source, ...(pkg ? { pkg } : {}) }
    if (isDirectory(entry)) {
      const index = INDEX_FILES.find((candidate) => existsSync(path.join(entry, candidate)))
      if (index) found.push({ file: path.join(entry, index), dir: entry, ...base })
    } else if (MODULE_FILE.test(name) && !name.endsWith(".d.ts")) found.push({ file: entry, dir: root, ...base })
  }
  return found
}

function packageRoots(root: string): Array<{ name: string; dir: string }> {
  if (!isDirectory(root)) return []
  return readdirSync(root)
    .sort()
    .filter((name) => PACKAGE_NAME.test(name) && isDirectory(path.join(root, name)))
    .map((name) => ({ name, dir: path.join(root, name) }))
}

/**
 * Every extension module for a terminal, in load order: user, user packages, project packages, project.
 * `disabled` holds `user:name` / `project:name` keys (the daemon's `disabledPackages`); those packages are skipped.
 * Project modules are listed with `source: "project"`; the caller decides whether the directory is trusted.
 */
export function discoverExtensions(input: { dataDir: string; directory?: string | undefined; disabled?: readonly string[] | undefined; disabledResources?: readonly string[] | undefined }): ExtensionFile[] {
  const off = new Set(input.disabled ?? [])
  const resourcesOff = new Set(input.disabledResources ?? [])
  const packages = (source: ExtensionSource, root: string) =>
    packageRoots(root)
      .filter(({ name }) => !off.has(`${source}:${name}`))
      .flatMap(({ name, dir }) => [...modulesIn(path.join(dir, EXTENSIONS_DIR), source, name, resourcesOff), ...discoverPluginFiles(dir, input.dataDir, "tui").map((file) => ({ ...file, source, pkg: name }))])
  // Same order as the daemon's layers (packages/packages/src/layers.ts): the user's packages, then the user's own folder, then the project's packages, then its own folder. Later wins.
  const user = [...packages("user", path.join(input.dataDir, PACKAGES_DIR)), ...modulesIn(path.join(input.dataDir, EXTENSIONS_DIR), "user"), ...discoverPluginFiles(input.dataDir, input.dataDir, "tui").map((file) => ({ ...file, source: "user" as const }))]
  if (!input.directory) return user
  const project = path.join(input.directory, ".mendcode")
  return [...user, ...packages("project", path.join(project, PACKAGES_DIR)), ...modulesIn(path.join(project, EXTENSIONS_DIR), "project"), ...[project, input.directory].flatMap((root) => discoverPluginFiles(root, input.dataDir, "tui").map((file) => ({ ...file, source: "project" as const })))]
}

/** The path the daemon stores trusted project roots under (its `canonicalDir`): absolute, symlinks resolved. */
export function canonicalDirectory(directory: string): string {
  const absolute = path.resolve(directory)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export type ActivationManifest = { key: string; source: ExtensionSource; name: string; dir: string; manifest: Record<string, unknown> }

/**
 * Enabled packages whose manifest declares `"activate"` (the activation profile, docs/packages.md), in layer order: user
 * packages, then project packages. A substring test first, so a terminal without any pays one small read per package and
 * never parses or loads the activation code (extensions/activation.ts). Project packages are listed; the caller applies trust.
 */
export function activationManifests(input: { dataDir: string; directory?: string | undefined; disabled?: readonly string[] | undefined }): ActivationManifest[] {
  const off = new Set(input.disabled ?? [])
  const found: ActivationManifest[] = []
  const scan = (source: ExtensionSource, root: string) => {
    for (const { name, dir } of packageRoots(root)) {
      if (off.has(`${source}:${name}`)) continue
      try {
        const text = readFileSync(path.join(dir, "mendcode-package.json"), "utf8")
        if (text.length > 32 * 1024 || !text.includes('"activate"')) continue
        const manifest: unknown = JSON.parse(text)
        if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest) && "activate" in manifest) found.push({ key: `${source}:${name}`, source, name, dir, manifest: manifest as Record<string, unknown> })
      } catch {
        // No manifest, or not JSON: the package has no activation (`package check` reports a broken manifest).
      }
    }
  }
  scan("user", path.join(input.dataDir, PACKAGES_DIR))
  if (input.directory) scan("project", path.join(input.directory, ".mendcode", PACKAGES_DIR))
  return found
}
