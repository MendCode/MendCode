import { readFileSync } from "node:fs"
import { AGENT_LIMIT_CAPABILITY, AGENT_ORIGIN_CAPABILITY, agentCommandClass, agentRefusal, capPermission, permissionRank, type Command, type PermissionMode, type SessionId } from "@mendcode/protocol"
import { agentProcesses } from "@mendcode/tools"

/**
 * Who is on the other end of a local connection (docs/permissions.md). The daemon does not take the client's word: it reads
 * the peer's process id from the socket and looks for it among the processes sessions started. A client is agent-origin when
 * it descends from one of them, belongs to the terminal session one of them led (also after that leader ended), carries the
 * file-size mark below this daemon's own limit, or says so itself. A terminal the user opened through the daemon is theirs.
 *
 * Limits, stated plainly: this identifies clients that come from a session's shell. Code running as the same OS user can
 * still edit the data directory, or hand the command to another service (cron, launchd, a terminal multiplexer); on macOS a
 * hand-written client that both leaves its terminal session and reparents itself is not recognised (Linux reads its limit).
 */
export type AgentOrigin = { via: "process" | "terminal-session" | "descendant" | "limit" | "declared"; sessionId?: string | undefined; pid?: number | undefined }

const ORIGIN_CAPABILITY = AGENT_ORIGIN_CAPABILITY
const LIMIT_CAPABILITY = AGENT_LIMIT_CAPABILITY

type Native = { peerPid(fd: number): number | undefined; sessionOf(pid: number): number | undefined; parentOf(pid: number): number | undefined }

function loadNative(platform: string): Native | undefined {
  if (platform !== "darwin" && platform !== "linux") return undefined
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
    const symbols = {
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      getsid: { args: [FFIType.i32], returns: FFIType.i32 },
      ...(platform === "darwin" ? { proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } } : {}),
    } as const
    let library: { symbols: Record<string, (...args: never[]) => unknown> } | undefined
    for (const name of platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", `libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`]) {
      try { library = dlopen(name, symbols) as never; break } catch {}
    }
    if (!library) return undefined
    const call = library.symbols as unknown as { getsockopt(fd: number, level: number, name: number, value: unknown, length: unknown): number; getsid(pid: number): number; proc_pidinfo?(pid: number, flavor: number, arg: bigint, buffer: unknown, size: number): number }
    return {
      peerPid(fd) {
        // macOS: SOL_LOCAL / LOCAL_PEERPID answers a pid. Linux: SOL_SOCKET / SO_PEERCRED answers { pid, uid, gid }.
        const value = new Int32Array(3)
        const length = new Uint32Array([platform === "darwin" ? 4 : 12])
        const status = platform === "darwin" ? call.getsockopt(fd, 0, 2, ptr(value), ptr(length)) : call.getsockopt(fd, 1, 17, ptr(value), ptr(length))
        return status === 0 && value[0]! > 1 ? value[0]! : undefined
      },
      sessionOf(pid) {
        const session = call.getsid(pid)
        return session > 1 ? session : undefined
      },
      parentOf(pid) {
        if (platform === "linux") {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
            const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
            return parent > 1 ? parent : undefined
          } catch { return undefined }
        }
        // PROC_PIDTBSDINFO: struct proc_bsdinfo (136 bytes); pbi_ppid is its fifth 32-bit field.
        const info = new Uint32Array(34)
        const parent = call.proc_pidinfo!(pid, 3, 0n, ptr(info), 136) === 136 ? info[4]! : 0
        return parent > 1 ? parent : undefined
      },
    }
  } catch { return undefined }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/** This process's hard file-size limit in bytes; Infinity when there is none or it cannot be read. */
export function ownFileLimit(): number {
  try {
    const hard = (process.report?.getReport() as { userLimits?: { file_size_blocks?: { hard?: unknown } } } | undefined)?.userLimits?.file_size_blocks?.hard
    return typeof hard === "number" && Number.isFinite(hard) ? hard : Infinity
  } catch { return Infinity }
}

