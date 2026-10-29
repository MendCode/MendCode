import { ACTIVATION_DENIED_PROFILE_KEYS, PACKAGE_KINDS } from "@mendcode/protocol/wire"

/**
 * What a personal configuration bundle may carry, decided per entry of the data directory and per settings key. The five
 * columns are the migration matrix (docs/config-bundle.md): what moves today, what is left out by default, what belongs to
 * this machine, what needs authentication or an approval on the target, and what cannot run elsewhere.
 */
export type MatrixColumn = "exportable" | "omitted" | "machine" | "approval" | "not-portable"

/**
 * How an exported entry arrives on the target. `write`: copied into the data directory. `quarantine`: copied beside the import
 * journal, never into a folder a loader reads (code, hooks, scripts). `mcp-pending`: added as a pending MCP server the user
 * approves in `/mcp`. `package`: installed with the package installer. `tui-profile`/`activation`: merged key by key.
 */
export type ImportAction = "write" | "quarantine" | "mcp-pending" | "package" | "tui-profile" | "activation" | "none"

export type EntryRule = { column: MatrixColumn; action: ImportAction; exported: boolean; reason: string }

const rule = (column: MatrixColumn, action: ImportAction, exported: boolean, reason: string): EntryRule => ({ column, action, exported, reason })

/** The folder of the data directory that keeps import journals, backups and quarantined files: never exported. */
export const CONFIG_IMPORTS_DIR = "config-imports"

const AUTH = rule("approval", "none", false, "credential or login state: sign in again on the target")
const OPERATIONAL = rule("omitted", "none", false, "history, cache or runtime state of this installation")

/** Data-directory names that hold credentials, tokens or session secrets: never read, never exported. */
const AUTH_NAMES = ["providers.json", "environment.enc", "keys", "secrets.key", "remote-tokens.json", "remote.json", "http-workspaces.json", "session-permissions.json", "plugin-auth.json", "provider-metadata-auth.json", "telegram-token", "channels.json", "session-shares.json", "shares", "console.json"]

/** Runtime state, caches, history and logs. */
const OPERATIONAL_NAMES = [
  "mendd.db", "mendd.db-wal", "mendd.db-shm", "mendd.lock", "mendd.sock", "mendd.endpoint", "blobs", "session-transcripts", "tool-output", "logs", "budget",
  "codegraph", "lsp", "fetch", "generated_images", "asides", "reviews", "Trash", ".Trash", "trash", "voice", "computer", "computer-native", "desktop", "quota-probe",
  "pets-cache", "models-dev-cache.json", "models.dev.json", "pr-watch.json", "project-rest.json", "model-resolutions.json", "acp-models.json", "mcp-pending-budget.json",
  "debug-snapshots", "diagnostics", "scratch", "scratchpads", "compound-runs", "compound-worktrees", "fanout-worktrees", "loop-worktrees", "worktrees", "worktree-manager",
  "file-frecency.json", "changelog-seen", "plugin-cache", "plugin-metadata.json", "upgrade-recovery.json", "upgrade.lock", "tuf", "spend.json", "stash.json", "state.json",
  "trace.jsonl", "daemon.stdout.log", "daemon.stderr.log", "backlogs", "memory-assistant", "extensions-data", "reasoning", "ide", "vscode", "audio-sfx", "bin", "bwrap",
  "cache", "package-cache", "package-drafts", "session-rest.json", "agent-mentions.json", "rooms.json", "tsm", "tsm-policy", ".DS_Store", CONFIG_IMPORTS_DIR,
  "instructions-remote",
]

const FIXED: Record<string, EntryRule> = {
  ...Object.fromEntries(AUTH_NAMES.map((name) => [name, AUTH])),
  ...Object.fromEntries(OPERATIONAL_NAMES.map((name) => [name, OPERATIONAL])),
  "builtin": rule("omitted", "none", false, "ships with MendCode; the target's own version is used"),
  "AGENTS.md": rule("exportable", "write", true, "global instructions"),
  "activation.json": rule("exportable", "activation", true, "which package owns the look and the keys you kept"),
  "packages": rule("exportable", "package", true, "installed packages, with their on/off state"),
  "pets": rule("omitted", "none", false, "your pets keep a private reference image; `/pet export` makes a shareable package"),
  "prompt-context.json": rule("machine", "none", false, "prompt mode per project folder of this machine"),
  "package-sources.json": rule("machine", "none", false, "catalog sources point at folders of this machine"),
  "acp-agents.json": rule("approval", "quarantine", true, "external agent commands: review, then add them on the target"),
}

/** Resource folders and files a loader reads in the user layer, from the one table of package kinds. */
for (const kind of PACKAGE_KINDS) {
  if (kind.id === "pets" || kind.id === "tuiProfile" || kind.id === "worktreePolicy") continue
  const paths = [...kind.paths, ...("exportPaths" in kind ? kind.exportPaths : [])]
  for (const entry of paths) {
    const name = entry.split("/")[0]!
    if (FIXED[name]) continue
    FIXED[name] = name === "mcp.json"
      ? rule("approval", "mcp-pending", true, "MCP servers start processes or reach services: they arrive pending your approval in /mcp")
      : kind.executable
        ? rule("approval", "quarantine", true, `${kind.label.toLowerCase()} run code: copied to quarantine, enabled only by hand`)
        : rule("exportable", "write", true, kind.label.toLowerCase())
  }
}

