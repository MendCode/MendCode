import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { createHash, randomBytes } from "crypto"
import { mendPaths } from "./paths"
import { syncProject } from "./project"
import { writeMendMcpServer } from "./mcp"

export const MFLOW_PUBLIC_RELAY = "wss://mflow-signal.obed0101.deno.net"
export const MFLOW_PUBLIC_RELAY_DISPLAY = "https://mflow-signal.obed0101.deno.net/"
export const MFLOW_PACKAGE = "mflow-cli"
export const MFLOW_VERSION = "0.1.12"

export type MflowMode = "disabled" | "enabled-stopped" | "running"
export type MflowRelayMode = "public" | "custom"

export type MflowConfig = {
  version: 1
  enabled: boolean
  relayMode: MflowRelayMode
  signaling: string
  room: string
  storeSecret: boolean
  hookPriority: number
  publicRelayNoticeAccepted: boolean
  updatedAt: string
}

export type MflowActivateInput = {
  relayMode: MflowRelayMode
  signaling?: string
  room?: string
  secret?: string
  generateSecret?: boolean
  storeSecret?: boolean
  hookPriority?: number
  publicRelayNoticeAccepted?: boolean
}

export type MflowWaitInfo = {
  file: string
  remainingMs: number
  deadlineMs: number
}

const DEFAULT_IGNORE = [
  "node_modules",
  ".env*",
  "*.lock",
  "dist/",
  "build/",
  ".git/",
  ".mflow/",
  ".mendcode/runs",
  ".mendcode/cache",
]

const PUBLIC_RELAY_WARNING =
  "Public mflow relay is a shared fair-use service. It is good for demos, small swarms, and onboarding. It has peer, message, rate, active-room, idle-timeout, and dashboard-history limits. For larger teams, private code, production reliability, or custom limits, use a self-hosted mflow relay URL."
const EDIT_LOCK_LEASE_MS = 35_000
const EDIT_LOCK_WAIT_TIMEOUT_MS = 90_000
const EDIT_LOCK_RETRY_MS = 750

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function readJsonAsync<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function shellQuote(value: string) {
  return JSON.stringify(value)
}

function escapeToml(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

function defaultRoom(root: string) {
  return `${path.basename(root) || "mendcode"}/mflow`
}

function mflowStatePath(root?: string) {
  return path.join(mendPaths(root).mendDir, "mflow", "state.json")
}

function mflowRuntimeConfigPath(root?: string) {
  return path.join(mendPaths(root).root, ".mflow", "config.toml")
}

function mflowPluginPath(root?: string) {
  return path.join(mendPaths(root).mendDir, "plugins", "mflow-lock.js")
}

function mflowControlGuidePath(root?: string) {
  return path.join(mendPaths(root).mendDir, "mflow-control.md")
}

function mflowSecretPath(root?: string) {
  return path.join(mendPaths(root).mendDir, "mflow", "secret.local")
}

function mflowEditLockRoot(root: string) {
  return path.join(mendPaths(root).mendDir, "mflow", "edit-locks")
}

function mflowEditLockPath(root: string, file: string) {
  return path.join(mflowEditLockRoot(root), `${createHash("sha256").update(file).digest("hex")}.lock`)
}

function mflowCommand(args: string[]) {
  return ["pnpm", "dlx", "--package", `${MFLOW_PACKAGE}@${MFLOW_VERSION}`, ...args]
}

function mflowImmediateLockCommandArgs(file: string) {
  return ["lock", file, "--duration", "30s"]
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function acquireLocalMflowEditLock(root: string, file: string, owner: string) {
  const lockDir = mflowEditLockPath(root, file)
  const now = Date.now()
  const expiresAt = now + EDIT_LOCK_LEASE_MS
  mkdirSync(path.dirname(lockDir), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir)
      writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ file, owner, pid: process.pid, createdAt: now, expiresAt }, null, 2)}\n`)
      return
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
      const current = readJson<{ owner?: string; expiresAt?: number }>(path.join(lockDir, "owner.json"), {})
      if (current.owner === owner) {
        writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ file, owner, pid: process.pid, createdAt: now, expiresAt }, null, 2)}\n`)
        return
      }
      if ((current.expiresAt ?? 0) <= now) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      throw new Error(`mflow refused edit for ${file}: file is already locked`)
    }
  }
  throw new Error(`mflow refused edit for ${file}: file is already locked`)
}