function procFileLimit(pid: number | "self"): number | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/limits`, "utf8").split("\n").find((entry) => entry.startsWith("Max file size"))
    const hard = line?.trim().split(/\s{2,}/)[2]
    return hard === undefined ? undefined : hard === "unlimited" ? Infinity : Number(hard)
  } catch { return undefined }
}

export function createPeerOrigin(options: { pid?: number; platform?: string; descendants?: boolean; native?: Native | undefined } = {}) {
  const daemonPid = options.pid ?? process.pid
  const platform = options.platform ?? process.platform
  let native: Native | undefined | null = "native" in options ? options.native ?? null : undefined
  const load = () => (native === undefined ? (native = loadNative(platform) ?? null) : native) ?? undefined
  let ownLimit: number | undefined
  return {
    /** Whether a peer's process can be read here at all; without it only the client's own declaration is left. */
    available: () => load() !== undefined,
    /** The origin of the client on socket `fd`: an agent-origin, or undefined for the user (and for a peer that cannot be read). */
    resolve(fd: number | undefined): AgentOrigin | undefined {
      const os = typeof fd === "number" && fd >= 0 ? load() : undefined
      const pid = os?.peerPid(fd!)
      if (!os || !pid || pid === daemonPid) return undefined
      // Nearest first: a terminal the user opened inside a session's process tree is still the user's, and the other way round.
      for (let cursor: number | undefined = pid, depth = 0; cursor && depth < 64; cursor = os.parentOf(cursor), depth++) {
        if (cursor === daemonPid) return options.descendants ? { via: "descendant", pid } : undefined
        if (agentProcesses.findUser(cursor, alive)) return undefined
        const started = agentProcesses.findAgent(cursor, alive)
        if (started) return { via: "process", sessionId: started.sessionId, pid }
      }
      // Reparented (its parent ended, or it forked away): the terminal session it still belongs to names who started it.
      const session = os.sessionOf(pid)
      if (session) {
        if (agentProcesses.findUser(session, alive)) return undefined
        const leader = agentProcesses.findAgent(session, alive)
        if (leader) return { via: "terminal-session", sessionId: leader.sessionId, pid }
      }
      if (platform === "linux") {
        const peer = procFileLimit(pid)
        ownLimit ??= procFileLimit("self") ?? Infinity
        if (peer !== undefined && peer < ownLimit) return { via: "limit", pid }
      }
      return undefined
    },
    /** What the client says about itself in `hello`. It can only add the restriction, never lift it. */
    declared(capabilities: readonly string[]): AgentOrigin | undefined {
      if (capabilities.includes(ORIGIN_CAPABILITY)) return { via: "declared" }
      const limit = Number(capabilities.find((entry) => entry.startsWith(LIMIT_CAPABILITY))?.slice(LIMIT_CAPABILITY.length))
      return Number.isFinite(limit) && limit > 0 && limit < ownFileLimit() ? { via: "limit" } : undefined
    },
  }
}

const MAX_CREATED = 2000

/**
 * What an agent-origin client may do. `open` commands pass, `owner` commands never do, and session work is held to the
 * calling session's own permission mode: it cannot approve a request, raise a mode above its own, drive a session that has
 * more authority than it has, or delete, archive or rename a session it did not start. A caller whose session is unknown
 * counts as `ask`.
 */
export function createAgentGate(input: { modeOf(sessionId: SessionId): PermissionMode | undefined }) {
  /** Sessions started by agent-origin clients, with the session that started each ("" when unknown). In memory: after a restart only the mode comparison is left. */
  const created = new Map<string, string>()
  const ceiling = (origin: AgentOrigin): PermissionMode => (origin.sessionId ? input.modeOf(origin.sessionId as SessionId) : undefined) ?? "ask"
  const mine = (origin: AgentOrigin, target: string) => target === origin.sessionId || created.get(target) === (origin.sessionId ?? "")
  const within = (origin: AgentOrigin, target: string) => mine(origin, target) || permissionRank(input.modeOf(target as SessionId) ?? "full") <= permissionRank(ceiling(origin))
  const refuse = (what: string) => `[DAEMON]: ${agentRefusal({ what })}`
  return {
    ceiling,
    /** The mode a session this client starts gets: the usual one, never above the caller's own. */
    cap: (origin: AgentOrigin, mode: PermissionMode): PermissionMode => capPermission(mode, ceiling(origin)),
    started(origin: AgentOrigin, sessionId: string) {
      created.set(sessionId, origin.sessionId ?? "")
      if (created.size > MAX_CREATED) created.delete(created.keys().next().value!)
    },
    /** Why `command` is refused to this client; undefined when it may run. */
    check(origin: AgentOrigin, command: Command): string | undefined {
      const kind = agentCommandClass(command.type)
      if (kind === "open") return undefined
      if (kind === "owner") return refuse(`${command.type} changes what only the user decides (permissions, settings, credentials, extensions, scheduled work, other sessions or the daemon)`)
      if (command.type === "session.create") return undefined
      const target = "sessionId" in command && typeof command.sessionId === "string" ? command.sessionId : undefined
      if (!target) return refuse(`${command.type} without a session`)
      const level = ceiling(origin)
      if (command.type === "request.resolve" && command.decision.kind !== "deny") return refuse(`${command.type} (${command.decision.kind}): a session cannot answer an approval, a question or a plan review on the user's behalf`)
      if (command.type === "session.permission.set" && permissionRank(command.mode) > permissionRank(level)) return refuse(`session.permission.set ${command.mode}: above the calling session's own mode (${level})`)
      if (command.type === "session.delete" || command.type === "session.archive" || command.type === "session.rename") return mine(origin, target) ? undefined : refuse(`${command.type} on a session the caller did not start`)
      return within(origin, target) ? undefined : refuse(`${command.type} on a session with more authority than the caller's own mode (${level})`)
    },
  }
}
