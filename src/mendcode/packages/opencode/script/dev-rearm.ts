import { randomUUID } from "node:crypto"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveDualReadDbPathFromLayout } from "../src/storage/resolve-default-sqlite-path"
import { readGlobalLayoutInstallSelection, resolveActiveAppSegmentFromDirs } from "@mendcode/core/global-layout"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE_ENTRYPOINT = path.join(PACKAGE_ROOT, "src", "index.ts")
const STATE_VERSION = 1
const CLIENT_LEASE_STALE_AFTER_MS = 30_000
const PROBE_TIMEOUT_MS = 2_000
const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000
const POLL_MS = 250

type SharedServerState = {
  version: number
  pid: number
  url: string
  username: string
  password: string
  startedAt: string
  runtimeID: string
}

export type DevRearmPaths = {
  home: string
  data: string
  config: string
  state: string
  cache: string
  segment: "mendcode" | "opencode"
  db: string
  stateFile: string
  lockFile: string
  clientsDir: string
}

export type RuntimeProbe = {
  ok: boolean
  reason?: string
  health?: { healthy?: boolean; version?: string; channel?: string }
  instance?: { directory?: string; worktree?: string; home?: string }
  sessions?: unknown[]
  providers?: { all?: unknown[]; default?: Record<string, string>; connected?: string[] }
}

export type DevRearmResult = {
  url: string
  pid: number
  project: string
  db: string
  paths: DevRearmPaths
  runtimeID: string
  probe: RuntimeProbe
}

type ProcessInfo = { pid: number; command: string }

export type DevRearmOptions = {
  project: string
  minSessions: number
  minProviders: number
  checkOnly: boolean
  launchTui: boolean
  env?: NodeJS.ProcessEnv
  packageRoot?: string
  entrypoint?: string
  spawnServer?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess
}

function envValue(env: NodeJS.ProcessEnv, name: string) {
  const mend = `MENDCODE_${name.slice("OPENCODE_".length)}`
  const primary = env[mend]
  if (primary) return primary
  const fallback = env[name]
  return fallback || undefined
}

function truthy(value: string | undefined) {
  if (value === undefined) return false
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase())
}

function xdgRoot(env: NodeJS.ProcessEnv, key: string, fallback: string) {
  return env[key] || fallback
}

export function resolveDevRearmPaths(env: NodeJS.ProcessEnv = process.env): DevRearmPaths {
  const home = env.OPENCODE_TEST_HOME || env.HOME || os.homedir()
  const dataBase = xdgRoot(env, "XDG_DATA_HOME", path.join(home, ".local", "share"))
  const stateBase = xdgRoot(env, "XDG_STATE_HOME", path.join(home, ".local", "state"))
  const configBase = xdgRoot(env, "XDG_CONFIG_HOME", path.join(home, ".config"))
  const cacheBase = xdgRoot(env, "XDG_CACHE_HOME", path.join(home, ".cache"))
  const segment = resolveActiveAppSegmentFromDirs({
    environmentSelection: env.MENDCODE_GLOBAL_LAYOUT,
    installSelection: readGlobalLayoutInstallSelection(home),
    legacyEnvironmentSelection: env.OPENCODE_GLOBAL_LAYOUT,
    legacyDataDir: path.join(dataBase, "opencode"),
    mendDataDir: path.join(dataBase, "mendcode"),
  })
  const data = path.join(dataBase, segment)
  const state = path.join(stateBase, segment)
  const config = envValue(env, "OPENCODE_CONFIG_DIR") || path.join(configBase, segment)
  const cache = path.join(cacheBase, segment)
  const dbOverride = envValue(env, "OPENCODE_DB")
  const db = dbOverride
    ? dbOverride === ":memory:"
      ? dbOverride
      : path.isAbsolute(dbOverride)
        ? dbOverride
        : path.join(data, dbOverride)
    : resolveDualReadDbPathFromLayout(
        data,
        env.MENDCODE_CHANNEL || "local",
        truthy(envValue(env, "OPENCODE_DISABLE_CHANNEL_DB")),
      )
  const shared = path.join(state, "shared-server")
  return {
    home,
    data,
    config,
    state,
    cache,
    segment,
    db,
    stateFile: path.join(shared, "server.json"),
    lockFile: path.join(shared, "server.lock"),
    clientsDir: path.join(shared, "clients"),
  }
}

