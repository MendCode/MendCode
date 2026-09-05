import fs from "fs/promises"
import path from "path"
import { realpathSync } from "fs"
import { Global } from "@mendcode/core/global"
import { Flag } from "@mendcode/core/flag/flag"
import { InstallationChannel } from "@mendcode/core/installation/version"
import { resolveDefaultSqliteDbPath } from "@/storage/resolve-default-sqlite-path"

const STATE_VERSION = 1 as const
const LOCK_STALE_AFTER_MS = 30_000
const CLIENT_LEASE_HEARTBEAT_MS = 5_000
const CLIENT_LEASE_STALE_AFTER_MS = 30_000
const SHARED_SERVER_IDLE_GRACE_MS = 15_000
const SHARED_SERVER_LEASE_POLL_MS = 5_000

export type SharedServerState = {
  version: typeof STATE_VERSION
  pid: number
  url: string
  username: string
  password: string
  startedAt: string
  runtimeID: string
}

function canonicalPath(file: string): string {
  try {
    return realpathSync(file)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(canonicalPath(parent), path.basename(file))
  }
}

export function resolveSharedDatabasePath(database: string | undefined, dataDir = Global.Path.data) {
  if (!database || database === ":memory:") return database
  return canonicalPath(path.resolve(dataDir, database))
}

export function resolveSharedServerRoot(input: {
  database?: string
  defaultDatabase: string
  stateDirectory: string
  pid?: number
}) {
  const legacy = path.join(input.stateDirectory, "shared-server")
  if (!input.database) return legacy
  if (input.database === ":memory:") return path.join(legacy, `memory-${input.pid ?? process.pid}`)
  const database = canonicalPath(path.resolve(input.database))
  if (database === canonicalPath(path.resolve(input.defaultDatabase))) return legacy
  // A DB-specific lock must not depend on the client's XDG state directory.
  return `${database}.shared-server`
}

function rootPath() {
  if (process.env.MENDCODE_SHARED_SERVER_STATE_FILE) {
    return path.dirname(process.env.MENDCODE_SHARED_SERVER_STATE_FILE)
  }
  return resolveSharedServerRoot({
    database: resolveSharedDatabasePath(Flag.OPENCODE_DB),
    defaultDatabase: resolveDefaultSqliteDbPath({
      dataDir: Global.Path.data,
      installationChannel: InstallationChannel,
      disableChannelDb: Flag.OPENCODE_DISABLE_CHANNEL_DB,
    }),
    stateDirectory: Global.Path.state,
  })
}

export function statePath() {
  return path.join(rootPath(), "server.json")
}

function lockPath() {
  return path.join(rootPath(), "server.lock")
}

export function legacyClientLeaseDirectoryPath() {
  return path.join(rootPath(), "clients")
}

