import { spawnSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { createHash, randomBytes } from "crypto"
import net from "net"
import os from "os"
import { mendPaths } from "./paths"
import { syncProject } from "./project"
import { writeMendMcpServer } from "./mcp"

export const MFLOW_LOCAL_RELAY = "ws://localhost:8787"
export const MFLOW_LEGACY_PUBLIC_RELAY = "wss://mflow-signal.obed0101.deno.net"
export const MFLOW_LEGACY_PUBLIC_RELAY_DISPLAY = "https://mflow-signal.obed0101.deno.net/"
export const MFLOW_PACKAGE = "mflow-cli"
export const MFLOW_DEFAULT_RELAY_PORT = 8787

export type MflowMode = "disabled" | "enabled-stopped" | "running"
export type MflowRelayMode = "local" | "public" | "legacy-public" | "remote" | "custom"

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

export type MflowDetectedRelay = {
  url: string
  host: string
  port: number
  scope: "local-machine" | "lan-machine"
  health: "healthy" | "tcp-open" | "unreachable"
  status: string
  roomCount?: number
  peerCount?: number
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
  "Legacy public mflow relay is a shared demo-only service with reliability and platform-limit issues. It is not the recommended free path. Use a local mflow relay on this machine/LAN or a public relay URL controlled by you or your team."
const EDIT_LOCK_LEASE_MS = 35_000
const EDIT_LOCK_WAIT_TIMEOUT_MS = 90_000
const EDIT_LOCK_RETRY_MS = 750
const MFLOW_CLI_TIMEOUT_MS = 1_200
const RELAY_SCAN_TIMEOUT_MS = 300

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
  return ["pnpm", "dlx", "--package", MFLOW_PACKAGE, ...args]
}

function relayModeLabel(mode: MflowRelayMode) {
  if (mode === "local") return "Local relay"
  if (mode === "public") return "Public relay URL"
  if (mode === "remote") return "Public relay URL"
  if (mode === "custom") return "Public relay URL"
  return "Legacy public relay"
}

function normalizeRelayMode(mode: MflowRelayMode): MflowRelayMode {
  if (mode === "custom" || mode === "remote") return "public"
  return mode
}

function normalizePublicSignaling(value: string) {
  if (value.startsWith("https://")) return `wss://${value.slice("https://".length)}`
  if (value.startsWith("http://")) return `ws://${value.slice("http://".length)}`
  return value
}

function mflowImmediateLockCommandArgs(file: string) {
  return ["lock", file, "--duration", "30s"]
}

function runMflowCli(root: string, args: string[], timeout = MFLOW_CLI_TIMEOUT_MS) {
  try {
    const result = spawnSync("mflow", args, { cwd: root, encoding: "utf8", timeout })
    const stdout = result.stdout?.trim() ?? ""
    const stderr = result.stderr?.trim() ?? ""
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
    const missing = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    const output = [stdout, stderr, timedOut ? `mflow command timed out after ${timeout}ms` : "", missing ? "mflow CLI is not installed" : "", result.error?.message ?? ""]
      .filter(Boolean)
      .join("\n")
      .trim()
    return {
      ok: result.status === 0 && !result.error,
      status: result.status,
      output: output || "mflow command produced no output",
      timedOut,
      missing,
    }
  } catch (error: any) {
    return {
      ok: false,
      status: null,
      output: error?.message || "mflow command failed",
      timedOut: error?.code === "ETIMEDOUT",
      missing: error?.code === "ENOENT",
    }
  }
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
    const result = runMflowCli(input.root, mflowImmediateLockCommandArgs(input.file))
    if (result.ok) return
    const output = result.output || "lock failed"
    if (result.timedOut || result.missing || !retryableMflowLockFailure(output) || Date.now() >= deadline) {
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
Relay: ${relayModeLabel(config.relayMode)} (${config.signaling})
Room: ${config.room}

MendCode is local-first for mflow. Prefer a relay on this machine or the local WiFi/LAN. Use a public URL only for a relay controlled by you or your team, such as a VPS or domain with WebSockets. The old public Deno relay is legacy/demo-only and should not be used for normal onboarding.

Local relay examples:

\`\`\`bash
PORT=8787 bun run packages/signaling/src/index.ts
docker build -f packages/signaling/Dockerfile -t mflow-signaling .
docker run --rm -p 8787:8787 -e PORT=8787 mflow-signaling
\`\`\`

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
    relayMode: "local",
    signaling: MFLOW_LOCAL_RELAY,
    room: defaultRoom(paths.root),
    storeSecret: false,
    hookPriority: 0,
    publicRelayNoticeAccepted: false,
    updatedAt: new Date(0).toISOString(),
  })
}

function localRelayHosts() {
  const hosts = new Set(["localhost", "127.0.0.1"])
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue
      hosts.add(entry.address)
      const parts = entry.address.split(".")
      if (parts.length === 4) {
        for (let host = 1; host <= 254; host++) hosts.add(`${parts[0]}.${parts[1]}.${parts[2]}.${host}`)
      }
    }
  }
  return [...hosts]
}

function tcpProbe(host: string, port: number, timeout = RELAY_SCAN_TIMEOUT_MS) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

function countValue(value: unknown) {
  if (typeof value === "number") return value
  if (Array.isArray(value)) return value.length
  if (value && typeof value === "object") return Object.keys(value).length
  return undefined
}

async function relayHttpStatus(host: string, port: number): Promise<Pick<MflowDetectedRelay, "health" | "status" | "roomCount" | "peerCount">> {
  for (const pathName of ["/health", "/status", "/"]) {
    try {
      const response = await fetch(`http://${host}:${port}${pathName}`, { signal: AbortSignal.timeout(RELAY_SCAN_TIMEOUT_MS) })
      const text = await response.text()
      const parsed = text.trim().startsWith("{") ? JSON.parse(text) as Record<string, unknown> : {}
      return {
        health: response.ok ? "healthy" as const : "tcp-open" as const,
        status: response.ok ? `http ${response.status}` : `http ${response.status}; websocket port open`,
        roomCount: countValue(parsed.rooms ?? parsed.roomCount ?? parsed.room_count),
        peerCount: countValue(parsed.peers ?? parsed.peerCount ?? parsed.peer_count),
      }
    } catch {}
  }
  return { health: "tcp-open" as const, status: "websocket port open" }
}

