#!/usr/bin/env bun
import { spawnSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { initProject } from "../config/project"
import { mendPaths } from "../config/paths"
import { donorIdentityGuardStatus, runtimeAdapterCommand } from "../runtime/system"
import { worktreeStatus } from "../config/worktree"
import { tsmStatus } from "../config/tsm"

const primaryCommands = [
  "run",
  "chat",
  "status",
  "doctor",
  "setup",
  "packages",
  "mflow",
  "worktree",
  "tsm",
]

const advancedCommands = [
  "check",
  "models",
  "providers",
  "auth",
  "permissions",
  "memory",
  "focus",
]

const internalCommands = [
  "adapter",
  "ai",
  "bench",
  "budget",
  "config",
  "context",
  "export",
  "mcp",
  "prompt",
  "prompts",
  "runtime",
  "toolchain",
  "tui",
  "upstream",
]

const deprecatedAliases = ["init", "sync", "package", "prompts"]
const deprecationMessages: Record<string, string> = {
  init: "Deprecated alias: `mendcode init` is kept for compatibility. Use `mendcode setup status` for setup checks; project init remains internal.",
  sync: "Deprecated alias: `mendcode sync` is kept for compatibility. Use `mendcode setup status` or `mendcode status` for normal workflows.",
  package: "Deprecated alias: `mendcode package` is kept for compatibility. Use `mendcode packages`.",
  prompts: "Deprecated alias: `mendcode prompts` is kept for compatibility. Prompt internals are not part of the public workflow.",
}
const internalCommandWarning =
  "Internal/debug command: this is hidden from normal `mendcode --help` and is not part of the primary terminal coding workflow."

type ShortcutWorktreeTarget = {
  path: string
  branch: string | null
  label: string
}

const controlPlaneRoutes: Record<string, (args: string[]) => string[]> = {
  init: () => ["project", "init"],
  sync: () => ["project", "sync"],
  status: () => ["system", "status"],
  doctor: () => ["system", "doctor"],
  check: () => ["system", "check"],
  bench: () => ["bench"],
  budget: (args) => ["budget", args[0] || "status"],
  models: (args) => ["models", ...args],
  tui: (args) => ["tui", ...args],
  tsm: (args) => ["tsm", ...args],
  mflow: (args) => ["mflow", ...args],
  providers: (args) => ["providers", args[0] || "status", ...args.slice(1)],
  mcp: (args) => ["mcp", args[0] || "status", ...args.slice(1)],
  memory: (args) => ["memory", args[0] || "status", ...args.slice(1)],
  permissions: (args) => ["permissions", args[0] || "status", ...args.slice(1)],
  auth: (args) => ["auth", args[0] || "status", ...args.slice(1)],
  setup: (args) => ["setup", args[0] || "status"],
  packages: (args) => ["packages", args[0] || "status", ...args.slice(1)],
  package: (args) => ["packages", args[0] || "status", ...args.slice(1)],
  ai: (args) => ["ai", ...args],
  runtime: (args) => {
    const sub = args[0] || "status"
    if (sub === "status") return ["runtime", "status"]
    if (sub === "configure") return ["runtime-config", ...args.slice(1)]
    return ["runtime", ...args]
  },
  prompts: (args) => ["prompt", args[0] || "sources", ...args.slice(1)],
  chat: (args) => ["chat", ...args],
  export: (args) => ["export", ...args],
  adapter: () => ["system", "adapter-status"],
  toolchain: (args) => {
    if (args[0] !== "status") throw new Error("Usage: mendcode toolchain status")
    return ["system", "toolchain"]
  },
  config: (args) => {
    if (args[0] === "show") return ["project", "config-show"]
    if (args[0] === "paths") return ["system", "config-paths"]
    throw new Error("Usage: mendcode config <show|paths>")
  },
  upstream: (args) => {
    if (args[0] === "status") return ["system", "upstream-status"]
    if (args[0] === "inspect") return ["system", "upstream-inspect", ...args.slice(1)]
    if (args[0] === "baseline") return ["project", "upstream-baseline", ...args.slice(1)]
    throw new Error("Usage: mendcode upstream <status|inspect|baseline>")
  },
  context: (args) => {
    const sub = args[0] || "status"
    if (["status", "refresh", "show"].includes(sub)) return ["project", `context-${sub}`]
    throw new Error("Usage: mendcode context <status|refresh|show>")
  },
  focus: (args) => {
    const sub = args[0] || "status"
    if (["status", "list", "show", "use"].includes(sub)) return ["project", `focus-${sub}`, ...args.slice(1)]
    throw new Error("Usage: mendcode focus <list|status|show|use>")
  },
  worktree: (args) => {
    const sub = args[0] || "status"
    if (["status", "plan", "create", "open", "adopt", "remove", "reset", "doctor"].includes(sub)) return ["worktree", ...args]
    throw new Error("Usage: mendcode worktree <status|plan|create|open|adopt|remove|reset|doctor>")
  },
}

function mendVersion(root = mendPaths().root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(mendPaths(root).ownedRuntimePackage, "package.json"), "utf8"))
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function usage(exitCode = 0) {
  const out = `mendcode ${mendVersion()}

Usage:
  mendcode                         open MendCode in the current project
  mendcode run [message..]         open MendCode with message ready to send
  mendcode chat [message..]        run a control-plane chat turn
  mendcode --worktree [target]     open MendCode in a git worktree by branch/path/id
  mendcode --tsm [target|--all]    open TSM workspace with MendCode split

Workflows:
  mendcode status                  show MendCode status
  mendcode doctor                  run local diagnostics
  mendcode setup status|plan|doctor
                                inspect setup readiness and local diagnostics
  mendcode packages status|list    inspect installed/active MendCode packages
  mendcode packages create --id <id> --title <name> [--include skills,modes,plugins]
                                package selected local harness config
  mendcode packages install <source-id>
  mendcode packages enable|disable <id>
                                select or deselect a runtime package
  mendcode mflow status            inspect mflow activation, daemon, and locks
  mendcode mflow setup             guided mflow setup for this repo
  mendcode mflow activate --room <room> --accept-public-relay-limits
  mendcode mflow deactivate        disable mflow without deleting local config
  mendcode mflow remove            remove local mflow config and scaffold files
  mendcode worktree status|plan    inspect worktree registry and dry-run create plan
  mendcode worktree create|open|adopt|remove|reset
                                preview-first worktree management; destructive actions are gated
  mendcode tsm status|plan|doctor  inspect optional TSM integration
  mendcode tsm setup|activate|deactivate|remove
                                manage MendCode TSM scaffold without touching external sessions

Advanced/support:
  mendcode help advanced           show support/debug commands that are hidden from normal help
`
  ;(exitCode ? console.error : console.log)(out)
  process.exit(exitCode)
}

