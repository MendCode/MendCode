import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { which } from "../../util/which"
import { mendPaths } from "./paths"
import { resolveWorktreeContext } from "../worktree"

export const TSM_REPOSITORY = "https://github.com/adibhanna/tsm"
export const TSM_SUPPORTED_RANGE = "worktree-capable build"
export const TSM_RECOMMENDED_VERSION = "v0.6.7+ with `tsm wt`"
export const TSM_WORKTREE_CAPABILITIES = [
  "tsm wt",
  "tsm wt open",
  "tsm wt add/rm",
  "tsm wt move",
  "tsm wt prune",
]

export type TsmLifecycleState = "not-installed" | "installed-inactive" | "active" | "degraded" | "removed"

export type TsmState = {
  version: 1
  enabled: boolean
  installMethod: "path" | "homebrew" | "release" | "source" | "unknown"
  binaryPath: string | null
  detectedVersion: string | null
  supportedRange: string
  defaultMuxBackend: "cmux" | "kitty" | "ghostty" | "wezterm" | "auto" | null
  updatedAt: string
}

function tsmDir(root?: string) {
  return path.join(mendPaths(resolveWorktreeContext(root || process.cwd()).repoRoot).mendDir, "tsm")
}

export function tsmStatePath(root?: string) {
  return path.join(tsmDir(root), "state.json")
}

function defaultTsmState(now = new Date().toISOString()): TsmState {
  return {
    version: 1,
    enabled: false,
    installMethod: "unknown",
    binaryPath: null,
    detectedVersion: null,
    supportedRange: TSM_SUPPORTED_RANGE,
    defaultMuxBackend: "auto",
    updatedAt: now,
  }
}

async function readJson(file: string, fallback: unknown) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function readWorktreePolicy(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const file = path.join(paths.mendDir, "worktree", "policy.yaml")
  let text = ""
  try { text = await readFile(file, "utf8") } catch {}
  const mode = text.match(/^mode:\s*(.+)$/m)?.[1]?.trim() || "off"
  const liveSync = text.match(/^liveSync:\s*(.+)$/m)?.[1]?.trim() === "true"
  const neverSyncRaw = text.match(/^neverSync:\s*\[(.+)\]$/m)?.[1] || ""
  const neverSync = neverSyncRaw.split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean)
  return { path: path.relative(paths.root, file), mode, liveSync, neverSync }
}

export async function readTsmState(root?: string): Promise<TsmState> {
  const parsed = await readJson(tsmStatePath(root), defaultTsmState()) as Partial<TsmState>
  return {
    ...defaultTsmState(parsed.updatedAt),
    ...parsed,
    version: 1,
    supportedRange: TSM_SUPPORTED_RANGE,
  }
}

function runTsm(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 1000 })
  return {
    ok: result.status === 0,
    output: String(result.stdout || result.stderr || "").trim(),
    error: result.error instanceof Error ? result.error.message : null,
  }
}

function parseVersion(output: string) {
  return output.match(/v?\d+\.\d+\.\d+/)?.[0] || null
}

function isGitCheckout(root: string) {
  if (existsSync(path.join(root, ".git"))) return true
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", timeout: 1000 })
  return result.status === 0 && Boolean(String(result.stdout || "").trim())
}

function isWorktreeCapable(version: string | null, help: string) {
  if (/\bwt\b|worktree/i.test(help)) return true
  if (!version) return false
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 0 || minor >= 7
}

export function detectTsm() {
  const configured = process.env.MENDCODE_TSM_BINARY
  if (configured && !existsSync(configured)) {
    return { available: false, binaryPath: null, detectedVersion: null, worktreeCapable: false, detectionError: `configured binary not found: ${configured}` }
  }
  const binaryPath = configured || which("tsm") || null
  if (!binaryPath) return { available: false, binaryPath: null, detectedVersion: null, worktreeCapable: false, detectionError: null }
  const versionResult = runTsm(binaryPath, ["--version"])
  const helpResult = runTsm(binaryPath, ["wt", "--help"])
  const detectedVersion = parseVersion(versionResult.output)
  return {
    available: true,
    binaryPath,
    detectedVersion,
    worktreeCapable: isWorktreeCapable(detectedVersion, helpResult.output),
    detectionError: versionResult.error || helpResult.error,
  }
}

function lifecycle(enabled: boolean, available: boolean, worktreeCapable: boolean): TsmLifecycleState {
  if (enabled && (!available || !worktreeCapable)) return "degraded"
  if (enabled) return "active"
  if (available) return "installed-inactive"
  return "not-installed"
}