export async function scanMflowRelays(options?: { port?: number; hosts?: string[] }): Promise<MflowDetectedRelay[]> {
  const port = options?.port ?? MFLOW_DEFAULT_RELAY_PORT
  const own = new Set(["localhost", "127.0.0.1", ...Object.values(os.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => entry.family === "IPv4").map((entry) => entry.address)
  )])
  const hosts = [...new Set(options?.hosts ?? localRelayHosts())]
  const results = await Promise.all(hosts.map(async (host): Promise<MflowDetectedRelay | undefined> => {
    if (!await tcpProbe(host, port)) return
    const status = await relayHttpStatus(host, port)
    return {
      url: `ws://${host}:${port}`,
      host,
      port,
      scope: own.has(host) ? "local-machine" as const : "lan-machine" as const,
      ...status,
    }
  }))
  return results.filter((item): item is MflowDetectedRelay => item !== undefined)
    .sort((a, b) => Number(a.scope !== "local-machine") - Number(b.scope !== "local-machine") || a.host.localeCompare(b.host))
}

export function mflowLocalRelayGuide(root?: string) {
  const paths = mendPaths(root)
  return {
    recommendedUrl: MFLOW_LOCAL_RELAY,
    lanUrlExample: "ws://<relay-lan-ip>:8787",
    commands: [
      "PORT=8787 bun run packages/signaling/src/index.ts",
      "docker build -f packages/signaling/Dockerfile -t mflow-signaling .",
      "docker run --rm -p 8787:8787 -e PORT=8787 mflow-signaling",
    ],
    note: "Run the Bun/Docker relay command from an mflow repo checkout until mflow ships a packaged relay start command.",
    mcpCommand: mflowCommand(["mflow-mcp", "--root", paths.root]),
  }
}

export async function mflowControlStatus(root?: string) {
  const paths = mendPaths(root)
  const config = await readMflowConfig(paths.root)
  const localLocks = localMflowEditLocks(paths.root)
  if (!config.enabled) {
    return {
      ok: true,
      mode: "disabled" as MflowMode,
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
        checked: false,
        running: false,
        output: "mflow disabled; daemon was not checked",
      },
      locks: {
        checked: false,
        output: "mflow disabled; remote locks were not checked",
        local: localLocks,
      },
    }
  }

  const daemon = runMflowCli(paths.root, ["status"])
  const running = daemon.ok && /running|connected|room|peer/i.test(daemon.output)
  const mode: MflowMode = running ? "running" : "enabled-stopped"
  const locks = runMflowCli(paths.root, ["locks"])
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
      output: daemon.output,
    },
    locks: {
      checked: locks.ok,
      output: locks.output,
      local: localLocks,
    },
  }
}

export async function activateMflow(input: MflowActivateInput, root?: string, options?: { sync?: boolean }) {
  const paths = mendPaths(root)
  const relayMode = normalizeRelayMode(input.relayMode)
  if (relayMode !== "local" && relayMode !== "public" && relayMode !== "legacy-public") {
    throw new Error("mflow relay mode must be local, public, or legacy-public")
  }
  const signaling = relayMode === "legacy-public"
    ? MFLOW_LEGACY_PUBLIC_RELAY
    : relayMode === "local"
      ? normalizePublicSignaling((input.signaling || MFLOW_LOCAL_RELAY).trim())
      : normalizePublicSignaling((input.signaling || "").trim())
  if (relayMode === "public" && !/^wss?:\/\//.test(signaling)) {
    throw new Error("Public mflow relay URL must start with ws://, wss://, http://, or https://")
  }
  if (relayMode === "local" && !/^wss?:\/\/[^/]+:\d+/.test(signaling)) {
    throw new Error("Local mflow relay URL must be ws://host:port or wss://host:port")
  }
  if (relayMode === "legacy-public" && !input.publicRelayNoticeAccepted) {
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
    publicRelayNoticeAccepted: relayMode !== "legacy-public" || Boolean(input.publicRelayNoticeAccepted),
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
    return absolute
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
  return [normalizeProjectPath(root, directPath)]
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
    const remoteStatus = ownLocalLease ? undefined : runMflowCli(input.root, ["locks"])
    const remote = remoteStatus?.ok ? hasActiveMflowLock(remoteStatus.output, input.file) : false
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
    relayMode: "local",
    signaling: MFLOW_LOCAL_RELAY,
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
    relayMode: "local",
    signaling: MFLOW_LOCAL_RELAY,
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

export { PUBLIC_RELAY_WARNING as MFLOW_PUBLIC_RELAY_WARNING, MFLOW_LEGACY_PUBLIC_RELAY as MFLOW_PUBLIC_RELAY }
