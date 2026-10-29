import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { SWITCHABLE_KINDS } from "@mendcode/protocol/wire"

/**
 * Where extensions are discovered. Every loader (skills, commands, custom tools, MCP) reads the same kind
 * folder (`skills/`, `commands/`, `tools/`, `mcp.json`) in each layer, lowest precedence first:
 * user packages → the user's own files → project packages → the project's own files. A later layer wins
 * on name collisions, so what the user or project writes always overrides what a package ships.
 */
export type ExtensionSource = "user" | "project"

export type ExtensionLayer = {
  /** The folder that holds the kind folders: the data dir, `<project>/.mendcode`, or a package root. */
  dir: string
  source: ExtensionSource
  /** Set for a package layer. */
  pkg?: string
  /** Resources of this package layer turned off (`skills/foo`, `commands/review`, …); loaders skip them. */
  off?: readonly string[]
  /**
   * Set on `.agents` and `.claude` layers (see `foreignLayers`): data only, and only the listed kinds are read
   * (skills, commands, agents). Only the skill, command and agent loaders are given these layers.
   */
  foreign?: { kinds: readonly ResourceKind[]; origin: "agents" | "claude" | "parent" }
}

/** The kinds one resource of which can be switched off: the switchable rows of the one table of package kinds (`PACKAGE_KINDS`). */
export const RESOURCE_KINDS = SWITCHABLE_KINDS
export type ResourceKind = (typeof SWITCHABLE_KINDS)[number]

/** `skills/foo`: how one resource of a package is addressed. */
export const resourceId = (kind: ResourceKind, name: string) => `${kind}/${name}`

/** `user:pkg/skills/foo`: a resource id under its package key, as stored in `Settings.disabledPackageResources`. */
export const resourceKey = (pkgKey: string, id: string) => `${pkgKey}/${id}`

/** Whether a loader may use `name` of `kind` from this layer; only package layers carry switches. */
export const layerAllows = (layer: Pick<ExtensionLayer, "off">, kind: ResourceKind, name: string) => !layer.off?.includes(resourceId(kind, name))

export const PACKAGES_DIR = "packages"
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** `user:name` / `project:name`: how a package is addressed for enable/disable. */
export const packageKey = (source: ExtensionSource, name: string) => `${source}:${name}`

/** The folder a scope keeps its own files in: the data dir, or `<project>/.mendcode` (packages, Trash and activation state live under it). */
export function scopeBase({ source, userDir, directory }: { source: ExtensionSource; userDir: string; directory: string }) {
  return source === "user" ? userDir : path.join(directory, ".mendcode")
}

export function packagesRoot({ source, userDir, directory }: { source: ExtensionSource; userDir: string; directory: string }) {
  return path.join(scopeBase({ source, userDir, directory }), PACKAGES_DIR)
}

/** Installed package folders of one scope, sorted by name; folders with an invalid name are skipped. */
export function packageDirs(root: string): Array<{ name: string; dir: string }> {
  if (!existsSync(root)) return []
  const found: Array<{ name: string; dir: string }> = []
  for (const name of readdirSync(root).sort()) {
    if (!PACKAGE_NAME.test(name)) continue
    const dir = path.join(root, name)
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) found.push({ name, dir })
  }
  return found
}

/** What ships with MendCode itself (e.g. the skill that teaches extending it); below everything the user installs. */
export const BUILTIN_PACKAGE = "builtin"

/** The layers for a project, lowest precedence first. Disabled packages are left out. */
export function extensionLayers({ userDir, directory, disabled = [], disabledResources = [], builtinDir }: { userDir: string; directory: string; disabled?: readonly string[]; disabledResources?: readonly string[]; builtinDir?: string }): ExtensionLayer[] {
  const off = new Set(disabled)
  const resourcesOff = (key: string) => disabledResources.filter((entry) => entry.startsWith(`${key}/`)).map((entry) => entry.slice(key.length + 1))
  const packages = (source: ExtensionSource): ExtensionLayer[] =>
    packageDirs(packagesRoot({ source, userDir, directory }))
      .filter(({ name }) => !off.has(packageKey(source, name)))
      .map(({ name, dir }) => {
        const resources = resourcesOff(packageKey(source, name))
        return { dir, source, pkg: name, ...(resources.length ? { off: resources } : {}) }
      })
  const builtin: ExtensionLayer[] = builtinDir ? [{ dir: builtinDir, source: "user", pkg: BUILTIN_PACKAGE }] : []
  return [...builtin, ...packages("user"), { dir: userDir, source: "user" }, ...packages("project"), { dir: path.join(directory, ".mendcode"), source: "project" }]
}