async function exists(target: string) {
  return access(target).then(
    () => true,
    () => false,
  )
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function parseProcessList(output: string) {
  const result: ProcessInfo[] = []
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    result.push({ pid: Number(match[1]), command: match[2] })
  }
  return result
}

export function listMendCodeServeProcesses(packageRoot = PACKAGE_ROOT): ProcessInfo[] {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
  if (result.error || result.status !== 0) return []
  return parseProcessList(String(result.stdout)).filter(
    (item) =>
      item.command.includes("serve") &&
      (item.command.includes(packageRoot) || /(?:^|[\\/])(?:mendcode|opencode)(?:\s|$)/i.test(item.command)),
  )
}

function safeServerProcess(pid: number, packageRoot = PACKAGE_ROOT) {
  return listMendCodeServeProcesses(packageRoot).find((item) => item.pid === pid)
}

async function readState(stateFile: string): Promise<SharedServerState | undefined> {
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8")) as Partial<SharedServerState>
    if (
      value.version !== STATE_VERSION ||
      !Number.isInteger(value.pid) ||
      !value.url ||
      !value.username ||
      !value.password ||
      !value.startedAt ||
      !value.runtimeID
    )
      return
    const url = new URL(value.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return
    return value as SharedServerState
  } catch {
    return
  }
}

function authHeaders(state: SharedServerState, project: string) {
  const authorization = `Basic ${Buffer.from(`${state.username}:${state.password}`).toString("base64")}`
  const directory = encodeURIComponent(project)
  return {
    Authorization: authorization,
    "x-mendcode-directory": directory,
    "x-opencode-directory": directory,
  }
}