async function acquireLocalMflowEditLockWithWait(
  root: string,
  file: string,
  owner: string,
  onWait?: (info: MflowWaitInfo) => Promise<void> | void,
) {
  const deadline = Date.now() + EDIT_LOCK_WAIT_TIMEOUT_MS
  while (true) {
    try {
      acquireLocalMflowEditLock(root, file, owner)
      return
    } catch (error) {
      const lockDir = mflowEditLockPath(root, file)
      const current = readJson<{ expiresAt?: number }>(path.join(lockDir, "owner.json"), {})
      const remainingMs = Math.max(0, (current.expiresAt ?? 0) - Date.now())
      if (!remainingMs || Date.now() >= deadline) throw error
      await onWait?.({ file, remainingMs, deadlineMs: Math.max(0, deadline - Date.now()) })
      await sleep(Math.min(EDIT_LOCK_RETRY_MS, remainingMs, Math.max(1, deadline - Date.now())))
    }
  }
}

function releaseLocalMflowEditLock(root: string, file: string, owner: string) {
  const lockDir = mflowEditLockPath(root, file)
  const current = readJson<{ owner?: string }>(path.join(lockDir, "owner.json"), {})
  if (current.owner === owner) {
    const next = { ...current, file, owner, pid: process.pid, releasedAt: Date.now(), expiresAt: Date.now() + EDIT_LOCK_LEASE_MS }
    writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(next, null, 2)}\n`)
  }
}

function discardLocalMflowEditLock(root: string, file: string, owner: string) {
  const lockDir = mflowEditLockPath(root, file)
  const current = readJson<{ owner?: string }>(path.join(lockDir, "owner.json"), {})
  if (current.owner === owner) rmSync(lockDir, { recursive: true, force: true })
}

function localMflowEditLocks(root: string) {
  const lockRoot = mflowEditLockRoot(root)
  const now = Date.now()
  if (!existsSync(lockRoot)) return []
  const out: Array<{ file: string; owner: string; remainingMs: number }> = []
  for (const item of readdirSync(lockRoot, { withFileTypes: true })) {
    if (!item.isDirectory() || !item.name.endsWith(".lock")) continue
    const lockDir = path.join(lockRoot, item.name)
    const current = readJson<{ file?: string; owner?: string; expiresAt?: number }>(path.join(lockDir, "owner.json"), {})
    const remainingMs = (current.expiresAt ?? 0) - now
    if (remainingMs <= 0) {
      rmSync(lockDir, { recursive: true, force: true })
      continue
    }
    if (current.file && current.owner) out.push({ file: current.file, owner: current.owner, remainingMs })
  }
  return out
}

function retryableMflowLockFailure(output: string) {
  return /locked|already|busy|wait|timeout|could not acquire|held/i.test(output)
}

function hasActiveMflowLock(output: string, file: string) {
  return output.split(/\r?\n/).some((line) => {
    const normalized = line.trim().replace(/^[^\w./-]+/, "").trim()
    return normalized === file || normalized.startsWith(`${file} `) || normalized.startsWith(`${file}\t`)
  })
}

async function acquireMflowCliLockWithWait(input: {
  root: string
  file: string
  onWait?: (info: MflowWaitInfo) => Promise<void> | void
}) {
  const deadline = Date.now() + EDIT_LOCK_WAIT_TIMEOUT_MS
  while (true) {
    const result = spawnSync("mflow", mflowImmediateLockCommandArgs(input.file), { cwd: input.root, encoding: "utf8" })
    if (result.status === 0) return
    const output = (result.stderr || result.stdout || result.error?.message || "lock failed").trim()
    if (!retryableMflowLockFailure(output) || Date.now() >= deadline) {
      throw new Error(`mflow could not acquire lock for ${input.file}: ${output}`)
    }
    await input.onWait?.({ file: input.file, remainingMs: Math.max(0, deadline - Date.now()), deadlineMs: Math.max(0, deadline - Date.now()) })
    await sleep(Math.min(EDIT_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())))
  }
}

function pluginSource() {
  return `// Generated by MendCode mflow setup.
// Runtime edit locking is enforced inside MendCode before tool execution.
// This file is kept as a visible scaffold marker for older checkouts and
// must stay passive so it cannot double-lock or diverge from runtime behavior.

export const MflowMendCodePlugin = async () => ({});
export default MflowMendCodePlugin;
`
}

function controlGuide(config: MflowConfig, root: string) {
  return `# mflow for MendCode

State: ${config.enabled ? "enabled" : "disabled"}
Relay: ${config.relayMode === "public" ? `${MFLOW_PUBLIC_RELAY_DISPLAY} (public fair-use)` : config.signaling}
Room: ${config.room}

${PUBLIC_RELAY_WARNING}

MCP command:

\`\`\`bash
${mflowCommand(["mflow-mcp", "--root", root]).map(shellQuote).join(" ")}
\`\`\`

Manual lock:

\`\`\`bash
mflow lock path/to/file --duration 30s
\`\`\`

MendCode enforces pre-edit locks internally before write/edit/apply_patch tools run. A short local lease protects two agents on the same machine; mflow daemon locks protect other peers and remain visible for the lease duration. If a file is locked, MendCode keeps the tool call pending, shows mflow waiting status in the footer, and retries until the lock lease clears or the wait timeout expires.

Never print room secrets.
`
}