/** The layers a loader sees when it is not given any: just the user's and the project's own folders. */
export function defaultLayers({ userDir, directory }: { userDir: string; directory: string }): ExtensionLayer[] {
  return [
    { dir: userDir, source: "user" },
    { dir: path.join(directory, ".mendcode"), source: "project" },
  ]
}

/** Whether a layer's files are in another tool's format (`.claude`, `.agents`); a parent folder's `.mendcode` is MendCode's own. */
export const claudeFormat = (layer: Pick<ExtensionLayer, "foreign">) => layer.foreign !== undefined && layer.foreign.origin !== "parent"

/** Whether a loader should read `kind` from this layer: native layers hold every kind, foreign ones only what they declare. */
export const layerReads = (layer: Pick<ExtensionLayer, "foreign">, kind: ResourceKind) => !layer.foreign || layer.foreign.kinds.includes(kind)

/**
 * Resource folders other agents use: `.agents/skills`, and `.claude/{skills,commands,agents}`, in the project and
 * (when `home` is given) the user's home. They are prompt data, never code: no tools, hooks, MCP or extensions are read from them.
 * A project folder that is a symlink leaving the project is skipped. Lowest precedence first.
 */
export function foreignLayers({ directory, home }: { directory: string; home?: string | undefined }): { user: ExtensionLayer[]; project: ExtensionLayer[] } {
  const make = (base: string, source: ExtensionSource, confine?: string): ExtensionLayer[] => {
    const layers: ExtensionLayer[] = []
    for (const [name, origin, kinds] of [[".agents", "agents", ["skills"]], [".claude", "claude", ["skills", "commands", "agents"]]] as const) {
      const dir = path.join(base, name)
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
      if (confine) {
        try {
          const rel = path.relative(realpathSync(confine), realpathSync(dir))
          if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) continue
        } catch { continue }
      }
      layers.push({ dir, source, foreign: { kinds, origin } })
    }
    return layers
  }
  return { user: home ? make(home, "user") : [], project: make(directory, "project", directory) }
}

/**
 * The `.mendcode` folders of the project's parent folders inside its repository, farthest first: opening `repo/apps/web`
 * also reads `repo/.mendcode` and `repo/apps/.mendcode`. Only skills, commands and agents (prompt data) are read from them,
 * the same as `.claude` folders. The walk stops at the folder holding `.git`; without one, at the home folder or the root
 * nothing is inherited, and the home folder itself (where other programs keep data) is never read.
 */
export function ancestorLayers({ directory, home = homedir() }: { directory: string; home?: string }): ExtensionLayer[] {
  const chain: string[] = []
  let current = path.dirname(path.resolve(directory))
  // Inside the project's own repository the project folder is the root: nothing above it is read.
  if (existsSync(path.join(path.resolve(directory), ".git"))) return []
  while (current !== path.dirname(current) && current !== home) {
    chain.push(current)
    if (existsSync(path.join(current, ".git"))) {
      return chain.reverse()
        .filter((dir) => statSync(path.join(dir, ".mendcode"), { throwIfNoEntry: false })?.isDirectory())
        .map((dir) => ({ dir: path.join(dir, ".mendcode"), source: "project" as const, foreign: { kinds: ["skills", "commands", "agents"] as const, origin: "parent" as const } }))
    }
    current = path.dirname(current)
  }
  return []
}

/**
 * `layers` with the foreign ones placed under the native layer of the same scope: the user's `.agents`/`.claude`
 * below the user's own folder, the project's below the project's `.mendcode`, so MendCode's own files always win.
 */
export function withForeignLayers(layers: ExtensionLayer[], foreign: { user: ExtensionLayer[]; project: ExtensionLayer[] }, userDir: string): ExtensionLayer[] {
  if (!foreign.user.length && !foreign.project.length) return layers
  const userAt = layers.findIndex((layer) => !layer.pkg && layer.source === "user" && layer.dir === userDir)
  const projectAt = layers.findLastIndex((layer) => !layer.pkg && layer.source === "project")
  const out: ExtensionLayer[] = []
  layers.forEach((layer, index) => {
    if (index === userAt) out.push(...foreign.user)
    if (index === projectAt) out.push(...foreign.project)
    out.push(layer)
  })
  if (userAt < 0) out.unshift(...foreign.user)
  if (projectAt < 0) out.push(...foreign.project)
  return out
}