export async function tsmStatus(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const state = await readTsmState(paths.root)
  const detected = detectTsm()
  const policy = await readWorktreePolicy(paths.root)
  const rootGit = isGitCheckout(paths.root)
  const currentState = lifecycle(state.enabled, detected.available, detected.worktreeCapable)
  return {
    ok: currentState !== "degraded",
    integration: "optional-terminal-session-worktree-executor",
    lifecycle: currentState,
    enabled: state.enabled,
    workspace: {
      currentPath: context.currentPath,
      currentBranch: context.currentBranch,
      repoRoot: context.repoRoot,
      isLinkedWorktree: context.isLinkedWorktree,
      stateRoot: paths.root,
    },
    repository: TSM_REPOSITORY,
    supportedRange: TSM_SUPPORTED_RANGE,
    recommendedVersion: TSM_RECOMMENDED_VERSION,
    binaryPath: detected.binaryPath,
    detectedVersion: detected.detectedVersion,
    worktreeCapable: detected.worktreeCapable,
    capabilities: TSM_WORKTREE_CAPABILITIES,
    defaultMuxBackend: state.defaultMuxBackend,
    managedFiles: {
      state: path.relative(paths.root, tsmStatePath(paths.root)),
      plan: path.relative(paths.root, paths.tsmPlan),
    },
    policy,
    rootGit,
    safety: {
      installsTsm: false,
      startsSessions: false,
      killsSessions: false,
      removesWorktrees: false,
      explicitActivationRequired: true,
      statusExecutesReadOnlyVersionProbe: Boolean(detected.binaryPath),
    },
    warnings: [
      ...(!detected.available ? ["tsm binary not found on PATH"] : []),
      ...(detected.available && !detected.worktreeCapable ? ["detected tsm does not advertise worktree capabilities"] : []),
      ...(detected.detectionError ? [`tsm detection warning: ${detected.detectionError}`] : []),
    ],
  }
}

export async function tsmPlan(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const status = await tsmStatus(paths.root)
  const plan = {
    version: 1,
    status: "dry-run",
    generatedAt: new Date().toISOString(),
    repository: TSM_REPOSITORY,
    supportedRange: TSM_SUPPORTED_RANGE,
    recommendedVersion: TSM_RECOMMENDED_VERSION,
    lifecycle: status.lifecycle,
    install: {
      executesInstall: false,
      commands: [
        "brew tap adibhanna/tsm",
        "brew install adibhanna/tsm/tsm",
        "gh release download --repo adibhanna/tsm # choose the asset for this platform",
      ],
    },
    activation: {
      command: "mend tsm activate",
      requiresDetectedBinary: true,
      delegatesWorktreesImmediately: false,
    },
    removal: {
      command: "mend tsm remove",
      removesExternalTsm: false,
      killsSessions: false,
    },
    safety: status.safety,
  }
  await writeJson(paths.tsmPlan, plan)
  return { ...plan, path: path.relative(paths.root, paths.tsmPlan) }
}

export async function setupTsm(root?: string) {
  return tsmPlan(root)
}

export async function activateTsm(root?: string, options: { muxBackend?: TsmState["defaultMuxBackend"] } = {}) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const detected = detectTsm()
  if (!detected.available) throw new Error("Cannot activate TSM: binary not found on PATH")
  if (!detected.worktreeCapable) throw new Error("Cannot activate TSM: detected binary does not advertise worktree support")
  const next: TsmState = {
    ...await readTsmState(paths.root),
    enabled: true,
    installMethod: "path",
    binaryPath: detected.binaryPath,
    detectedVersion: detected.detectedVersion,
    defaultMuxBackend: options.muxBackend || "auto",
    updatedAt: new Date().toISOString(),
  }
  await writeJson(tsmStatePath(paths.root), next)
  return tsmStatus(paths.root)
}

export async function deactivateTsm(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const current = await readTsmState(paths.root)
  await writeJson(tsmStatePath(paths.root), { ...current, enabled: false, updatedAt: new Date().toISOString() })
  return tsmStatus(paths.root)
}

export async function removeTsm(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  await rm(tsmDir(paths.root), { recursive: true, force: true })
  await rm(paths.tsmPlan, { force: true })
  return {
    ok: true,
    action: "remove",
    removed: [path.relative(paths.root, tsmDir(paths.root)), path.relative(paths.root, paths.tsmPlan)],
    removesExternalTsm: false,
    killsSessions: false,
    status: await tsmStatus(paths.root),
  }
}

export async function tsmDoctor(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const status = await tsmStatus(context.repoRoot)
  const failures: string[] = []
  const warnings = [...status.warnings]
  if (status.enabled && status.lifecycle === "degraded") failures.push("TSM integration is active but binary/capabilities are unavailable")
  if (!status.rootGit) failures.push("project root must be a git checkout before TSM worktree executor can be approved")
  if (status.policy.liveSync) failures.push("TSM worktree execution must not start while liveSync=true")
  return { ...status, ok: failures.length === 0, failures, warnings }
}
