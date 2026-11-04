import { spawn } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { dataDirFromEnv, defaultDataDirNow, mendEnv, sameDir } from "@mendcode/program/data-dir"
import { inspectLockOwner, type OwnerProbe } from "@mendcode/program/daemon-identity"
import { defaultLocalTransport, localEndpointPath, readLocalEndpoint } from "@mendcode/client/local-endpoint"
import { droppedEnvArgs, hostSessionEnvNames, withoutHostSessionEnv } from "@mendcode/client/inherited-env"

/** Same default as the daemon: ~/.mendcode, or ~/.mendcode-v2 while its move could not happen yet (data-dir-move.ts). */
export const DEFAULT_DIR = defaultDataDirNow()
/** The data directory of this run: `--dir`, else `MENDCODE_DIR` (or `MENDCODE_V2_DIR`), else the default. */
export const envDataDir = (env: Readonly<Record<string, string | undefined>> = process.env) => dataDirFromEnv(env) ?? DEFAULT_DIR
const DAEMON_MAIN = path.join(import.meta.dir, "../../../packages/daemon/src/main.ts")

/** Bun 1.3's virtual filesystem paths (including the Windows spelling). */
export function daemonCommand(main = Bun.main, executable = process.execPath): string[] {
  return /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main)
    ? [executable, "__daemon"]
    : ["bun", DAEMON_MAIN]
}