function runtimeToml(config: MflowConfig, secret?: string) {
  return `[daemon]
name = ""
type = "auto"

[sync]
signaling = "${escapeToml(config.signaling)}"
room = "${escapeToml(config.room)}"
${config.storeSecret && secret ? `secret = "${escapeToml(secret)}"` : "# secret: set via MFLOW_SECRET env var or .mendcode/mflow/secret.local"}
debounce_ms = 50
max_file_size_bytes = 1048576
max_tracked_files = 5000
unload_after_minutes = 5

[sync.ignore]
patterns = [
${DEFAULT_IGNORE.map((item) => `  "${escapeToml(item)}"`).join(",\n")}
]

[awareness]
broadcast_interval_ms = 5000
share_current_file = true

[transport]
stun_servers = []
reconnect_max_delay_ms = 30000
`
}

async function writeMflowIgnore(root: string) {
  const file = path.join(root, ".mflowignore")
  const existing = existsSync(file) ? await readFile(file, "utf8") : ""
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  for (const entry of DEFAULT_IGNORE) lines.add(entry)
  await writeFile(file, `${[...lines].join("\n")}\n`)
}

async function writeScaffold(config: MflowConfig, secret: string | undefined, root: string, options?: { sync?: boolean }) {
  const paths = mendPaths(root)
  await mkdir(path.dirname(mflowPluginPath(root)), { recursive: true })
  await writeFile(mflowPluginPath(root), pluginSource())
  await writeFile(mflowControlGuidePath(root), controlGuide(config, root))
  await writeMflowIgnore(root)

  await mkdir(path.dirname(mflowRuntimeConfigPath(root)), { recursive: true })
  await writeFile(mflowRuntimeConfigPath(root), runtimeToml(config, secret), { mode: 0o600 })

  if (!config.storeSecret && secret) {
    await mkdir(path.dirname(mflowSecretPath(root)), { recursive: true })
    await writeFile(mflowSecretPath(root), `${secret}\n`, { mode: 0o600 })
  }

  await writeMendMcpServer(
    "mflow",
    {
      type: "local",
      command: mflowCommand(["mflow-mcp", "--root", paths.root]),
      enabled: config.enabled,
      timeout: 5000,
    },
    root,
  )

  if (options?.sync !== false) await syncProject(root)
}

export async function readMflowConfig(root?: string): Promise<MflowConfig> {
  const paths = mendPaths(root)
  return readJsonAsync<MflowConfig>(mflowStatePath(paths.root), {
    version: 1,
    enabled: false,
    relayMode: "public",
    signaling: MFLOW_PUBLIC_RELAY,
    room: defaultRoom(paths.root),
    storeSecret: false,
    hookPriority: 0,
    publicRelayNoticeAccepted: false,
    updatedAt: new Date(0).toISOString(),
  })
}

export async function mflowControlStatus(root?: string) {
  const paths = mendPaths(root)
  const config = await readMflowConfig(paths.root)
  const daemon = spawnSync("mflow", ["status"], { cwd: paths.root, encoding: "utf8" })
  const running = daemon.status === 0 && /running|connected|room|peer/i.test(`${daemon.stdout}\n${daemon.stderr}`)
  const mode: MflowMode = !config.enabled ? "disabled" : running ? "running" : "enabled-stopped"
  const locks = spawnSync("mflow", ["locks"], { cwd: paths.root, encoding: "utf8" })
  return {
    ok: true,
    mode,
    config,
    publicRelayWarning: PUBLIC_RELAY_WARNING,
    files: {
      state: path.relative(paths.root, mflowStatePath(paths.root)),
      runtimeConfig: path.relative(paths.root, mflowRuntimeConfigPath(paths.root)),
      plugin: path.relative(paths.root, mflowPluginPath(paths.root)),
      mcp: ".mendcode/mcp/mflow.json",
      secretStoredLocally: existsSync(mflowSecretPath(paths.root)),
    },
    daemon: {
      checked: true,
      running,
      output: daemon.status === 0 ? daemon.stdout.trim() : daemon.stderr.trim(),
    },
    locks: {
      checked: locks.status === 0,
      output: locks.status === 0 ? locks.stdout.trim() : locks.stderr.trim(),
      local: localMflowEditLocks(paths.root),
    },
  }
}

