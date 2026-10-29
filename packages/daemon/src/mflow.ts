import { MflowActivation, MflowLeaseReply, MflowRelayHealth, MflowRoom } from "@mendcode/protocol"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { MflowChange, MflowLease, MflowLeaseResult, MflowRead, MflowReport } from "@mendcode/protocol"
import { isLoopbackHost } from "@mendcode/protocol/wire"
import { createMflowCoordinator, mflowKey } from "./mflow-coordinator"
import { PROGRAM_NAME } from "@mendcode/program"

export const MFLOW_NEVER_SYNC = [".git", ".mflow", ".env*", "node_modules", ".mendcode/runs", ".mendcode/cache"]
type Config = { enabled: boolean; room: string; relayMode: "local"; signaling: string; tokenFile?: string; hookPriority: number }
type Fetcher = (request: Request) => Promise<Response>

export function mflowRelayUrl(value: string) {
  const url = new URL(value.replace(/^ws:/, "http:").replace(/^wss:/, "https:"))
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname.replace(/^\[|\]$/g, "")) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Mflow relay must be an HTTP/WS literal loopback origin without credentials")
  return url.origin
}

/** Configuration lives in the selected daemon data dir; no scaffold or dependency is written to the project. */
export function createMflow(input: { dir: string; now?: () => number; fetch?: Fetcher; listener?: () => string | undefined }) {
  const now = input.now ?? Date.now
  const coordinator = createMflowCoordinator(input)
  const running = new Map<string, Config>()
  const fetcher = input.fetch ?? ((request: Request) => fetch(request))
  const root = (directory: string) => realpathSync(directory)
  const folder = (directory: string) => path.join(input.dir, "mflow", "projects", mflowKey(root(directory)))
  const statePath = (directory: string) => path.join(folder(directory), "state.json")
  function config(directory: string): Config {
    const file = statePath(directory)
    if (!existsSync(file)) return { enabled: false, room: `${path.basename(root(directory)) || "mendcode"}/mflow`, relayMode: "local", signaling: "embedded", hookPriority: 0 }
    return JSON.parse(readFileSync(file, "utf8")) as Config
  }
  function write(directory: string, value: Config) {
    mkdirSync(folder(directory), { recursive: true, mode: 0o700 })
    const file = statePath(directory), temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    renameSync(temporary, file)
  }
  function token(value: Config) {
    if (!value.tokenFile) throw new Error("Mflow relay requires a private token file")
    const stat = lstatSync(value.tokenFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Mflow token file must be a private regular file (0600)")
    const result = readFileSync(value.tokenFile, "utf8").trim()
    if (!result || /[\s\x00-\x1f\x7f]/.test(result)) throw new Error("Invalid Mflow token file")
    return result
  }
  async function remote(value: Config, endpoint: string, body?: unknown): Promise<unknown> {
    const url = mflowRelayUrl(value.signaling)
    const request = new Request(`${url}/mflow/${endpoint}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token(value)}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(1200) })
    try {
      const response = await fetcher(request)
      if (!response.ok) throw new Error("Relay unavailable or unauthorized")
      if (Number(response.headers.get("content-length") ?? 0) > 512_000) throw new Error("Relay response exceeds limit")
      const text = await response.text()
      if (text.length > 512_000) throw new Error("Relay response exceeds limit")
      return JSON.parse(text)
    } catch { throw new Error("Mflow relay unavailable or unauthorized") }
  }
  async function relayHealth(value: Config) {
    const result = MflowRelayHealth.safeParse(await remote(value, "health"))
    if (!result.success) throw new Error("Relay requires the v2 Mflow protocol")
    return result.data
  }
  const controlOwner = (directory: string) => `daemon:${path.resolve(input.dir)}:${root(directory)}`
  async function lease(directory: string, owner: string, request: MflowLease): Promise<MflowLeaseResult> {
    const value = running.get(root(directory))
    if (!value || !config(directory).enabled) throw new Error("Mflow is not running")
    return value.signaling === "embedded" ? coordinator.run(value.room, owner, request) : MflowLeaseReply.parse(await remote(value, "lease", { room: value.room, owner: mflowKey(owner), lease: request }))
  }
  function guide(directory: string) {
    return {
      recommendedUrl: "http://127.0.0.1:8787",
      commands: [
        `${PROGRAM_NAME} remote token create --dir RELAY_DATA --name mflow`,
        "bun packages/daemon/src/main.ts --dir RELAY_DATA --cwd PROJECT --engine faux --mflow-listen 127.0.0.1:8787",
        `${PROGRAM_NAME} control-plane mflow activate --room ${JSON.stringify(config(directory).room)} --url http://127.0.0.1:8787 --token-file PRIVATE_FILE`,
        `${PROGRAM_NAME} control-plane mflow start`,
      ],
      note: "v2 coordination protocol; external mflow-cli relays require an adapter. File sync is off.",
    }
  }
  async function query(directory: string, request: MflowRead): Promise<MflowReport> {
    const value = config(directory), active = running.has(root(directory)) && value.enabled
    const local = coordinator.snapshot(value.room)
    const report: MflowReport = {
      operation: request.operation, ok: true, mode: !value.enabled ? "disabled" : active ? "running" : "enabled-stopped",
      config: { enabled: value.enabled, room: value.room, relayMode: value.relayMode, signaling: value.signaling, hookPriority: value.hookPriority, tokenConfigured: Boolean(value.tokenFile) },
      daemon: { running: active, checked: value.enabled, output: !value.enabled ? "Mflow disabled" : active ? "Coordination running" : "Configured; start required" },
      peers: value.signaling === "embedded" ? local.peers : [], locks: value.signaling === "embedded" ? local.locks : [], failures: [], warnings: [], statePath: statePath(directory),
    }
    if (active && value.signaling !== "embedded") {
      try {
        const snapshot = MflowRoom.parse(await remote(value, `room?room=${encodeURIComponent(value.room)}`))
        report.peers = snapshot.peers
        report.locks = snapshot.locks
      } catch {
        report.ok = false
        report.mode = "enabled-stopped"
        report.daemon.running = false
        report.daemon.output = "Relay unavailable"
        report.failures.push("Mflow relay unavailable or unauthorized")
      }
    }
    if (request.operation === "scan") {
      report.relays = []
      const listener = input.listener?.()
      if (listener) report.relays.push({ url: listener, health: "healthy", ...coordinator.stats() })
      if (value.signaling !== "embedded" && value.tokenFile) {
        try {
          const health = await relayHealth(value)
          report.relays.push({ url: mflowRelayUrl(value.signaling), health: "healthy", roomCount: health.roomCount, peerCount: health.peerCount })
        } catch { report.warnings.push("Configured relay unavailable or unauthorized") }
      }
    }
    if (request.operation === "relay-guide") report.guide = guide(directory)
    if (request.operation === "legacy-status") report.legacy = { enabled: false, liveSync: false, integration: "v2-coordination; legacy file sync unavailable" }
    if (request.operation === "doctor") {
      if (value.signaling !== "embedded") {
        try { mflowRelayUrl(value.signaling); token(value) } catch { report.failures.push("Relay URL or private token file invalid") }
      }
      if (!existsSync(path.join(folder(directory), "plan.json"))) report.warnings.push("No local plan; run mflow plan")
      report.warnings.push("File sync and external mflow-cli compatibility are unavailable")
      report.ok = report.failures.length === 0
    }
    return report
  }
  function activation(directory: string, request: MflowActivation): Config {
    request = MflowActivation.parse(request)
    const current = config(directory)
    const signaling = request.signaling ?? current.signaling
    if (signaling !== "embedded") mflowRelayUrl(signaling)
    const value: Config = { enabled: true, room: request.room === undefined ? current.room : request.room.trim(), signaling, relayMode: "local", hookPriority: request.hookPriority ?? current.hookPriority, ...(request.tokenFile ? { tokenFile: path.resolve(request.tokenFile) } : current.tokenFile ? { tokenFile: current.tokenFile } : {}) }
    if (!value.room || value.room.length > 200 || /[\x00-\x1f\x7f]/.test(value.room)) throw new Error("Invalid Mflow room")
    if (signaling !== "embedded") token(value)
    return value
  }
  async function change(directory: string, request: MflowChange): Promise<MflowReport> {
    const key = root(directory)
    if (request.operation === "activate" || request.operation === "setup") {
      const value = activation(directory, request.input)
      if (running.has(key)) throw new Error("Stop Mflow before changing its room or relay")
      write(directory, value)
    } else if (request.operation === "start") {
      const value = config(directory)
      if (!value.enabled) throw new Error("Configure and activate Mflow before starting")
      if (value.signaling !== "embedded") await relayHealth(value)
      running.set(key, value)
      try { await lease(directory, controlOwner(directory), { action: "join", ttlMs: 120_000 }) }
      catch (error) { running.delete(key); throw error }
    } else if (request.operation === "plan") {
      const plan: NonNullable<MflowReport["plan"]> = { dryRun: true, startsDaemon: false, syncsFiles: false, neverSync: MFLOW_NEVER_SYNC, commands: [`${PROGRAM_NAME} control-plane mflow activate`, `${PROGRAM_NAME} control-plane mflow start`] }
      mkdirSync(folder(directory), { recursive: true, mode: 0o700 })
      const planPath = path.join(folder(directory), "plan.json")
      writeFileSync(planPath, JSON.stringify({ ...plan, generatedAt: now() }), { mode: 0o600 })
      return { ...await query(directory, { operation: "status" }), operation: "plan", plan, planPath }
    } else {
      if (running.has(key)) {
        try { await lease(directory, controlOwner(directory), { action: "leave" }) } catch {}
        running.delete(key)
      }
      if (request.operation === "deactivate") write(directory, { ...config(directory), enabled: false })
      if (request.operation === "remove" && existsSync(folder(directory))) {
        const trash = path.join(input.dir, "trash")
        mkdirSync(trash, { recursive: true, mode: 0o700 })
        renameSync(folder(directory), path.join(trash, `mflow-${mflowKey(key)}-${now()}`))
      }
    }
    return { ...await query(directory, { operation: "status" }), operation: request.operation }
  }
  const heartbeat = setInterval(() => {
    for (const [directory] of running) void lease(directory, controlOwner(directory), { action: "join", ttlMs: 120_000 }).catch(() => {})
  }, 30_000)
  heartbeat.unref()
  function stop() { clearInterval(heartbeat); running.clear() }
  return { query, change, lease, coordinator, config, running, controlOwner, stop }
}
export type MflowService = ReturnType<typeof createMflow>