function advancedUsage(exitCode = 0) {
  const out = `mendcode ${mendVersion()} advanced/support

Primary public surface:
  mendcode
  mendcode run [message..]
  mendcode chat [message..]
  mendcode --worktree [branch|path|id]
  mendcode --tsm [branch|path|id|--all]
  mendcode status|doctor
  mendcode setup status|plan|doctor
  mendcode packages status|list|create|install|enable|disable|remove
  mendcode mflow status|setup|activate|deactivate|remove
  mendcode worktree status|plan|create|open|adopt|remove|reset|doctor
  mendcode tsm status|plan|setup|activate|deactivate|remove|doctor

Advanced/support surface:
  mendcode check
  mendcode models status|show|plan|presets|set-default|use-preset
  mendcode providers status
  mendcode auth status|login-plan|login
  mendcode permissions status|set-default
  mendcode memory status|search|preview|add|list
  mendcode focus status|list|show|use

Internal/debug-only surface, intentionally hidden from normal help:
  ${internalCommands.join(", ")}

Deprecated legacy aliases kept for compatibility:
  init -> project init
  sync -> project sync
  package -> packages
  prompts -> prompt
`
  ;(exitCode ? console.error : console.log)(out)
  process.exit(exitCode)
}

function levenshtein(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!
  }
  return prev[b.length]!
}

function suggestCommand(value: string, candidates = [...primaryCommands, ...advancedCommands, ...internalCommands, ...deprecatedAliases]) {
  const match = candidates
    .map((candidate) => ({ candidate, score: levenshtein(value, candidate) }))
    .sort((a, b) => a.score - b.score)[0]
  return match && match.score <= Math.max(2, Math.floor(value.length / 3)) ? match.candidate : undefined
}