export async function activateMflow(input: MflowActivateInput, root?: string, options?: { sync?: boolean }) {
  const paths = mendPaths(root)
  const relayMode = input.relayMode
  if (relayMode !== "public" && relayMode !== "custom") {
    throw new Error("mflow relay mode must be public or custom")
  }
  const signaling = relayMode === "public" ? MFLOW_PUBLIC_RELAY : (input.signaling || "").trim()
  if (relayMode === "custom" && !/^wss?:\/\//.test(signaling)) {
    throw new Error("Custom mflow relay URL must start with ws:// or wss://")
  }
  if (relayMode === "public" && !input.publicRelayNoticeAccepted) {
    throw new Error(PUBLIC_RELAY_WARNING)
  }

  const secret = input.generateSecret === false && input.secret
    ? input.secret
    : randomBytes(32).toString("hex")
  const config: MflowConfig = {
    version: 1,
    enabled: true,
    relayMode,
    signaling,
    room: (input.room || defaultRoom(paths.root)).trim(),
    storeSecret: Boolean(input.storeSecret),
    hookPriority: Number.isInteger(input.hookPriority) ? Math.max(0, Math.min(9, input.hookPriority!)) : 0,
    publicRelayNoticeAccepted: relayMode !== "public" || Boolean(input.publicRelayNoticeAccepted),
    updatedAt: new Date().toISOString(),
  }
  if (!config.room) throw new Error("mflow room is required")

  await writeJson(mflowStatePath(paths.root), config)
  await writeScaffold(config, secret, paths.root, options)
  return mflowControlStatus(paths.root)
}

export async function deactivateMflow(root?: string, options?: { sync?: boolean }) {
  const paths = mendPaths(root)
  const current = await readMflowConfig(paths.root)
  const config = { ...current, enabled: false, updatedAt: new Date().toISOString() }
  await writeJson(mflowStatePath(paths.root), config)
  await writeMendMcpServer("mflow", {
    type: "local",
    command: mflowCommand(["mflow-mcp", "--root", paths.root]),
    enabled: false,
    timeout: 5000,
  }, paths.root)
  if (options?.sync !== false) await syncProject(paths.root)
  return mflowControlStatus(paths.root)
}

export async function removeMflowConfig(root?: string, options?: { sync?: boolean }) {
  const paths = mendPaths(root)
  await rm(path.join(paths.mendDir, "mflow"), { recursive: true, force: true })
  await rm(path.join(paths.mendDir, "mcp", "mflow.json"), { force: true })
  await rm(mflowPluginPath(paths.root), { force: true })
  await rm(mflowControlGuidePath(paths.root), { force: true })
  if (options?.sync !== false) await syncProject(paths.root)
  return mflowControlStatus(paths.root)
}

function extractPatchFiles(patchText: string) {
  const files: string[] = []
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)
    if (match?.[1]) files.push(match[1].trim())
  }
  return [...new Set(files)]
}

function normalizeProjectPath(root: string, file: string) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`mflow refused path outside project: ${file}`)
  }
  return relative
}

export function mflowEditTargets(tool: string, args: unknown, root: string) {
  if (!args || typeof args !== "object") return []
  const input = args as Record<string, unknown>
  const normalizedTool = tool.toLowerCase()
  const directPath = input.filePath || input.file_path || input.path
  const files: string[] = []
  if ((normalizedTool === "edit" || normalizedTool === "write" || normalizedTool === "multiedit") && typeof directPath === "string") {
    files.push(directPath)
  }
  if (Array.isArray(input.files)) files.push(...input.files.filter((item): item is string => typeof item === "string"))
  if (Array.isArray(input.paths)) files.push(...input.paths.filter((item): item is string => typeof item === "string"))
  const patchText = input.patchText || input.patch_text || input.patch
  if ((normalizedTool === "apply_patch" || normalizedTool === "apply-patch") && typeof patchText === "string") {
    files.push(...extractPatchFiles(patchText))
  }
  return [...new Set(files.map((file) => normalizeProjectPath(root, file)))]
}

