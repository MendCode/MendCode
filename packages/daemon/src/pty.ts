import { createHash, randomBytes } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import path from "node:path"
import { PtyCreateInput, type PtyInfo, type PtyUpdateInput } from "@mendcode/protocol"
import { agentProcesses } from "@mendcode/tools"
import { nativePtyDriver, type PtyDriver, type PtyProcess } from "./pty-native"
import type { HttpPeer } from "./http"

export type PtyScope = { directory: string; peer?: HttpPeer | undefined }
export type PtySocket = { send(data: string | Uint8Array): number | void; close(code?: number, reason?: string): void }
export type PtyConnection = { message(data: string): void; close(): void }
type Active = { info: PtyInfo; scope: PtyScope; process?: PtyProcess; buffer: string; cursor: number; sockets: Set<PtySocket> }
type Ticket = { id: string; scope: PtyScope; expires: number }
const LIMIT = 2 * 1024 * 1024
const owner = (scope: PtyScope) => scope.peer?.hash ?? "local"
const digest = (ticket: string) => createHash("sha256").update(ticket).digest("hex")

export class PtyError extends Error {
  constructor(readonly code: "forbidden" | "unknown_session" | "invalid_command" | "busy", message: string) { super(message) }
}

export function createPtyService(input: { enabled: boolean; driver?: PtyDriver; now?: () => number; active?(peer: HttpPeer): boolean }) {
  const driver = input.driver ?? nativePtyDriver()
  const now = input.now ?? Date.now
  const sessions = new Map<string, Active>()
  const tickets = new Map<string, Ticket>()
  const creating = new Map<string, Set<{ cancelled: boolean }>>()
  function enabled(scope: PtyScope) {
    if (scope.peer?.readOnly) throw new PtyError("forbidden", "Full token required")
    if (!input.enabled) throw new PtyError("invalid_command", "PTY disabled")
    if (scope.peer && input.active && !input.active(scope.peer)) throw new PtyError("forbidden", "Token revoked")
  }
  function get(scope: PtyScope, id: string) {
    enabled(scope)
    const session = sessions.get(id)
    if (!session || session.scope.directory !== scope.directory || owner(session.scope) !== owner(scope)) throw new PtyError("unknown_session", "PTY not found")
    return session
  }
  const info = (session: Active): PtyInfo => ({ ...session.info, args: [...session.info.args] })
  function drop(id: string) {
    const session = sessions.get(id)
    if (!session) return
    sessions.delete(id)
    for (const [key, ticket] of tickets) if (ticket.id === id) tickets.delete(key)
    for (const socket of session.sockets) try { socket.close(1000, "PTY closed") } catch {}
    session.sockets.clear()
    try { session.process?.kill() } catch {}
  }
  function send(session: Active, socket: PtySocket, data: string | Uint8Array) {
    try {
      if ((socket.send(data) ?? 1) > 0) return true
    } catch {}
    session.sockets.delete(socket)
    try { socket.close(1013, "Slow client") } catch {}
    return false
  }
  function sweep() {
    const owners = new Map<string, boolean>()
    const active = (scope: PtyScope) => {
      if (!scope.peer || !input.active) return true
      if (!owners.has(owner(scope))) owners.set(owner(scope), input.active(scope.peer))
      return owners.get(owner(scope))!
    }
    for (const [key, ticket] of tickets) if (ticket.expires <= now() || !active(ticket.scope)) tickets.delete(key)
    for (const [id, session] of sessions) if (!active(session.scope)) drop(id)
  }
  function resolveCwd(scope: PtyScope, value: PtyCreateInput) {
    try {
      const cwd = realpathSync(value.cwd ? path.resolve(scope.directory, value.cwd) : scope.directory)
      const relative = path.relative(scope.directory, cwd)
      if (!statSync(cwd).isDirectory() || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error()
      return cwd
    } catch { throw new PtyError("invalid_command", "PTY cwd outside selected project") }
  }
  const service = {
    shells(scope: PtyScope) { enabled(scope); return driver.shells() },
    list(scope: PtyScope) { enabled(scope); return [...sessions.values()].filter((session) => session.scope.directory === scope.directory && owner(session.scope) === owner(scope)).map(info) },
    get(scope: PtyScope, id: string) { return info(get(scope, id)) },
    create(scope: PtyScope, value: PtyCreateInput, id = `pty_${randomBytes(16).toString("hex")}`): PtyInfo {
      enabled(scope)
      sweep()
      if (sessions.size >= 64) throw new PtyError("busy", "PTY session limit")
      const cwd = resolveCwd(scope, value)
      const shells = driver.shells()
      const preferred = shells.find((shell) => shell.path === process.env.SHELL)
      const command = value.command || driver.preferred?.() || preferred?.path || shells.find((shell) => shell.acceptable)?.path || "/bin/sh"
      const args = [...(value.args ?? [])]
      if (["bash", "dash", "fish", "ksh", "sh", "zsh"].includes(path.basename(command)) && !args.includes("-l") && !args.includes("--login")) args.push("-l")
      const session: Active = { info: { id, title: value.title || `Terminal ${id.slice(-4)}`, command, args, cwd, status: "running", pid: 1 }, scope, buffer: "", cursor: 0, sockets: new Set() }
      sessions.set(id, session)
      let owned: ReturnType<typeof agentProcesses.user> | undefined
      try {
        session.process = driver.spawn({ command, args, cwd, env: { ...process.env, ...value.env, TERM: "xterm-256color", MENDCODE_TERMINAL: "1", OPENCODE_TERMINAL: "1" }, data(text) {
          if (!sessions.has(id)) return
          session.cursor += text.length
          session.buffer = (session.buffer + text).slice(-LIMIT)
          for (const socket of session.sockets) send(session, socket, text)
        }, exit() { owned?.exited(); session.info.status = "exited"; drop(id) } })
        session.info.pid = session.process.pid
        // A terminal the user opened is the user's: what they type there is not a session raising its own authority.
        owned = agentProcesses.user(session.process.pid)
        if (!sessions.has(id)) session.process.kill()
        return info(session)
      } catch { drop(id); throw new PtyError("invalid_command", "PTY runtime unavailable or spawn failed") }
    },
    async createWithEnvironment(scope: PtyScope, value: PtyCreateInput, environment: (ref: { id: string; cwd: string }) => Promise<Record<string, string> | undefined>, signal?: AbortSignal): Promise<PtyInfo> {
      enabled(scope)
      if (signal?.aborted) throw new PtyError("busy", "PTY creation interrupted")
      if (sessions.size + [...creating.values()].reduce((total, pending) => total + pending.size, 0) >= 64) throw new PtyError("busy", "PTY session limit")
      const cwd = resolveCwd(scope, value), id = `pty_${randomBytes(16).toString("hex")}`, request = { cancelled: false }
      const pending = creating.get(scope.directory) ?? new Set()
      creating.set(scope.directory, pending)
      pending.add(request)
      try {
        const env = await environment({ id, cwd })
        if (signal?.aborted || request.cancelled) throw new PtyError("busy", "PTY creation interrupted")
        const prepared = PtyCreateInput.parse({ ...value, cwd, env: { ...value.env, ...env } })
        return service.create(scope, prepared, id)
      } finally {
        pending.delete(request)
        if (!pending.size) creating.delete(scope.directory)
      }
    },
    update(scope: PtyScope, id: string, value: PtyUpdateInput) {
      const session = get(scope, id)
      if (value.size) session.process!.resize(value.size.cols, value.size.rows)
      if (value.title) session.info.title = value.title
      return info(session)
    },
    remove(scope: PtyScope, id: string) { get(scope, id); drop(id); return true },
    ticket(scope: PtyScope, id: string) {
      get(scope, id)
      if (!scope.peer) throw new PtyError("forbidden", "PTY tickets require a remote token")
      sweep()
      if (tickets.size >= 1024) throw new PtyError("busy", "PTY ticket limit")
      const ticket = randomBytes(32).toString("base64url")
      tickets.set(digest(ticket), { id, scope, expires: now() + 60_000 })
      return { ticket, expires_in: 60 }
    },
    consume(directory: string, id: string, ticket: string): HttpPeer | undefined {
      if (!input.enabled || !ticket || ticket.length > 128) return
      const key = digest(ticket), record = tickets.get(key)
      if (!record || record.expires <= now()) { tickets.delete(key); return }
      if (record.id !== id || record.scope.directory !== directory || !record.scope.peer) return
      try { get(record.scope, id) } catch { tickets.delete(key); return }
      tickets.delete(key)
      return { ...record.scope.peer }
    },
    connect(scope: PtyScope, id: string, socket: PtySocket, cursor = 0): PtyConnection {
      const session = get(scope, id)
      if (!Number.isSafeInteger(cursor) || cursor < -1) throw new PtyError("invalid_command", "Invalid PTY cursor")
      if (session.sockets.size >= 8) throw new PtyError("busy", "PTY connection limit")
      session.sockets.add(socket)
      const end = session.cursor
      const from = cursor === -1 ? end : Math.max(cursor, end - session.buffer.length)
      const replay = from >= end ? "" : session.buffer.slice(from - (end - session.buffer.length))
      for (let offset = 0; offset < replay.length; offset += 64 * 1024) if (!send(session, socket, replay.slice(offset, offset + 64 * 1024))) break
      if (session.sockets.has(socket)) {
        const json = new TextEncoder().encode(JSON.stringify({ cursor: end }))
        const control = new Uint8Array(json.length + 1)
        control.set(json, 1)
        send(session, socket, control)
      }
      return {
        message(data) {
          if (!session.sockets.has(socket)) return
          try { get(scope, id); if (Buffer.byteLength(data) > 128 * 1024) throw new Error(); session.process!.write(data) }
          catch { session.sockets.delete(socket); socket.close(1008, "PTY input refused") }
        },
        close() { session.sockets.delete(socket) },
      }
    },
    dispose(directory?: string) {
      for (const [cwd, pending] of creating) if (!directory || cwd === directory) for (const request of pending) request.cancelled = true
      for (const [id, session] of sessions) if (!directory || session.scope.directory === directory) drop(id)
    },
    sweep,
  }
  return service
}