const TUI_FIXED: Record<string, EntryRule> = {
  "profile.json": rule("exportable", "tui-profile", true, "terminal profile (/customize)"),
  "models.json": rule("exportable", "write", true, "starred and recent models of the model page"),
  "session-look.json": rule("omitted", "none", false, "per-session look of sessions on this machine"),
  "slash-recents.json": OPERATIONAL,
  "latest-backup.json": OPERATIONAL,
  "backups": OPERATIONAL,
  "proposals": OPERATIONAL,
  "runtime": OPERATIONAL,
}

const SCRIPT = /\.(sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|swift|ps1|cmd|bat|command|applescript|scpt)$/i

/** Mach-O, ELF and PE executables: built for one platform. */
export function nativeBinary(head: Uint8Array): string | undefined {
  const hex = Buffer.from(head.subarray(0, 4)).toString("hex")
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(hex)) return "macOS executable (Mach-O)"
  if (hex === "7f454c46") return "Linux executable (ELF)"
  if (hex.startsWith("4d5a")) return "Windows executable"
  return undefined
}

/**
 * The rule for one data-directory path (relative, `/`-separated). `probe` reads a file's first bytes and exec bit; it is called
 * only for files the table cannot name (inside `tui/` or unknown entries), so a credential file is never opened.
 */
export function classifyEntry(relative: string, probe?: () => { head: Uint8Array; executable: boolean }): EntryRule {
  const [top, second] = relative.split("/")
  if (top === "tui" && second !== undefined) {
    const fixed = TUI_FIXED[second]
    if (fixed) return fixed
    const file = probe?.()
    if (file) {
      const binary = nativeBinary(file.head)
      if (binary) return rule("not-portable", "none", false, `${binary}: rebuild it on the target`)
      if (file.executable || SCRIPT.test(second)) return rule("approval", "quarantine", true, "script: copied to quarantine, enabled only by hand")
    }
    return rule("machine", "none", false, "terminal cache or helper file of this machine")
  }
  const fixed = FIXED[top!]
  if (fixed) return fixed
  const file = probe?.()
  if (file) {
    const binary = nativeBinary(file.head)
    if (binary) return rule("not-portable", "none", false, `${binary}: rebuild it on the target`)
  }
  return rule("omitted", "none", false, "not a known configuration file; left out")
}

/** Settings a bundle carries and an import applies through `settings.set`: preferences that grant nothing. */
export const PORTABLE_SETTINGS: ReadonlySet<string> = new Set([
  "theme", "view", "pet", "reducedMotion", "compactAtTokens", "modelContext", "idleCompactAtTokens", "compactNoticePercent", "cacheLifetimeMinutes", "promptCacheTtl",
  "claudeCacheTtl", "handoffTokenCap", "disabledSkills", "agentMentions", "memoryMaintenance", "memoryEnabled", "memoryUse", "memoryGenerate", "memoryMaxPromptTokens",
  "memoryMaxEntries", "memoryProjectMaxEntries", "memoryPolicies", "memoryGlobalCompactionMaxEntries", "dreamConsolidationPolicy", "retentionDays", "worktreeBranch",
  "git", "footer", "promptCache", "outputStyle", "planExitAgent", "plan_exit_agent", "logLevel", "tool_output", "codegraph_index", "foreignResources",
  "instructionFallbacks", "projectRootMarkers", "queue", "snapshot", "snapshotScope", "compaction", "cache", "allowMessageEdits", "subagent_variant",
  "subagentOwnerWake", "subagentCatalog",
])

/**
 * Settings of the user's authority: permissions, trust, models, spend and execution switches. A bundle carries them (secrets
 * hidden) so the report can show them, but an import never applies them: they wait for the native approval on the target.
 */
export const APPROVAL_SETTINGS: ReadonlySet<string> = new Set([
  "models", "defaultPermission", "permission", "permissionAllow", "permissionReviewerRole", "smartSandboxTrust", "engineSafetyPrompts", "sandbox", "tools", "threadMcp",
  "tier", "features", "experimental", "budgets", "serviceTier", "allowedHttpHookUrls", "disabledExtensions", "disabledPackages", "disabledPackageResources",
  "subagentDepth", "subagentMaxChildren", "subagentMaxDescendants", "disabled_models", "enabled_providers", "agent", "default_agent", "defaultAgent", "web",
  "memoryRequireApproval", "evolution", "evolutionWorkflows", "share", "image_generation", "voice", "provider", "instructions", "skills", "dreamMaxTokens",
])

/** Settings that describe this machine (folders, shells, environment, schedules): shown in the report, never applied. */
export const MACHINE_SETTINGS: ReadonlySet<string> = new Set([
  "trustedToolDirs", "additionalDirectories", "projectConfig", "projectThemes", "memoryProjects", "cacheProjects", "profiles", "acpAgents", "proxy", "shellEnvironment",
  "shellCommandPrefix", "loginShell", "shell", "engineEnvironment", "watcher", "onboarded", "$schema", "setupPreset", "worktreeGcDays", "enterprise", "autoupdate", "dreamAt",
])

export type SettingClass = "portable" | "approval" | "machine"

/** A key nobody classified yet is treated as the user's authority: it waits for approval. */
export function classifySetting(key: string): SettingClass {
  if (PORTABLE_SETTINGS.has(key)) return "portable"
  if (MACHINE_SETTINGS.has(key)) return "machine"
  return "approval"
}

/** Terminal-profile keys that start things, touch the clipboard or the network: the same keys a package may not set. */
export const APPROVAL_PROFILE_KEYS: ReadonlySet<string> = ACTIVATION_DENIED_PROFILE_KEYS