async function canConnect(socketPath: string) {
  if (!existsSync(socketPath)) return false
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

/** A daemon on the loopback TCP transport: its published port accepts a connection (the client then proves the secret). */
async function canConnectTcp(dir: string) {
  const endpoint = readLocalEndpoint(dir)
  if (!endpoint) return false
  // A crashed daemon leaves its file behind; a recycled port must not be mistaken for it.
  try { process.kill(endpoint.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false }
  try {
    const socket = await Bun.connect({ hostname: endpoint.hostname, port: endpoint.port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

/** The running daemon's transport, whichever it was started with; `socketPath` is the file that disappears when it stops. */
export async function liveDaemon(dir: string): Promise<{ socketPath: string; tcp: boolean; dir: string } | undefined> {
  if (await canConnectTcp(dir)) return { socketPath: localEndpointPath(dir), tcp: true, dir }
  const socketPath = path.join(dir, "mendd.sock")
  if (await canConnect(socketPath)) return { socketPath, tcp: false, dir }
  return undefined
}

/**
 * Environments to try, in order, for a new daemon. The JIT stays on by default: the daemon runs the
 * agent loop, diffs, projections and compaction, and pure-JS work is up to ~7.6x slower without it
 * (measured), which matters more than the ≈9 MB of RSS it costs (P-rule: low latency first). Opt in
 * with `MENDCODE_JIT=0` on a memory-constrained machine; an explicit `BUN_JSC_useJIT` is respected
 * as-is. JSC options are not a stable Bun API, so the low-memory environment always falls back to a
 * plain one if the daemon dies at once (e.g. Bun rejecting the option after an upgrade).
 */
export function daemonEnvs(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv[] {
  const jit = mendEnv(base, "JIT")
  if (jit === "1" || base.BUN_JSC_useJIT !== undefined || base.BUN_JSC_useFTLJIT !== undefined) return [base]
  if (jit === "0") return [{ ...base, BUN_JSC_useJIT: "0" }, base]
  return [{ ...base, ...LEAN_JIT.daemon }, base]
}

/**
 * JIT tiers left off by default (docs/performance.md, "JIT tiers"). The daemon drops only the top tier (FTL): indexing a
 * 2,873-file project peaks about 40 MB lower and takes 7% longer. A terminal drops the DFG tier too: after scrolling 10,000
 * messages and streaming an answer it holds 111 MB instead of 155, with stream frames still under 8 ms p95. A terminal that
 * hosts the daemon does as well (6 MB less at the prompt and after a turn, the same turn CPU): the one hot loop of the daemon
 * that needs DFG, scanning a project for its code graph, runs in a process of its own with every tier (codegraph scan-host.ts).
 * It also compiles a function to machine code only after 16 times the usual warm-up (`thresholdForJIT*`): the code that runs
 * every frame still gets there within the first frames, the code that runs a few times per command stays interpreted, and the
 * terminal keeps about 10 MB less after use with the same frame times (docs/performance.md).
 * `MENDCODE_JIT=1` keeps every tier; `MENDCODE_JIT=0` turns the JIT off (`MENDCODE_V2_JIT` is still read).
 */
export const LEAN_JIT = {
  daemon: { BUN_JSC_useFTLJIT: "0", BUN_JSC_thresholdForJITAfterWarmUp: "8000", BUN_JSC_thresholdForJITSoon: "2000", MENDCODE_V2_LEAN_JIT: "1" },
  client: { BUN_JSC_useDFGJIT: "0", BUN_JSC_useFTLJIT: "0", BUN_JSC_thresholdForJITAfterWarmUp: "8000", BUN_JSC_thresholdForJITSoon: "2000", MENDCODE_V2_LEAN_JIT: "1" },
} as const

/**
 * JSC reads its options once, at start: a process started lean drops them from its environment right away, so what it starts in
 * turn (a daemon, the user's commands in an agent shell, an editor) gets the environment the user had.
 */
export function forgetLeanJit(env: NodeJS.ProcessEnv = process.env) {
  if (env.MENDCODE_V2_LEAN_JIT !== "1") return
  for (const key of ["BUN_JSC_useDFGJIT", "BUN_JSC_useFTLJIT", "BUN_JSC_thresholdForJITAfterWarmUp", "BUN_JSC_thresholdForJITSoon", "MENDCODE_V2_LEAN_JIT"]) delete env[key]
}

/** The environment a terminal restarts itself under to run with fewer JIT tiers; undefined when it already does or should not. */
export function leanClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  if (mendEnv(env, "JIT") === "1" || env.MENDCODE_V2_LEAN_JIT || env.BUN_JSC_useJIT !== undefined || env.BUN_JSC_useDFGJIT !== undefined || env.BUN_JSC_useFTLJIT !== undefined) return undefined
  return { ...env, ...LEAN_JIT.client }
}

/**
 * Returns the socket of a running daemon, starting one (detached) if none is listening.
 * Two clients racing here are safe: the store's writer lock lets only one daemon survive,
 * and the loser's client simply connects to the winner.
 */
export async function ensureDaemon(options: { dir?: string; timeoutMs?: number; engine?: string; cwd?: string; logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR"; printLogs?: boolean; pure?: boolean; safeMode?: boolean; trace?: boolean; /** Solo mode (solo.ts): when nothing is running and no installed service owns startup, this process hosts the daemon. */ solo?: boolean } = {}): Promise<{ socketPath: string; tcp: boolean; dir: string; started: boolean; host?: import("./solo").SoloHost }> {
  const dir = options.dir ?? envDataDir()
  const found = await liveDaemon(dir)
  if (found) return { ...found, started: false }
  // An installed user service owns startup; a terminal must not race it with a detached competitor.
  if (process.platform === "darwin" || process.platform === "linux") {
    const { createUserService } = await import("../../../packages/daemon/src/user-service")
    const command = daemonCommand()
    if (command[0] === "bun") command[0] = process.execPath
    const service = createUserService({ dir, cwd: options.cwd ?? process.cwd(), command })
    const status = await service.status()
    if (status.installed && sameDir(status.dataDir, dir)) {
      await service.control("start")
      const deadline = Date.now() + (options.timeoutMs ?? 5_000)
      while (Date.now() < deadline) {
        const up = await liveDaemon(dir)
        if (up) return { ...up, started: true }
        await Bun.sleep(20)
      }
      throw new Error(`[CLI]: user service did not start within ${options.timeoutMs ?? 5_000} ms; inspect daemon service logs`)
    }
  }
  if (options.solo && !options.printLogs) {
    const { hostDaemon } = await import("./solo")
    const hosted = await hostDaemon({ dir, cwd: options.cwd ?? process.cwd(), localTransport: defaultLocalTransport(), ...(options.engine ? { engine: options.engine } : {}), ...(options.logLevel ? { logLevel: options.logLevel } : {}), pure: options.pure, safeMode: options.safeMode, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), live: () => liveDaemon(dir) })
    if ("host" in hosted) return { socketPath: defaultLocalTransport() === "tcp" ? localEndpointPath(dir) : path.join(dir, "mendd.sock"), tcp: defaultLocalTransport() === "tcp", dir, started: true, host: hosted.host }
    const up = await ownerListening(dir, Date.now() + (options.timeoutMs ?? 5_000))
    if (up) return { ...up, started: false }
  }
  const engineArgs = ["--cwd", options.cwd ?? process.cwd(), "--local-transport", defaultLocalTransport(), ...(options.engine ? ["--engine", options.engine] : []), ...(options.logLevel ? ["--log-level", options.logLevel] : []), ...(options.pure || options.safeMode ? ["--pure"] : []), ...(options.safeMode ? ["--safe-mode"] : [])]
  // detached = setsid(): the daemon gets its own session and no controlling terminal, so it survives
  // closing this terminal (no SIGHUP) and its children (e.g. codex app-server) can never compete with
  // the client's raw-mode TTY or be stopped by terminal job control.
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  // A Claude Code shell's session variables stay with this command: the daemon and everything its sessions start never see them.
  const dropped = droppedEnvArgs(hostSessionEnvNames(process.env))
  for (const env of daemonEnvs({ ...withoutHostSessionEnv(process.env), ...(options.trace === undefined ? {} : { MENDCODE_TRACE: options.trace ? "1" : "0" }) })) {
    const [executable, ...args] = daemonCommand()
    const child = spawn(executable!, [...args, "--dir", dir, ...engineArgs, ...dropped], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", options.printLogs ? "inherit" : "ignore"], env })
    child.unref()
    // A daemon that dies at once (Bun rejecting the JSC option after an upgrade) is retried with the next environment.
    while (Date.now() < deadline && child.exitCode === null) {
      const up = await liveDaemon(dir)
      if (up) return { ...up, started: true }
      await Bun.sleep(20)
    }
    if (child.exitCode === null) break
    // It lost the data directory to another daemon (a terminal handing its daemon off, a second terminal opened at the same
    // instant) that holds the lock but does not listen yet: that one is the daemon to attach to.
    const owner = await ownerListening(dir, deadline)
    if (owner) return { ...owner, started: false }
  }
  throw new Error(`[CLI]: daemon did not start within ${options.timeoutMs ?? 5_000} ms (dir ${dir})`)
}

type Shutdownable = {
  daemonBuildId: string | undefined
  send(command: { type: "daemon.status" } | { type: "daemon.shutdown"; force?: boolean }): Promise<{ ok: boolean; result?: Record<string, unknown> | undefined; error?: { code: string } }>
}

/** Work a restart would cut short: turns, background jobs, running loops, or someone else attached (this client is one). */
export function daemonInUse(status: Record<string, unknown> | undefined) {
  if (!status) return false
  const loops = status.loops as { running?: number } | undefined
  return Number(status.activeTurns ?? 0) > 0 || Number(status.backgroundJobs ?? 0) > 0 || Number(loops?.running ?? 0) > 0 || Number(status.clients ?? 1) > 1
}

/**
 * Version skew: a daemon started by an older build keeps running after an update. If it is idle (no turns, jobs
 * or running loops, and no other client attached) it is asked to stop and the caller relaunches; otherwise it is
 * left alone and "busy" is returned. Daemons from before the handshake carried a build id cannot be stopped over
 * the protocol; one that predates `clients` in its status is judged by its work alone.
 */
export async function stopIfStale(client: Shutdownable, expectedBuildId: string): Promise<"fresh" | "stopped" | "busy" | "legacy"> {
  if (client.daemonBuildId === expectedBuildId) return "fresh"
  if (!client.daemonBuildId || client.daemonBuildId === "unknown") return "legacy"
  const status = await client.send({ type: "daemon.status" })
  if (status.ok && daemonInUse(status.result)) return "busy"
  const reply = await client.send({ type: "daemon.shutdown" })
  if (reply.ok) return "stopped"
  return reply.error?.code === "busy" ? "busy" : "legacy"
}

/**
 * A pid read from the lock file can be signalled only when it is a whole number above 1 that is neither this process nor its parent:
 * an empty or damaged file reads as 0 (our whole process group) or NaN, 1 is init, and the parent is the shell or terminal that started us.
 */
export function isDaemonPid(pid: number, { self = process.pid, parent = process.ppid }: { self?: number; parent?: number } = {}) {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== self && pid !== parent
}

/**
 * Asks the daemon that answers on `dir`'s socket or endpoint to stop (`daemon.shutdown`, forced: running turns end as interrupted
 * and resume later). It needs no pid, so it works wherever there is no process table. False when nobody answers, the answer is
 * another directory's daemon, or it refuses.
 */
async function shutdownOverProtocol(dir: string) {
  const up = await liveDaemon(dir)
  if (!up) return false
  const { createClient } = await import("@mendcode/client")
  const client = createClient({ ...(up.tcp ? { localTcp: () => readLocalEndpoint(dir) } : { socketPath: up.socketPath }), name: "daemon-restart", reconnect: false, timeoutMs: 2000 })
  try {
    await client.connect()
    const status = await client.send({ type: "daemon.status" })
    if (!status.ok || !sameDir(String((status.result as { dataDir?: string } | undefined)?.dataDir ?? ""), dir)) return false
    const reply = await client.send({ type: "daemon.shutdown", force: true })
    if (!reply.ok) return false
  } catch {
    return false
  } finally {
    client.close()
  }
  await waitForSocketGone(up.socketPath)
  const lock = path.join(dir, "mendd.lock")
  for (let i = 0; i < 100 && existsSync(lock); i++) await Bun.sleep(20)
  return true
}

/**
 * `--restart-daemon`: the daemon that answers for `dir` is asked to stop over the protocol. When nobody answers, the lock owner gets
 * SIGTERM (same graceful stop), but only a process that is a MendCode daemon serving `dir` (daemon-identity.ts); where the
 * process table gives no command line (Windows) nothing is signalled and `report` says so. A lock that names anything else is stale:
 * nothing is signalled, `report` says what was found, and a lock whose process no longer exists is removed. True when a daemon was stopped.
 */
export async function terminateDaemon(dir = envDataDir(), { report = () => {}, probe }: { report?(message: string): void; probe?: OwnerProbe } = {}) {
  if (await shutdownOverProtocol(dir)) return true
  const owner = inspectLockOwner({ dir, ...(probe ? { probe } : {}) })
  if (owner.state === "none") {
    if (owner.detail !== "no lock file") report(`mendd.lock in ${dir}: ${owner.detail}; nothing signalled`)
    return false
  }
  if (owner.state === "gone") {
    const lock = path.join(dir, "mendd.lock")
    try { if (Number(readFileSync(lock, "utf8")) === owner.pid) rmSync(lock, { force: true }) } catch { /* another process replaced or removed it */ }
    report(`stale mendd.lock in ${dir}: ${owner.detail}; the lock was removed, nothing signalled`)
    return false
  }
  if (owner.state === "foreign") {
    report(`mendd.lock in ${dir} is stale or foreign: ${owner.detail}; nothing signalled`)
    return false
  }
  try {
    process.kill(owner.pid, "SIGTERM")
  } catch {
    return false
  }
  const lock = path.join(dir, "mendd.lock")
  for (let i = 0; i < 100 && existsSync(lock); i++) await Bun.sleep(20)
  return true
}

/**
 * The daemon that owns `dir` (its pid in mendd.lock, alive) once it listens; undefined when nothing owns it, the owner exits
 * first, or `deadline` passes. A daemon takes the lock before it opens its socket, so a client that comes in between waits here.
 */
export async function ownerListening(dir: string, deadline: number) {
  for (;;) {
    const up = await liveDaemon(dir)
    if (up) return up
    // Only a daemon of this directory (or a MendCode terminal that hosts one) is waited for: a stale lock whose pid was reused ends the wait.
    const owner = inspectLockOwner({ dir })
    const waitable = owner.state === "daemon" || (owner.state === "foreign" && owner.mendcode === true)
    if (!waitable || Date.now() > deadline) return undefined
    await Bun.sleep(20)
  }
}

export async function waitForSocketGone(socketPath: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && existsSync(socketPath)) await Bun.sleep(20)
}

/** `mendcode dev` (dev-mode.ts): the checkout's own CLI, on this terminal, resolved with its exit code. */
export async function runInherited({ command, env, cwd }: { command: string[]; env: Record<string, string>; cwd: string }): Promise<number> {
  const [executable, ...args] = command
  const child = spawn(executable!, args, { cwd, env, stdio: "inherit", windowsHide: true })
  return await new Promise<number>((resolve) => { child.on("error", () => resolve(1)); child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1))) })
}
