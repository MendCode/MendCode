import type { PackageSelection } from "./package-authoring-data"

/**
 * The one table of what a package folder (or any extension layer) can hold. Loaders, the installer's audit, the exporter
 * (`packages create`), `package check` and the scaffold read it, so they cannot disagree about what exists. A test fails when a
 * loader reads a path this table does not list. Data only, no imports at runtime: the thin client shares it.
 *
 * `paths` are what loaders read, relative to the layer root. `exportPaths` are extra places the exporter also copies for the
 * same selection (older layouts no loader reads any more). `executable` kinds run code or commands the user must trust.
 */
export type PackageKindSpec = {
  readonly id: string
  readonly label: string
  readonly paths: readonly string[]
  readonly exportPaths?: readonly string[]
  readonly selection?: PackageSelection
  readonly executable: boolean
  /** Can be switched on and off one by one (`Settings.disabledPackageResources`). */
  readonly switchable: boolean
  /** Who reads it: the daemon's loaders, the terminal, both, or nobody (exported and installed only). */
  readonly readBy: "daemon" | "terminal" | "both" | "none"
}

export const PACKAGE_KINDS = [
  { id: "pets", label: "Pets", paths: ["pets"], selection: "pets", executable: false, switchable: false, readBy: "terminal" },
  { id: "skills", label: "Skills", paths: ["skills"], selection: "skills", executable: false, switchable: true, readBy: "daemon" },
  { id: "commands", label: "Slash commands", paths: ["commands", "command"], selection: "commands", executable: false, switchable: true, readBy: "daemon" },
  { id: "agents", label: "Agents", paths: ["agents"], selection: "agents", executable: false, switchable: true, readBy: "daemon" },
  { id: "themes", label: "Themes", paths: ["themes"], selection: "themes", executable: false, switchable: true, readBy: "both" },
  { id: "tools", label: "Custom tools", paths: ["tools"], selection: "tools", executable: true, switchable: true, readBy: "daemon" },
  { id: "extensions", label: "Extensions and views", paths: ["extensions"], exportPaths: ["components", "scripts"], selection: "extensions", executable: true, switchable: true, readBy: "both" },
  { id: "config", label: "Command and plugin config", paths: ["mendcode.json", "mendcode.jsonc"], exportPaths: ["plugins"], selection: "plugins", executable: true, switchable: false, readBy: "both" },
  { id: "mcp", label: "MCP servers", paths: ["mcp.json"], exportPaths: ["mcp"], selection: "mcp", executable: true, switchable: false, readBy: "daemon" },
  { id: "hooks", label: "Shell hooks", paths: ["hooks.json"], selection: "hooks", executable: true, switchable: false, readBy: "daemon" },
  { id: "statusline", label: "Status line scripts", paths: ["statusline.json"], selection: "statusline", executable: true, switchable: false, readBy: "daemon" },
  { id: "recipes", label: "Model recipes", paths: ["recipes"], selection: "recipes", executable: false, switchable: false, readBy: "daemon" },
  { id: "workflows", label: "Workflows", paths: ["workflows"], selection: "workflows", executable: true, switchable: false, readBy: "daemon" },
  { id: "contracts", label: "Workflow contracts", paths: ["contracts"], selection: "contracts", executable: false, switchable: false, readBy: "daemon" },
  { id: "goals", label: "Goal prompts", paths: ["goals"], exportPaths: ["prompt", "prompts"], selection: "prompts", executable: false, switchable: false, readBy: "daemon" },
  { id: "promptFiles", label: "Prompt files", paths: ["SYSTEM.md", "APPEND_SYSTEM.md", "COMPACTION.md"], selection: "prompts", executable: false, switchable: false, readBy: "daemon" },
  { id: "keybindings", label: "Keybindings", paths: ["keybindings.json"], selection: "keybindings", executable: false, switchable: false, readBy: "terminal" },
  { id: "pages", label: "Pages (older layout)", paths: [], exportPaths: ["pages"], selection: "pages", executable: false, switchable: false, readBy: "none" },
  { id: "widgets", label: "Widgets (older layout)", paths: [], exportPaths: ["widgets"], selection: "widgets", executable: false, switchable: false, readBy: "none" },
  { id: "modes", label: "Modes (older layout)", paths: [], exportPaths: ["modes"], selection: "modes", executable: false, switchable: false, readBy: "none" },
  { id: "context", label: "Context files (older layout)", paths: [], exportPaths: ["context"], selection: "context", executable: false, switchable: false, readBy: "none" },
  { id: "tuiProfile", label: "Terminal profile snapshot", paths: [], exportPaths: ["tui/profile.json"], selection: "tuiProfile", executable: false, switchable: false, readBy: "none" },
  { id: "worktreePolicy", label: "Worktree policy snapshot", paths: [], exportPaths: ["worktree/policy.yaml", "worktree/policy.json"], selection: "worktreePolicy", executable: false, switchable: false, readBy: "none" },
] as const satisfies readonly PackageKindSpec[]

export type PackageKindId = (typeof PACKAGE_KINDS)[number]["id"]
type Switchable = Extract<(typeof PACKAGE_KINDS)[number], { switchable: true }>["id"]

/** The kinds one resource of which can be switched on and off (the `kind/name` ids of `Settings.disabledPackageResources`). */
export const SWITCHABLE_KINDS: readonly Switchable[] = PACKAGE_KINDS.filter((kind) => kind.switchable).map((kind) => kind.id as Switchable)

/** Files and folders a package carries that are not resources: the manifest, the install record and what people expect next to code. */
export const PACKAGE_META_ENTRIES: readonly string[] = ["mendcode-package.json", ".mendcode-install.json", "runtime-pack.json", "README.md", "README", "LICENSE", "LICENSE.md", "CHANGELOG.md", "docs", "examples", "test", "tests", "package.json", "tsconfig.json", ".gitignore", ".gitattributes"]

/** Every path a loader reads (the first segment of each), for "does anything read this?" questions. */
export const PACKAGE_READ_PATHS: readonly string[] = PACKAGE_KINDS.flatMap((kind) => kind.paths)

/** The folders and files the exporter copies for one selection, from the same table the loaders are checked against. */
export function exportPathsFor(selection: PackageSelection): string[] {
  return PACKAGE_KINDS.filter((kind) => "selection" in kind && kind.selection === selection).flatMap((kind) => [...kind.paths, ...("exportPaths" in kind ? kind.exportPaths : [])])
}

/** The top-level entries of a package nothing reads or installs: a typo (`skill/`) or leftover. */
export function unknownPackageEntries(names: readonly string[]): string[] {
  const known = new Set<string>([...PACKAGE_META_ENTRIES, ...PACKAGE_KINDS.flatMap((kind) => [...kind.paths, ...("exportPaths" in kind ? kind.exportPaths : [])].map((path) => path.split("/")[0]!))])
  return names.filter((name) => !known.has(name) && !name.startsWith("."))
}

/** The kinds that run code or commands: what a package must say honestly it ships. */
export const EXECUTABLE_PACKAGE_PATHS: readonly string[] = PACKAGE_KINDS.filter((kind) => kind.executable).flatMap((kind) => kind.paths)