async function requestJson(state: SharedServerState, project: string, requestPath: string) {
  const response = await fetch(new URL(requestPath, state.url), {
    headers: authHeaders(state, project),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (!response.ok) throw new Error(`${requestPath} returned HTTP ${response.status}: ${text.slice(0, 240)}`)
  return value
}

function pathMatches(actual: string | undefined, expected: string) {
  if (!actual) return false
  return path.resolve(actual) === path.resolve(expected)
}

export async function probeRuntime(
  state: SharedServerState,
  project: string,
  expectedVersion: string,
  minSessions = 1,
  minProviders = 1,
): Promise<RuntimeProbe> {
  try {
    const health = (await requestJson(state, project, "/global/health")) as RuntimeProbe["health"]
    if (!health?.healthy) return { ok: false, reason: "health response is not healthy", health }
    if (health.version !== expectedVersion)
      return {
        ok: false,
        reason: `runtime version ${health.version ?? "unknown"} != source ${expectedVersion}`,
        health,
      }
    if (health.channel !== "local")
      return { ok: false, reason: `runtime channel ${health.channel ?? "unknown"} is not source-local`, health }

    const instance = (await requestJson(state, project, "/path")) as RuntimeProbe["instance"]
    if (!pathMatches(instance?.directory, project)) {
      return {
        ok: false,
        reason: `InstanceContext directory ${instance?.directory ?? "missing"} != ${project}`,
        health,
        instance,
      }
    }

    const sessionPayload = (await requestJson(state, project, "/session?scope=project&limit=100")) as unknown
    const sessions = Array.isArray(sessionPayload) ? sessionPayload : undefined
    if (!sessions || sessions.length < minSessions) {
      return {
        ok: false,
        reason: `session endpoint returned ${sessions?.length ?? "invalid"} rows; expected at least ${minSessions}`,
        health,
        instance,
        sessions: sessions ?? [],
      }
    }

    const providers = (await requestJson(state, project, "/provider")) as RuntimeProbe["providers"]
    const all = Array.isArray(providers?.all) ? providers.all : undefined
    if (!all || all.length < minProviders) {
      return {
        ok: false,
        reason: `provider endpoint returned ${all?.length ?? "invalid"} providers; expected at least ${minProviders}`,
        health,
        instance,
        sessions,
        providers: providers ?? {},
      }
    }
    const defaults = providers?.default && typeof providers.default === "object" ? providers.default : undefined
    if (!defaults || Object.keys(defaults).length < 1) {
      return {
        ok: false,
        reason: "provider endpoint returned no default model; refusing a TUI with no provider selected",
        health,
        instance,
        sessions,
        providers: providers ?? {},
      }
    }

    return { ok: true, health, instance, sessions, providers }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForRuntime(
  stateFile: string,
  project: string,
  expectedVersion: string,
  expectedPid: number | undefined,
  minSessions: number,
  minProviders: number,
  timeoutMs = START_TIMEOUT_MS,
) {
  const started = Date.now()
  let last: RuntimeProbe = { ok: false, reason: "shared server state not written" }
  while (Date.now() - started < timeoutMs) {
    const state = await readState(stateFile)
    if (state && (expectedPid === undefined || state.pid === expectedPid)) {
      last = await probeRuntime(state, project, expectedVersion, minSessions, minProviders)
      if (last.ok) return { state, probe: last }
    }
    await sleep(POLL_MS)
  }
  throw new Error(`runtime did not pass readiness gates within ${timeoutMs}ms: ${last.reason ?? "unknown error"}`)
}

async function activeClientLeases(clientsDir: string) {
  const roots = await readdir(clientsDir, { withFileTypes: true }).catch(() => [])
  let active = 0
  const inspect = async (file: string) => {
    if (!file.endsWith(".lease")) return
    try {
      const metadata = await stat(file)
      const value = JSON.parse(await readFile(file, "utf8")) as { clientPID?: unknown }
      const clientPID = typeof value.clientPID === "number" ? value.clientPID : undefined
      const stale = Date.now() - metadata.mtimeMs > CLIENT_LEASE_STALE_AFTER_MS
      if (!stale || (clientPID !== undefined && processAlive(clientPID))) active++
    } catch {
      // A lease disappearing during inspection is not an active lease.
    }
  }
  await Promise.all(
    roots.map(async (entry) => {
      const target = path.join(clientsDir, entry.name)
      if (entry.isDirectory()) {
        const nested = await readdir(target, { withFileTypes: true }).catch(() => [])
        await Promise.all(nested.filter((item) => item.isFile()).map((item) => inspect(path.join(target, item.name))))
        return
      }
      if (entry.isFile()) await inspect(target)
    }),
  )
  return active
}

async function acquireLock(lockFile: string) {
  await mkdir(path.dirname(lockFile), { recursive: true })
  try {
    await mkdir(lockFile)
  } catch {
    let age = "unknown"
    try {
      age = `${Math.round((Date.now() - (await stat(lockFile)).mtimeMs) / 1000)}s`
    } catch {
      // The lock may have disappeared between mkdir and stat.
    }
    throw new Error(`another MendCode rearm is already running (lock age ${age}); refusing to start a competitor`)
  }
  await writeFile(path.join(lockFile, "owner"), `${process.pid}\n`, { encoding: "utf8", mode: 0o600 })
  return async () => {
    await rm(lockFile, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function archiveState(stateFile: string) {
  if (!(await exists(stateFile))) return
  const backup = `${stateFile}.stale-${Date.now()}-${process.pid}.json`
  await rename(stateFile, backup)
  return backup
}

async function stopServer(pid: number, packageRoot: string) {
  const processInfo = safeServerProcess(pid, packageRoot)
  if (!processInfo) throw new Error(`refusing to stop pid ${pid}: command is not a MendCode source serve process`)
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if (!processAlive(pid)) return
    throw new Error(
      `could not signal stale MendCode server pid ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return
    await sleep(100)
  }
  throw new Error(`stale MendCode server pid ${pid} did not exit after SIGTERM; no force-kill attempted`)
}

async function sourceRuntimeID(entrypoint: string, packageRoot: string) {
  const metadata = await stat(entrypoint).catch(() => undefined)
  const sourceFiles: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) return visit(file)
        if (!entry.isFile()) return
        const item = await stat(file).catch(() => undefined)
        if (item) sourceFiles.push(`${path.relative(packageRoot, file)}:${item.size}:${item.mtimeMs}`)
      }),
    )
  }
  await visit(path.join(packageRoot, "src"))
  const hash = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(sourceFiles.sort().join("\n")))
    .then((buffer) => Buffer.from(buffer).toString("hex"))
  return [entrypoint, metadata?.size ?? "unknown", metadata?.mtimeMs ?? "unknown", hash].join(":")
}

async function packageVersion(packageRoot: string) {
  const value = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown }
  if (typeof value.version !== "string" || !value.version) throw new Error("source package version is missing")
  return value.version
}

async function spawnSourceServer(
  packageRoot: string,
  entrypoint: string,
  env: NodeJS.ProcessEnv,
  spawnServer = (args: string[], childEnv: NodeJS.ProcessEnv, cwd: string) =>
    spawn(process.execPath, args, { cwd, env: childEnv, detached: true, stdio: "ignore" }),
) {
  const child = spawnServer(
    [
      "--cwd",
      packageRoot,
      "--no-install",
      "--conditions=browser",
      entrypoint,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    env,
    packageRoot,
  )
  child.unref()
  return child
}

function runtimeEnvironment(input: {
  env: NodeJS.ProcessEnv
  paths: DevRearmPaths
  runtimeID: string
  username: string
  password: string
}) {
  const env = { ...input.env }
  for (const key of [
    "MENDCODE_SERVER_URL",
    "OPENCODE_SERVER_URL",
    "MENDCODE_DISABLE_SHARED_SERVER",
    "OPENCODE_DISABLE_SHARED_SERVER",
  ]) {
    delete env[key]
  }
  const dataBase = path.dirname(input.paths.data)
  const stateBase = path.dirname(input.paths.state)
  const configBase = path.dirname(input.paths.config)
  const cacheBase = path.dirname(input.paths.cache)
  Object.assign(env, {
    HOME: input.paths.home,
    XDG_DATA_HOME: dataBase,
    XDG_STATE_HOME: stateBase,
    XDG_CONFIG_HOME: configBase,
    XDG_CACHE_HOME: cacheBase,
    MENDCODE_GLOBAL_LAYOUT: input.paths.segment,
    OPENCODE_GLOBAL_LAYOUT: input.paths.segment,
    MENDCODE_DB: input.paths.db,
    OPENCODE_DB: input.paths.db,
    MENDCODE_CONFIG_DIR: input.paths.config,
    OPENCODE_CONFIG_DIR: input.paths.config,
    MENDCODE_SHARED_SERVER_STATE_FILE: input.paths.stateFile,
    MENDCODE_SHARED_SERVER_RUNTIME_ID: input.runtimeID,
    MENDCODE_SERVER_USERNAME: input.username,
    OPENCODE_SERVER_USERNAME: input.username,
    MENDCODE_SERVER_PASSWORD: input.password,
    OPENCODE_SERVER_PASSWORD: input.password,
    MENDCODE_USE_SOURCE_RUNTIME: "1",
    MENDCODE_RUNTIME: "1",
    OPENCODE: "1",
    AGENT: "1",
  })
  return env
}

async function rearm(input: DevRearmOptions): Promise<DevRearmResult> {
  const env = input.env ?? process.env
  const packageRoot = input.packageRoot ?? PACKAGE_ROOT
  const entrypoint = input.entrypoint ?? SOURCE_ENTRYPOINT
  const project = await realpath(path.resolve(input.project))
  const paths = resolveDevRearmPaths(env)
  if (paths.db === ":memory:")
    throw new Error("refusing an in-memory DB; dev rearm requires the authoritative persisted DB")
  if (!(await exists(paths.db)))
    throw new Error(`authoritative DB does not exist: ${paths.db}; refusing to create an empty UI`)
  const version = await packageVersion(packageRoot)
  const runtimeID = await sourceRuntimeID(entrypoint, packageRoot)
  const processes = listMendCodeServeProcesses(packageRoot)
  const release = await acquireLock(paths.lockFile)
  let staleBackup: string | undefined
  try {
    const state = await readState(paths.stateFile)
    if (!state && processes.length > 0) {
      throw new Error(
        `MendCode serve process exists without a valid shared-server state (${processes.map((item) => item.pid).join(", ")}); refusing to create a competitor`,
      )
    }

    if (state) {
      const probe = await probeRuntime(state, project, version, input.minSessions, input.minProviders)
      const currentRuntime = state.runtimeID === runtimeID
      if (probe.ok && currentRuntime) {
        const running = listMendCodeServeProcesses(packageRoot)
        if (running.length !== 1 || running[0]?.pid !== state.pid) {
          throw new Error(
            `shared server passed readiness but uniqueness failed; observed pids ${running.map((item) => item.pid).join(", ") || "none"}`,
          )
        }
        return { url: state.url, pid: state.pid, project, db: paths.db, paths, runtimeID, probe }
      }

      const active = await activeClientLeases(paths.clientsDir)
      if (active > 0) {
        throw new Error(
          `shared server pid ${state.pid} is not ready (${probe.reason ?? "runtime mismatch"}) but ${active} client lease(s) are active; refusing to interrupt them`,
        )
      }
      if (input.checkOnly) {
        throw new Error(
          `shared server pid ${state.pid} at ${state.url} is not ready: ${probe.reason ?? "runtime mismatch"}; db=${paths.db}; state=${paths.stateFile}`,
        )
      }
      staleBackup = await archiveState(paths.stateFile)
      if (processAlive(state.pid)) await stopServer(state.pid, packageRoot)
    }

    const remaining = listMendCodeServeProcesses(packageRoot)
    if (remaining.length > 0) {
      throw new Error(
        `MendCode serve process(es) remain after stale cleanup (${remaining.map((item) => item.pid).join(", ")}); refusing to start a second server`,
      )
    }
    if (input.checkOnly) {
      throw new Error(
        `shared server is not ready: ${staleBackup ? `stale state archived at ${staleBackup}` : "no ready state"}`,
      )
    }

    const username = "mendcode"
    const password = `${randomUUID()}${randomUUID()}`
    const childEnv = runtimeEnvironment({ env, paths, runtimeID, username, password })
    const child = await spawnSourceServer(packageRoot, entrypoint, childEnv, input.spawnServer)
    try {
      const started = await waitForRuntime(
        paths.stateFile,
        project,
        version,
        child.pid,
        input.minSessions,
        input.minProviders,
      )
      const running = listMendCodeServeProcesses(packageRoot)
      if (running.length !== 1 || running[0]?.pid !== started.state.pid) {
        throw new Error(
          `readiness passed but server uniqueness failed; observed pids ${running.map((item) => item.pid).join(", ") || "none"}`,
        )
      }
      return {
        url: started.state.url,
        pid: started.state.pid,
        project,
        db: paths.db,
        paths,
        runtimeID,
        probe: started.probe,
      }
    } catch (error) {
      let cleanupError: string | undefined
      if (child.pid && processAlive(child.pid)) {
        try {
          await stopServer(child.pid, packageRoot)
        } catch (stopError) {
          cleanupError = stopError instanceof Error ? stopError.message : String(stopError)
        }
      }
      const failedState = await archiveState(paths.stateFile)
      const suffix = failedState ? `; failed state archived at ${failedState}` : ""
      const cleanupSuffix = cleanupError ? `; cleanup failed: ${cleanupError}` : ""
      throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}${cleanupSuffix}`)
    }
  } catch (error) {
    if (staleBackup && !(await exists(paths.stateFile))) {
      // Keep the backup as the recovery artifact. Do not restore it over a new state file.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}; previous state archived at ${staleBackup}`)
    }
    throw error
  } finally {
    await release()
  }
}

function printHelp() {
  console.log(`Usage: bun run script/dev-rearm.ts [options]

Rearm the source MendCode shared server without creating a competing process.

Options:
  --project <path>       Project directory to validate (default: cwd)
  --min-sessions <n>     Minimum /session rows required (default: 1)
  --min-providers <n>    Minimum /provider all rows required (default: 1)
  --check-only           Diagnose readiness without stopping or starting a server
  --tui                  Open the TUI only after every readiness gate passes
  --help                 Show this help

The command never edits SQLite. A stale shared-server JSON is renamed to a
timestamped .stale-*.json recovery artifact before the exact stale PID is stopped.`)
}

function parseArgs(argv: string[]) {
  const options = {
    project: process.cwd(),
    minSessions: 1,
    minProviders: 1,
    checkOnly: false,
    launchTui: false,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      printHelp()
      return
    }
    if (arg === "--check-only") {
      options.checkOnly = true
      continue
    }
    if (arg === "--tui") {
      options.launchTui = true
      continue
    }
    if (arg === "--project" || arg === "-p") {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a path`)
      options.project = value
      continue
    }
    if (arg === "--min-sessions" || arg === "--min-providers") {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} must be an integer >= 1`)
      if (arg === "--min-sessions") options.minSessions = value
      else options.minProviders = value
      continue
    }
    throw new Error(`unknown option ${arg}`)
  }
  return options
}

async function launchTui(result: DevRearmResult) {
  const env = { ...process.env }
  delete env.MENDCODE_SERVER_URL
  delete env.OPENCODE_SERVER_URL
  Object.assign(env, {
    HOME: result.paths.home,
    XDG_DATA_HOME: path.dirname(result.paths.data),
    XDG_STATE_HOME: path.dirname(result.paths.state),
    XDG_CONFIG_HOME: path.dirname(result.paths.config),
    XDG_CACHE_HOME: path.dirname(result.paths.cache),
    MENDCODE_GLOBAL_LAYOUT: result.paths.segment,
    OPENCODE_GLOBAL_LAYOUT: result.paths.segment,
    MENDCODE_DB: result.paths.db,
    OPENCODE_DB: result.paths.db,
    MENDCODE_CONFIG_DIR: result.paths.config,
    OPENCODE_CONFIG_DIR: result.paths.config,
    MENDCODE_SHARED_SERVER_STATE_FILE: result.paths.stateFile,
    MENDCODE_SHARED_SERVER_RUNTIME_ID: result.runtimeID,
  })
  const child = spawn(
    process.execPath,
    ["--cwd", PACKAGE_ROOT, "--no-install", "--conditions=browser", SOURCE_ENTRYPOINT, result.project],
    { cwd: result.project, env, stdio: "inherit" },
  )
  const code = await new Promise<number>((resolve) =>
    child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0))),
  )
  if (code !== 0) throw new Error(`TUI exited with code ${code}`)
}

export async function runDevRearm(options: DevRearmOptions) {
  return rearm(options)
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (!options) return 0
    const result = await rearm(options)
    console.log(`MendCode source runtime ready: ${result.url}`)
    console.log(`pid=${result.pid} version=${result.probe.health?.version} channel=${result.probe.health?.channel}`)
    console.log(`project=${result.project}`)
    console.log(`db=${result.db}`)
    console.log(`sessions=${result.probe.sessions?.length ?? 0} providers=${result.probe.providers?.all?.length ?? 0}`)
    if (options.launchTui) await launchTui(result)
    return 0
  } catch (error) {
    console.error(`MendCode dev rearm failed: ${error instanceof Error ? error.message : String(error)}`)
    console.error("No TUI was opened; inspect the stale-state backup and dev.log before retrying.")
    return 1
  }
}

if (import.meta.main) {
  main().then((code) => {
    process.exitCode = code
  })
}