export function clientLeaseDirectoryPath(serverPID: number) {
  return path.join(legacyClientLeaseDirectoryPath(), String(serverPID))
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return
  return typeof error.code === "string" ? error.code : undefined
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

export function shouldReplaceLiveServer(input: {
  pid: number
  activeClients: number
  currentPid?: number
  allowLiveServerReplacement?: boolean
}) {
  // A reconnect must never take down a server that is still serving other
  // TUI clients. Replacing a live process is only safe when this is the sole
  // local client and the PID is not the caller itself.
  return (
    input.allowLiveServerReplacement !== false &&
    input.pid !== (input.currentPid ?? process.pid) &&
    input.activeClients <= 1
  )
}

export function shouldReplaceSharedServer(input: {
  live: boolean
  runtimeMatches: boolean
  activeClients: number
  reachable?: boolean
}) {
  if (!input.live) return true
  if (input.reachable === false) return input.activeClients === 0
  if (input.runtimeMatches) return false
  return input.activeClients === 0
}

export function shouldAttachExistingSharedServer(input: {
  live: boolean
  runtimeMatches: boolean
  activeClients: number
  reachable?: boolean
}) {
  return input.reachable !== false && input.live && !input.runtimeMatches && input.activeClients > 0
}

export function shouldUseSharedServer(input: {
  serverURL?: string
  isolated?: boolean
  networkOptionSet: boolean
  disabledByEnvironment?: boolean
}) {
  return !input.serverURL && !input.isolated && !input.networkOptionSet && input.disabledByEnvironment !== true
}

function validState(value: unknown): value is SharedServerState {
  if (!value || typeof value !== "object") return false
  const state = value as Record<string, unknown>
  if (state.version !== STATE_VERSION) return false
  if (typeof state.pid !== "number" || !Number.isInteger(state.pid) || state.pid <= 0) return false
  if (typeof state.url !== "string" || typeof state.username !== "string" || typeof state.password !== "string")
    return false
  if (typeof state.startedAt !== "string") return false
  if (typeof state.runtimeID !== "string" || !state.runtimeID) return false

  try {
    const url = new URL(state.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return false
    if (url.username || url.password) return false
  } catch {
    return false
  }

  return true
}

export function parseState(value: unknown) {
  return validState(value) ? value : undefined
}

export async function readState() {
  try {
    return parseState(JSON.parse(await fs.readFile(statePath(), "utf8")))
  } catch {
    return undefined
  }
}

export async function writeState(state: SharedServerState) {
  await fs.mkdir(rootPath(), { recursive: true, mode: 0o700 })
  const temporary = `${statePath()}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
    await fs.rm(statePath(), { force: true })
    await fs.rename(temporary, statePath())
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function clearState() {
  await fs.rm(statePath(), { force: true }).catch(() => undefined)
}

export async function clearStateIfOwned(pid = process.pid) {
  const state = await readState()
  if (state?.pid !== pid) return false
  await clearState()
  return true
}

export type SharedServerClientLease = {
  serverPID: number
  release: () => Promise<void>
}

export async function acquireClientLease(
  serverPID: number,
  directory = clientLeaseDirectoryPath(serverPID),
  heartbeatMs = CLIENT_LEASE_HEARTBEAT_MS,
): Promise<SharedServerClientLease> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const leasePath = path.join(directory, `${process.pid}-${crypto.randomUUID()}.lease`)
  const writeLease = () =>
    fs.writeFile(leasePath, JSON.stringify({ clientPID: process.pid, serverPID }), { encoding: "utf8", mode: 0o600 })
  await writeLease()

  let released = false
  const heartbeat = setInterval(() => {
    if (released) return
    void fs
      .utimes(leasePath, new Date(), new Date())
      .catch(async (error) => {
        if (released || errorCode(error) !== "ENOENT") return
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        if (!released) await writeLease()
      })
      .catch(() => undefined)
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    serverPID,
    async release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      await fs.rm(leasePath, { force: true }).catch(() => undefined)
      await fs.rmdir(directory).catch(() => undefined)
    },
  }
}

function leaseClientPID(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && "clientPID" in parsed && typeof parsed.clientPID === "number") {
      return parsed.clientPID
    }
  } catch {
    // Legacy leases contain only the client PID.
  }
  const pid = Number.parseInt(value, 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export async function activeClientLeaseCount(directory: string, staleAfterMs = CLIENT_LEASE_STALE_AFTER_MS) {
  const entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" }).catch(() => undefined)
  if (!entries) return 0

  let active = 0
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".lease")) return
      const leasePath = path.join(directory, entry.name)
      try {
        const stat = await fs.stat(leasePath)
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          const pid = leaseClientPID(await fs.readFile(leasePath, "utf8"))
          if (pid && isProcessAlive(pid)) {
            active++
            return
          }
          await fs.rm(leasePath, { force: true })
          return
        }
        active++
      } catch {
        // The client may have released the lease between readdir and stat.
      }
    }),
  )
  return active
}

export async function activeClientLeaseCountForServer(
  serverPID: number,
  staleAfterMs = CLIENT_LEASE_STALE_AFTER_MS,
  legacyDirectory = legacyClientLeaseDirectoryPath(),
) {
  const [scoped, legacy] = await Promise.all([
    activeClientLeaseCount(clientLeaseDirectoryPath(serverPID), staleAfterMs),
    activeClientLeaseCount(legacyDirectory, staleAfterMs),
  ])
  return scoped + legacy
}

export async function waitForClientLeases(input: {
  stop: () => Promise<void>
  pid?: number
  directory?: string
  pollMs?: number
  idleGraceMs?: number
  signal?: AbortSignal
  hasActiveWork?: () => Promise<boolean>
}) {
  const serverPID = input.pid ?? process.pid
  const directory = input.directory ?? clientLeaseDirectoryPath(serverPID)
  const pollMs = input.pollMs ?? SHARED_SERVER_LEASE_POLL_MS
  const idleGraceMs = input.idleGraceMs ?? SHARED_SERVER_IDLE_GRACE_MS
  let lastLiveAt = Date.now()

  while (!input.signal?.aborted) {
    const activeClients = input.directory
      ? await activeClientLeaseCount(directory)
      : await activeClientLeaseCountForServer(serverPID)
    const activeWork = input.hasActiveWork ? await input.hasActiveWork().catch(() => true) : false
    if (activeClients > 0 || activeWork) {
      lastLiveAt = Date.now()
    } else if (Date.now() - lastLiveAt >= idleGraceMs) {
      try {
        await input.stop()
      } finally {
        await clearStateIfOwned(input.pid)
      }
      return
    }
    if (input.signal?.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, pollMs)
      input.signal?.addEventListener("abort", done, { once: true })
    })
  }
}

export async function diagnostics(pid = process.pid) {
  if (!process.env.MENDCODE_SHARED_SERVER_STATE_FILE) return
  const state = await readState()
  return {
    runtimeID: process.env.MENDCODE_SHARED_SERVER_RUNTIME_ID || state?.runtimeID || "unknown",
    stateOwner: state?.pid === pid,
    activeClientLeases: await activeClientLeaseCount(clientLeaseDirectoryPath(pid)),
  }
}

export function credentials() {
  return {
    username: process.env.MENDCODE_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || "mendcode",
    password:
      process.env.MENDCODE_SERVER_PASSWORD ||
      process.env.OPENCODE_SERVER_PASSWORD ||
      `${crypto.randomUUID()}${crypto.randomUUID()}`,
  }
}

export async function acquireLock(timeoutMs = 12_000) {
  await fs.mkdir(rootPath(), { recursive: true, mode: 0o700 })
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    try {
      await fs.mkdir(lockPath())
      await fs.writeFile(path.join(lockPath(), "owner"), String(process.pid), { encoding: "utf8", mode: 0o600 })
      return async () => {
        await fs.rm(lockPath(), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch {
      try {
        const stat = await fs.stat(lockPath())
        const owner = Number(await fs.readFile(path.join(lockPath(), "owner"), "utf8"))
        if (
          Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS &&
          Number.isSafeInteger(owner) && owner > 0 && !isProcessAlive(owner)
        ) {
          await fs.rm(lockPath(), { recursive: true, force: true })
          continue
        }
      } catch {
        // The lock disappeared between mkdir and stat. Retry immediately.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return undefined
}

export * as SharedServer from "./shared-server"