export function mflowReadTargets(tool: string, args: unknown, root: string) {
  if (!args || typeof args !== "object") return []
  const input = args as Record<string, unknown>
  const normalizedTool = tool.toLowerCase()
  const directPath = input.filePath || input.file_path || input.path
  if (normalizedTool !== "read" || typeof directPath !== "string") return []
  try {
    return [normalizeProjectPath(root, directPath)]
  } catch {
    return []
  }
}

async function waitForMflowReadAccess(input: {
  root: string
  file: string
  owner: string
  onWait?: (info: MflowWaitInfo) => Promise<void> | void
}) {
  const deadline = Date.now() + EDIT_LOCK_WAIT_TIMEOUT_MS
  while (true) {
    const local = localMflowEditLocks(input.root).find((lock) => lock.file === input.file)
    const ownLocalLease = local?.owner === input.owner
    const remoteStatus = ownLocalLease ? undefined : spawnSync("mflow", ["locks"], { cwd: input.root, encoding: "utf8" })
    const remote = remoteStatus ? hasActiveMflowLock(`${remoteStatus.stdout}\n${remoteStatus.stderr}`, input.file) : false
    const remainingMs = local && !ownLocalLease ? local.remainingMs : Math.max(0, deadline - Date.now())
    if ((!local || ownLocalLease) && !remote) return
    if (Date.now() >= deadline) throw new Error(`mflow could not read ${input.file}: file is locked`)
    await input.onWait?.({ file: input.file, remainingMs, deadlineMs: Math.max(0, deadline - Date.now()) })
    await sleep(Math.min(EDIT_LOCK_RETRY_MS, Math.max(1, remainingMs), Math.max(1, deadline - Date.now())))
  }
}

export async function enforceMflowBeforeEdit(input: {
  tool: string
  args: unknown
  root: string
  onWait?: (info: MflowWaitInfo) => Promise<void> | void
}) {
  const config = readJson<MflowConfig>(mflowStatePath(input.root), {
    version: 1,
    enabled: false,
    relayMode: "public",
    signaling: MFLOW_PUBLIC_RELAY,
    room: defaultRoom(input.root),
    storeSecret: false,
    hookPriority: 0,
    publicRelayNoticeAccepted: false,
    updatedAt: new Date(0).toISOString(),
  })
  if (!config.enabled) return { locked: [] as string[] }
  const targets = mflowEditTargets(input.tool, input.args, input.root)
  const owner = `pid:${process.pid}`
  const localLocked: string[] = []
  try {
    for (const file of targets) {
      await acquireLocalMflowEditLockWithWait(input.root, file, owner, input.onWait)
      localLocked.push(file)
      await acquireMflowCliLockWithWait({ root: input.root, file, onWait: input.onWait })
    }
  } catch (error) {
    for (const file of localLocked) {
      discardLocalMflowEditLock(input.root, file, owner)
    }
    throw error
  }
  return { locked: targets, owner }
}

export async function waitMflowBeforeRead(input: {
  tool: string
  args: unknown
  root: string
  onWait?: (info: MflowWaitInfo) => Promise<void> | void
}) {
  const config = readJson<MflowConfig>(mflowStatePath(input.root), {
    version: 1,
    enabled: false,
    relayMode: "public",
    signaling: MFLOW_PUBLIC_RELAY,
    room: defaultRoom(input.root),
    storeSecret: false,
    hookPriority: 0,
    publicRelayNoticeAccepted: false,
    updatedAt: new Date(0).toISOString(),
  })
  if (!config.enabled) return { waited: [] as string[] }
  const targets = mflowReadTargets(input.tool, input.args, input.root)
  const owner = `pid:${process.pid}`
  for (const file of targets) {
    await waitForMflowReadAccess({ root: input.root, file, owner, onWait: input.onWait })
  }
  return { waited: targets }
}

export async function releaseMflowLocks(input: { root: string; files: string[]; owner?: string }) {
  for (const file of input.files) {
    if (input.owner) releaseLocalMflowEditLock(input.root, file, input.owner)
  }
}

export { PUBLIC_RELAY_WARNING as MFLOW_PUBLIC_RELAY_WARNING }