function controlPlaneEnv(root: string) {
  const originalEnv: Record<string, string> = {}
  for (const key of ["MENDCODE_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "MENDCODE_TUI_CONFIG", "OPENCODE_TUI_CONFIG", "MENDCODE_CONFIG", "OPENCODE_CONFIG", "MENDCODE_DB", "OPENCODE_DB", "MENDCODE_GLOBAL_LAYOUT", "OPENCODE_GLOBAL_LAYOUT"]) {
    if (process.env[key] !== undefined) originalEnv[key] = process.env[key]!
  }
  return {
    ...runtimeEnv(root),
    MENDCODE_SHELL_CWD: process.cwd(),
    MENDCODE_ORIGINAL_ENV_JSON: JSON.stringify(originalEnv),
  }
}

function runtimeEnv(root: string) {
  const paths = mendPaths(root)
  return {
    ...process.env,
    MENDCODE: "1",
    MENDCODE_VERSION: mendVersion(root),
    MENDCODE_ROOT: root,
    MENDCODE_CONFIG_DIR: paths.mendDir,
    OPENCODE_CONFIG: paths.generatedOpencodeConfig,
  }
}

function runControlPlane(args: string[], root = mendPaths().root) {
  const paths = mendPaths(root)
  const bunBin = process.env.MENDCODE_BUN_BIN || "bun"
  const result = spawnSync(bunBin, [paths.runtimeControlPlane, ...args], {
    cwd: paths.ownedRuntimePackage,
    env: controlPlaneEnv(root),
    stdio: "inherit",
  })
  process.exit(result.status ?? 1)
}

async function ensureReady(root = mendPaths().root) {
  const paths = mendPaths(root)
  if (!existsSync(paths.donorRuntimeRoot)) throw new Error(`donor checkout missing: ${paths.donorRuntimeRoot}`)
  if (!existsSync(paths.donorRuntimePackage)) throw new Error(`donor runtime package missing: ${paths.donorRuntimePackage}`)
  if (!existsSync(paths.generatedOpencodeConfig)) await initProject(root)
}

function enforceDonorIdentityGuard(args: string[]) {
  const status = donorIdentityGuardStatus()
  if (!status.active) {
    console.error(`WARN: internal donor override enabled via ${status.overrideEnv}; do not use this as public MendCode UX.`)
    return
  }
  const token = args.find((arg) => arg && arg !== "--" && !arg.startsWith("-")) || "help"
  throw new Error([
    `Blocked internal donor runtime command: ${token}`,
    status.reason,
    "Use MendCode-owned commands from `mendcode --help`; support/debug commands are listed in `mendcode help advanced`.",
    `Temporary internal override: ${status.overrideEnv}=1 mendcode opencode -- ${args.join(" ") || "--help"}`,
  ].join("\n"))
}

async function runRuntime(args: string[], root = mendPaths().root) {
  await ensureReady(root)
  const command = runtimeAdapterCommand(args, root)
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    env: runtimeEnv(root),
    stdio: "inherit",
  })
  process.exit(result.status ?? 1)
}

function worktreeShortcutCandidates(status: Awaited<ReturnType<typeof worktreeStatus>>): ShortcutWorktreeTarget[] {
  const records = status.registry.records.map((record) => ({
    path: record.path,
    branch: record.branch,
    label: record.id,
  }))
  const external = status.registry.external.map((entry) => ({
    path: entry.path,
    branch: entry.branch,
    label: entry.branch || entry.path,
  }))
  return [...records, ...external]
}

export function resolveWorktreeShortcutTarget(
  status: Awaited<ReturnType<typeof worktreeStatus>>,
  target?: string,
  command = "worktree",
): ShortcutWorktreeTarget {
  if (target) {
    const hit = worktreeShortcutCandidates(status).find((item) =>
      item.path === target ||
      item.branch === target ||
      item.label === target ||
      path.basename(item.path) === target
    )
    if (!hit) throw new Error(`Unknown worktree target: ${target}. Run \`mendcode worktree status\` to inspect available targets.`)
    return hit
  }

  if (status.workspace.isLinkedWorktree) {
    return {
      path: status.workspace.currentPath,
      branch: status.workspace.currentBranch,
      label: status.workspace.currentBranch || status.workspace.currentPath,
    }
  }

  const managedNonBase = status.registry.records
    .filter((item) => item.path !== status.workspace.repoRoot)
    .map((record) => ({
      path: record.path,
      branch: record.branch,
      label: record.id,
    }))
  if (managedNonBase.length === 1) return managedNonBase[0]!

  const nonBase = worktreeShortcutCandidates(status).filter((item) => item.path !== status.workspace.repoRoot)
  if (nonBase.length === 1) return nonBase[0]!
  const summary = nonBase.map((item) => item.branch || item.path).join(", ") || "none"
  throw new Error(`Multiple or no worktree targets found (${summary}). Use \`mendcode --${command} <branch|path>\`.`)
}

async function runWorktreeShortcut(args: string[]) {
  const target = args[0]
  if (args.length > 1) throw new Error("Usage: mendcode --worktree [branch|path|id]")
  const status = await worktreeStatus(process.cwd())
  const resolved = resolveWorktreeShortcutTarget(status, target, "worktree")
  return runRuntime([resolved.path])
}

async function runTsmShortcut(args: string[]) {
  const all = args[0] === "--all"
  const target = all ? undefined : args[0]
  if (args.length > 1) throw new Error("Usage: mendcode --tsm [branch|path|id|--all]")
  const status = await worktreeStatus(process.cwd())
  const tsm = await tsmStatus(process.cwd())
  if (tsm.lifecycle !== "active" || !tsm.worktreeCapable) {
    throw new Error(`TSM is not active for this repo (${tsm.lifecycle}). Run \`mendcode tsm status\` and \`mendcode tsm activate\`.`)
  }
  const branches = all ? [] : [resolveWorktreeShortcutTarget(status, target, "tsm").branch].filter((branch): branch is string => Boolean(branch))
  if (!all && !branches.length) throw new Error("TSM shortcut requires a branch-backed worktree target.")
  const result = spawnSync("tsm", ["wt", "open", ...branches, "--split", "mendcode"], {
    cwd: status.workspace.repoRoot,
    stdio: "inherit",
  })
  process.exit(result.status ?? 1)
}

function runTuiWithMessage(args: string[]) {
  const passthrough: string[] = []
  const message: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--continue" || arg === "-c" || arg === "--fork") passthrough.push(arg)
    else if (arg === "--session" || arg === "-s" || arg === "--model" || arg === "-m" || arg === "--agent") {
      const value = args[++i]
      if (!value) throw new Error(`Missing value for ${arg}`)
      passthrough.push(arg, value)
    } else if (arg.startsWith("-")) throw new Error(`mendcode run opens the interactive TUI; unsupported headless flag: ${arg}`)
    else message.push(arg)
  }
  if (!message.length) throw new Error("Usage: mendcode run [message..]")
  return runRuntime([process.cwd(), "--initial-message", message.join(" "), ...passthrough])
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...args] = argv
  try {
    if (!cmd) return runRuntime([process.cwd()])
    if (cmd === "help" && args[0] === "advanced") advancedUsage(0)
    if (cmd === "help" || cmd === "-h" || cmd === "--help") usage(0)
    if (cmd === "--worktree") return await runWorktreeShortcut(args)
    if (cmd === "--tsm") return await runTsmShortcut(args)
    if (cmd.startsWith("-")) return runRuntime([process.cwd(), cmd, ...args])
    if (cmd === "opencode") {
      const donorArgs = args[0] === "--" ? args.slice(1) : args
      enforceDonorIdentityGuard(donorArgs)
      return runRuntime(donorArgs)
    }
    if (cmd === "run") return runTuiWithMessage(args)
    if (cmd === "--") {
      enforceDonorIdentityGuard(args)
      return runRuntime(args)
    }
    const route = controlPlaneRoutes[cmd]
    if (route) {
      const deprecation = deprecationMessages[cmd]
      if (deprecation) console.error(deprecation)
      else if (internalCommands.includes(cmd)) console.error(internalCommandWarning)
      return runControlPlane(route(args))
    }
    const suggestion = suggestCommand(cmd)
    if (suggestion) {
      throw new Error(`Unknown mendcode command: ${cmd}\nDid you mean \`mendcode ${suggestion}\`?\nRun \`mendcode --help\` for public workflows or \`mendcode help advanced\` for support commands.`)
    }
    enforceDonorIdentityGuard([cmd, ...args])
    return runRuntime([cmd, ...args])
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (import.meta.main) void main()
