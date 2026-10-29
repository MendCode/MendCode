import type { HistoryReport, SkillsReport, ClientId, Command, ErrorPayload, EventsWindow, Frame, GlobalEvent, SessionEvent, SessionId, SessionDetail, SessionInspection, DiagnosticsReport, SessionTreeNode, ItemId } from "@mendcode/protocol"
// The zod-free entry: a terminal must not pay ~35 MB to re-validate its own daemon's frames.
import { createIdFactory, decodeTrustedFrame as decodeFrame, encodeFrame, MAX_FRAME_BYTES, isLoopbackHost, PROTOCOL_VERSION } from "@mendcode/protocol/wire"

import { checkServerIdentity, rootCertificates } from "node:tls"
import { connectHttpSocket } from "./http-socket"
import { connectLoopback, type LoopbackAttach } from "./loopback-socket"

export type LocalTcpTarget = { hostname: "127.0.0.1"; port: number; token: string }
export type RemoteTransport = { hostname: string; port: number; token: string; tls?: boolean; ca?: string; httpUrl?: string; username?: string; directory?: string }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type CommandInput = DistributiveOmit<Exclude<Command, { type: "hello" }>, "id" | "clientId">
export type CommandReply = { ok: true; result?: Record<string, unknown> } | { ok: false; error: ErrorPayload }
/** The answer of `loadWindow` / `loadBefore` / `loadAfter`. */
export type WindowReply = { ok: true; window: EventsWindow } | { ok: false; error: ErrorPayload }

/** Long-running control operations have their own deadline; ordinary RPCs keep the configured client timeout. */
export function commandTimeout(command: CommandInput | Command, defaultMs: number) {
  if (command.type === "pet.manage" && command.input.action === "generate") return Math.max(defaultMs, 1_500_000)
  if (command.type === "session.rest.control" && command.operation === "wait") return Math.max(defaultMs, (command.timeoutMs ?? 55_000) + 1_000)
  if (command.type === "memory.control" && (command.input.operation === "import-codex" && command.input.apply || command.input.operation === "propose" && command.input.fromFile)) return Math.max(defaultMs, 50_000)
  if (command.type === "dream.control" && (command.input.operation === "run" || command.input.operation === "consolidate")) return Math.max(defaultMs, 3_600_000)
  if (command.type === "loop.tick" && command.execute) return Math.max(defaultMs, 16 * 60_000)
  if (command.type === "task.status" && command.action === "wait") return Math.max(defaultMs, (command.timeoutMs ?? 30_000) + 5000)
  if (command.type === "task.run" && !command.input.background) return Math.max(defaultMs, 3_600_000)
  if (command.type === "continuity.wait") return Math.max(defaultMs, (command.timeoutMs ?? 10000) + 5000)
  if (command.type === "setup.ask") return Math.max(defaultMs, 35_000)
  if (command.type === "release.check") return Math.max(defaultMs, 30_000)
  // A PR review is two model passes over the whole diff; the hosted workflow's job stops at 30 minutes.
  if (command.type === "github.run" && command.input.review) return Math.max(defaultMs, 35 * 60_000)
  if (command.type === "github.run" || command.type === "github.finish" || command.type === "pr.checkout") return Math.max(defaultMs, 180_000)
  if (command.type === "computer.capture") return Math.max(defaultMs, 65_000)
  if (command.type === "computer.key") return Math.max(defaultMs, 20_000)
  if (command.type === "computer.session" || command.type === "computer.observe") return Math.max(defaultMs, 35_000)
  if (command.type === "computer.code") return Math.max(defaultMs, 25_000)
  if (command.type === "catalog.rest" && ["oauth-callback", "mcp-authenticate"].includes(command.input.operation)) return Math.max(defaultMs, 56_000)
  if (command.type === "tui.control.next") return Math.max(defaultMs, (command.timeoutMs ?? 25_000) + 1000)
  if (command.type === "tui.control.send") return Math.max(defaultMs, 16_000)
  if (command.type === "memory.side-chat") return Math.max(defaultMs, 60_000)
  if (command.type === "lsp.install") return Math.max(defaultMs, 190_000)
  return defaultMs
}

type Socket = { write(data: Uint8Array): number; end(): void; terminate(): void }

/** A command waiting for its answer. `resend`: kept across a dropped connection and sent again, same id, once reconnected. */
type Waiting = { frame: Frame; resend: boolean; sent: boolean; timer?: ReturnType<typeof setTimeout>; settle(reply: CommandReply): void }

/**
 * Thin client: sends commands, receives pushed events, never polls (P12).
 * On reconnect it resubscribes with the last seq it rendered, so nothing is lost or repeated (I4), then sends again, in
 * order, every command still unanswered (the daemon answers a repeated id from its cache instead of running it twice).
 * Commands sent while reconnecting wait for the connection instead of failing.
 */
export function createClient(options: {
  socketPath?: string
  /**
   * Local loopback TCP transport (Windows default): read again on every connect, so a restarted daemon's new port
   * and secret are picked up. Returns undefined while no daemon has published its endpoint.
   */
  localTcp?: () => LocalTcpTarget | undefined
  /**
   * The daemon runs inside this process (solo mode): read again on every connect, like `localTcp`. While it returns an
   * attach function the client talks to the daemon in memory; once it returns undefined (the host stopped and a separate
   * daemon took over) the client falls back to `socketPath` / `localTcp`.
   */
  loopback?: () => LoopbackAttach | undefined
  remote?: RemoteTransport
  name: string
  /** What this client says about itself in `hello` (e.g. `origin:agent`, docs/permissions.md); sent again on every reconnect. */
  capabilities?: readonly string[]
  onEvent?(event: SessionEvent): void
  onGlobal?(event: GlobalEvent): void
  onConnection?(state: "connected" | "reconnecting" | "closed"): void
  reconnect?: boolean
  /** Runs before each reconnect attempt, e.g. to start the daemon again if it died. A rejection just schedules the next attempt. */
  beforeReconnect?(): Promise<unknown>
  timeoutMs?: number
  /** Local opt-in diagnostics; restored after reconnect, with no content-bearing fields. */
  trace?: boolean
  /** The daemon's validation message for a command it refused to parse; the caller's reply carries a friendly line instead. */
  onRejected?(rejection: { command: string; detail: string }): void
  /** This client's own build: a daemon of the same build that refuses a command is not blamed on its age. */
  buildId?: string
}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!options.remote && !options.socketPath && !options.localTcp && !options.loopback) throw new Error("[CLIENT]: socketPath, localTcp, loopback or remote required")
  let remoteInfo: { tokenName: string; readOnly: boolean } | undefined
  let daemonDirectory: string | undefined
  let daemonBuildId: string | undefined
  const ids = createIdFactory()
  const clientId: ClientId = ids("client")
  const pending = new Map<string, Waiting>()
  const cursors = new Map<SessionId, number>()
  let socket: Socket | undefined
  /** Handshake done and subscriptions restored: commands may flow. */
  let live = false
  let buffer = ""
  let decoder = new TextDecoder()
  const outbox: Uint8Array[] = []
  const encoder = new TextEncoder()
  let closed = false
  let attempt = 0
  let ready: Promise<void> | undefined
  let established = false
  let opening = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let tracing = options.trace === true
  let tracePending = 0

  function recordTrace(sample: import("@mendcode/protocol").TraceSample) {
    if (!tracing || !live || closed || tracePending >= 64) return
    tracePending++
    void request({ type: "trace.record", sample, id: ids("command"), clientId }, false).finally(() => { tracePending-- })
  }

  function write(frame: Parameters<typeof encodeFrame>[0]) {
    if (!socket) throw new Error("[CLIENT]: not connected")
    outbox.push(encoder.encode(encodeFrame(frame)))
    flushOutbox()
  }

  function flushOutbox() {
    while (socket && outbox.length > 0) {
      const chunk = outbox[0]!
      const written = socket.write(chunk)
      if (written < chunk.byteLength) {
        outbox[0] = chunk.subarray(written)
        return
      }
      outbox.shift()
    }
  }

  function onLine(line: string) {
    const decoded = decodeFrame(line)
    if (!decoded.ok) return
    const frame = decoded.frame
    if (frame.kind === "ack") pending.get(frame.id)?.settle({ ok: true, ...(frame.result ? { result: frame.result } : {}) })
    if (frame.kind === "error") {
      if (frame.id) pending.get(frame.id)?.settle({ ok: false, error: frame.error })
      else for (const waiting of [...pending.values()]) waiting.settle({ ok: false, error: frame.error })
    }
    if (frame.kind === "event") {
      const cursor = cursors.get(frame.body.sessionId)
      if (cursor === undefined || frame.body.seq <= cursor) return
      cursors.set(frame.body.sessionId, frame.body.seq)
      const started = tracing ? performance.now() : 0
      options.onEvent?.(frame.body)
      recordTrace({ name: "client.event", metadata: { sessionId: frame.body.sessionId, seq: frame.body.seq, ...("turnId" in frame.body ? { turnId: frame.body.turnId } : {}) }, durationMs: Math.max(0, performance.now() - started), status: "ok" })
    }
    if (frame.kind === "global") options.onGlobal?.(frame.body)
  }

  /**
   * Every request settles: an answer, its command deadline after it was written (an old daemon may not know it), or a
   * closed connection. A `resend` request outlives a dropped connection: it waits unsent and goes out again on reconnect.
   */
  function request(body: Command, resend = false) {
    const started = tracing ? performance.now() : 0
    const result = requestFrame({ v: PROTOCOL_VERSION, kind: "command", body }, body.id, resend).then((reply) => softenRejection(body, reply))
    if (!tracing || body.type === "hello" || body.type.startsWith("trace.")) return result
    return result.then((reply) => {
      recordTrace({ name: "client.command", metadata: { commandId: body.id, ...("sessionId" in body && body.sessionId ? { sessionId: body.sessionId } : {}) }, durationMs: Math.min(86_400_000, Math.max(0, performance.now() - started)), status: reply.ok ? "ok" : "error" })
      return reply
    })
  }

  /**
   * A daemon that cannot parse a command this client built is almost always an older build (the schema moved on):
   * the schema's own message is for logs, the user gets one actionable line.
   */
  function softenRejection(body: Command, reply: CommandReply): CommandReply {
    if (reply.ok || body.type === "hello" || reply.error.code !== "invalid_command") return reply
    if (!reply.error.message.startsWith("[PROTOCOL]:") && reply.error.message !== "invalid remote command frame") return reply
    options.onRejected?.({ command: body.type, detail: reply.error.message })
    // The same build parses what this client builds: the value itself is wrong (a mistyped id), not the daemon's age.
    if (options.buildId && daemonBuildId === options.buildId) {
      const fields = [...new Set([...reply.error.message.matchAll(/→ at body\.([\w.[\]]+)/g)].map((match) => match[1]!))]
      return { ok: false, error: { ...reply.error, message: `daemon rejected ${body.type} · invalid ${fields.length ? fields.join(", ") : "input"}` } }
    }
    return { ok: false, error: { ...reply.error, message: `daemon rejected ${body.type} · it may be an older build · /daemon restart` } }
  }

  function requestFrame(frame: Frame, id: string, resend = false) {
    return new Promise<CommandReply>((resolve) => {
      const waiting: Waiting = {
        frame,
        resend,
        sent: false,
        settle(reply) {
          clearTimeout(waiting.timer)
          pending.delete(id)
          resolve(reply)
        },
      }
      pending.set(id, waiting)
      if (live || !resend) transmit(waiting)
      else if (closed) waiting.settle({ ok: false, error: { code: "internal", message: "[CLIENT]: client closed" } })
    })
  }

  function transmit(waiting: Waiting) {
    try {
      write(waiting.frame)
    } catch (error) {
      return waiting.settle({ ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } })
    }
    waiting.sent = true
    const deadline = waiting.frame.kind === "command" ? commandTimeout(waiting.frame.body, timeoutMs) : timeoutMs
    waiting.timer = setTimeout(() => waiting.settle({ ok: false, error: { code: "internal", message: `[CLIENT]: no reply to ${waiting.frame.kind === "command" ? waiting.frame.body.type : waiting.frame.kind} within ${deadline} ms` } }), deadline)
  }

  /** On a dropped connection: requests that resend go back to waiting; the rest fail now. */
  function holdOrFail(willReconnect: boolean) {
    for (const waiting of [...pending.values()]) {
      if (waiting.resend && willReconnect) {
        clearTimeout(waiting.timer)
        waiting.sent = false
      } else waiting.settle({ ok: false, error: { code: "internal", message: "[CLIENT]: connection closed" } })
    }
  }

  async function open() {
    opening = true
    try { await openTransport() } catch (error) {
      socket?.end()
      throw error
    } finally { opening = false }
  }

  async function openTransport() {
    const remote = options.remote
    const hosted = remote ? undefined : options.loopback?.()
    const localTarget = remote || hosted || options.socketPath ? undefined : options.localTcp?.()
    if (!remote && !hosted && !options.socketPath && !localTarget) throw new Error("[CLIENT]: local daemon endpoint not published")
    const useTls = remote && !remote.httpUrl && (remote.tls || remote.ca !== undefined || !isLoopbackHost(remote.hostname))
    let acceptTls: () => void = () => {}
    let rejectTls: (error: Error) => void = () => {}
    const secured = new Promise<void>((resolve, reject) => { acceptTls = resolve; rejectTls = reject })
    // Attach the rejection handler before connecting: a handshake can finish before Bun.connect returns.
    void secured.catch(() => {})
    const handlers: Bun.SocketHandler<unknown> = {
      ...(useTls ? { handshake(peer: Bun.Socket<unknown>, success: boolean, error: Error | null) {
        const identityError = success && !error ? checkServerIdentity(remote!.hostname, peer.getPeerCertificate()!) : undefined
        if (!success || error || identityError) {
          rejectTls(new Error("[CLIENT]: TLS certificate verification failed"))
          peer.terminate()
        } else acceptTls()
      } } : {}),
      data(_socket, data) {
        buffer += decoder.decode(data, { stream: true })
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES && !buffer.includes("\n")) {
          _socket.end()
          return
        }
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          onLine(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
        }
      },
      drain() {
        flushOutbox()
      },
      close() {
        socket = undefined
        live = false
        buffer = ""
        decoder = new TextDecoder()
        outbox.length = 0
        rejectTls(new Error("[CLIENT]: connection closed during TLS handshake"))
        const willReconnect = established && !closed && options.reconnect !== false
        holdOrFail(willReconnect)
        if (!willReconnect) return options.onConnection?.("closed")
        options.onConnection?.("reconnecting")
        if (!opening) scheduleReconnect()
      },
    }
    const connecting = hosted
      ? connectLoopback(hosted, { data: (data) => handlers.data!({ end: () => socket?.end() } as Bun.Socket<unknown>, Buffer.from(data.buffer, data.byteOffset, data.byteLength)), close: () => handlers.close!({} as Bun.Socket<unknown>) })
      : remote?.httpUrl
      ? connectHttpSocket(remote, { timeoutMs, data: (data) => handlers.data!({ end: () => socket?.end() } as Bun.Socket<unknown>, Buffer.from(data)), close: () => handlers.close!({} as Bun.Socket<unknown>) })
      : remote
      ? Bun.connect({ hostname: remote.hostname, port: remote.port, socket: handlers, ...(useTls ? { tls: { rejectUnauthorized: true, serverName: remote.hostname, ...(remote.ca ? { ca: [...rootCertificates, remote.ca] } : {}) } } : {}) })
      : localTarget
      ? Bun.connect({ hostname: localTarget.hostname, port: localTarget.port, socket: handlers })
      : Bun.connect({ unix: options.socketPath!, socket: handlers })
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    try {
      socket = await Promise.race([connecting, new Promise<never>((_resolve, reject) => {
        connectTimer = setTimeout(() => reject(new Error("[CLIENT]: connection timeout")), timeoutMs)
      })])
    } catch (error) {
      void connecting.then((late) => late.terminate(), () => {})
      throw error
    } finally { clearTimeout(connectTimer) }
    if (closed) {
      socket.terminate()
      throw new Error("[CLIENT]: client closed")
    }
    if (useTls) {
      const timer = setTimeout(() => rejectTls(new Error("[CLIENT]: TLS handshake timeout")), timeoutMs)
      try { await secured } finally { clearTimeout(timer) }
    }
    if (remote && !remote.httpUrl) {
      const authId = ids("command")
      const auth = await requestFrame({ v: PROTOCOL_VERSION, kind: "auth", id: authId, token: remote.token }, authId)
      if (!auth.ok) throw new Error(`[CLIENT]: ${auth.error.message}`)
      remoteInfo = { tokenName: String(auth.result?.tokenName ?? ""), readOnly: auth.result?.readOnly === true }
    }
    if (localTarget) {
      const authId = ids("command")
      const auth = await requestFrame({ v: PROTOCOL_VERSION, kind: "auth", id: authId, token: localTarget.token }, authId)
      if (!auth.ok) throw new Error("[CLIENT]: local daemon refused the endpoint secret")
    }
    const hello = await request({ id: ids("command"), clientId, type: "hello", protocolVersion: PROTOCOL_VERSION, client: { name: options.name, version: "0.0.0" }, capabilities: [...(options.capabilities ?? [])] })
    if (!hello.ok) throw new Error(`[CLIENT]: ${hello.error.message}`)
    if (remote?.httpUrl) {
      const peer = hello.result?.remote as { tokenName?: string; readOnly?: boolean } | undefined
      remoteInfo = { tokenName: peer?.tokenName ?? "", readOnly: peer?.readOnly === true }
    }
    daemonDirectory = typeof hello.result?.directory === "string" ? hello.result.directory : undefined
    daemonBuildId = typeof hello.result?.buildId === "string" ? hello.result.buildId : undefined
    if (tracing) {
      const configured = await request({ type: "trace.configure", enabled: true, id: ids("command"), clientId })
      if (!configured.ok) throw new Error("[CLIENT]: tracing requires a local daemon with trace support")
    }
    attempt = 0
    for (const [sessionId, afterSeq] of cursors) await request({ id: ids("command"), clientId, type: "client.subscribe", sessionId, afterSeq })
    live = true
    established = true
    for (const waiting of [...pending.values()]) if (!waiting.sent) transmit(waiting)
    options.onConnection?.("connected")
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    const delay = Math.min(2_000, 50 * 2 ** attempt++)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (closed) return
      ready = (options.beforeReconnect?.() ?? Promise.resolve()).then(open).catch(() => scheduleReconnect())
    }, delay)
  }

  /** `session.events` as a typed answer; a read, so it is sent again after a reconnect like any command. */
  async function readWindow(query: { sessionId: SessionId; before?: number; after?: number; limit?: number }): Promise<WindowReply> {
    const reply = await request({ id: ids("command"), clientId, type: "session.events", ...query } as Command, true)
    return reply.ok ? { ok: true, window: reply.result as unknown as EventsWindow } : reply
  }

  return {
    clientId,
    /** Project directory reported by the daemon; remote callers must not substitute local cwd. */
    get daemonDirectory() {
      return daemonDirectory
    },
    get remoteInfo() {
      return remoteInfo
    },
    /** Build the connected daemon reported in the handshake ("unknown" for pre-handshake builds). */
    get daemonBuildId() {
      return daemonBuildId
    },
    async connect() {
      if (closed) throw new Error("[CLIENT]: client closed")
      ready = open()
      try { await ready } catch (error) {
        closed = true
        socket?.end()
        holdOrFail(false)
        throw error
      }
    },
    /** Sends a command; while reconnecting it waits and goes out once the connection is back. */
    send(command: CommandInput) {
      // A session left behind must not be subscribed again by a reconnect: its stale cursor would replay the whole gap into the screen.
      if (command.type === "client.unsubscribe") cursors.delete(command.sessionId)
      return request({ ...command, id: ids("command"), clientId } as Command, command.type !== "audio.play" && command.type !== "voice.control")
    },
    async mcpCatalog(directory: string): Promise<{ ok: true; catalog: import("@mendcode/protocol").McpCatalogReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "mcp.catalog", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, catalog: reply.result as import("@mendcode/protocol").McpCatalogReport } : reply
    },
    async readMcpResource(directory: string, server: string, uri: string): Promise<{ ok: true; contents: import("@mendcode/protocol").McpResourceContent[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "mcp.resource.read", directory, server, uri, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, contents: reply.result?.contents as import("@mendcode/protocol").McpResourceContent[] } : reply
    },
    async getMcpPrompt(directory: string, server: string, name: string, args: Record<string, string>): Promise<{ ok: true; prompt: import("@mendcode/protocol").McpPromptResult } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "mcp.prompt.get", directory, server, name, args, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, prompt: reply.result as import("@mendcode/protocol").McpPromptResult } : reply
    },
    async serverHealth() {
      return request({ type: "server.health", id: ids("command"), clientId }, true)
    },
    async serverMemory(): Promise<{ ok: true; memory: import("@mendcode/protocol").ProcessMemory } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "server.memory", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, memory: reply.result as unknown as import("@mendcode/protocol").ProcessMemory } : reply
    },
    async serverConfig(directory?: string): Promise<{ ok: true; config: import("@mendcode/protocol").RestConfig } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "server.config.get", ...(directory ? { directory } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, config: reply.result?.config as import("@mendcode/protocol").RestConfig } : reply
    },
    updateServerConfig(patch: import("@mendcode/protocol").RestConfig, directory?: string) {
      return request({ type: "server.config.update", patch, ...(directory ? { directory } : {}), id: ids("command"), clientId }, true)
    },
    disposeInstances(directory?: string) {
      return request({ type: "server.dispose", ...(directory ? { directory } : {}), id: ids("command"), clientId }, true)
    },
    appLog(input: import("@mendcode/protocol").RestLogInput) {
      return request({ type: "app.log", input, id: ids("command"), clientId }, true)
    },
    upgradeRuntime(input: import("@mendcode/protocol").RestUpgradeInput = {}) {
      return request({ type: "server.upgrade", input, id: ids("command"), clientId }, true)
    },
    async aiConfig(directory: string, input: import("@mendcode/protocol").AIConfigInput): Promise<{ ok: true; report: import("@mendcode/protocol").AIConfigReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "ai.config", directory, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").AIConfigReport } : reply
    },
    async permissionsStatus(): Promise<{ ok: true; report: import("@mendcode/protocol").PermissionsStatusReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "permissions.status", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").PermissionsStatusReport } : reply
    },
    permissionsSetDefault(mode: Extract<CommandInput, { type: "permissions.set-default" }>['mode']) {
      return request({ type: "permissions.set-default", mode, id: ids("command"), clientId }, true)
    },
    permissionsSetReviewerRole(role: import("@mendcode/protocol").ModelRole) {
      return request({ type: "permissions.set-reviewer-role", role, id: ids("command"), clientId }, true)
    },
    async permissionsHistory(sessionId: SessionId, limit = 100): Promise<{ ok: true; report: import("@mendcode/protocol").PermissionsHistoryReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "permissions.history", sessionId, limit, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").PermissionsHistoryReport } : reply
    },
    async getSession(sessionId: SessionId): Promise<{ ok: true; session: SessionDetail } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.get", sessionId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, session: reply.result?.session as SessionDetail } : reply
    },
    async archiveSession(sessionId: SessionId, restore = false): Promise<{ ok: true; session: SessionDetail } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.archive", sessionId, ...(restore ? { restore: true } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, session: reply.result?.session as SessionDetail } : reply
    },
    async sessionTree(sessionId: SessionId): Promise<{ ok: true; current: SessionId; nodes: SessionTreeNode[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.tree", sessionId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, current: reply.result?.current as SessionId, nodes: reply.result?.nodes as SessionTreeNode[] } : reply
    },
    async labelMessage(sessionId: SessionId, itemId: ItemId, label?: string): Promise<{ ok: true; label?: string } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.label", sessionId, itemId, ...(label ? { label } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, ...(typeof reply.result?.label === "string" ? { label: reply.result.label } : {}) } : reply
    },
    async recapSession(sessionId: SessionId, refresh = false): Promise<{ ok: true; text: string; at: number; cached: boolean } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.recap", sessionId, ...(refresh ? { refresh: true } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, text: String(reply.result?.text ?? ""), at: Number(reply.result?.at ?? 0), cached: reply.result?.cached === true } : reply
    },
    async inspectSession(sessionId: SessionId, limit = 50): Promise<{ ok: true; snapshot: SessionInspection } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.inspect", sessionId, limit, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, snapshot: reply.result as unknown as SessionInspection } : reply
    },
    async diagnosticsResources(): Promise<{ ok: true; report: DiagnosticsReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "diagnostics.resources", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as DiagnosticsReport } : reply
    },
    async snapshotDiagnostics(): Promise<{ ok: true; path: string } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "diagnostics.snapshot", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, path: String(reply.result?.path) } : reply
    },
    tuiQuery(operation: Extract<CommandInput, { type: "tui.query" }>["operation"] = "status") {
      return request({ type: "tui.query", operation, id: ids("command"), clientId }, true)
    },
    tuiChange(input: Extract<CommandInput, { type: "tui.change" }>["input"]) {
      return request({ type: "tui.change", input, id: ids("command"), clientId }, true)
    },
    projectControl(directory: string, input: import("@mendcode/protocol").ProjectControlInput) {
      return request({ type: "project.control", directory, input, id: ids("command"), clientId }, true)
    },
    promptStatus(directory: string, modelID?: string) {
      return request({ type: "prompt.status", directory, ...(modelID ? { modelID } : {}), id: ids("command"), clientId }, true)
    },
    promptSet(directory: string, choice: Pick<Extract<CommandInput, { type: "prompt.set" }>, "mode" | "focusID">) {
      return request({ type: "prompt.set", directory, ...choice, id: ids("command"), clientId }, true)
    },
    promptBuild(directory: string, options: Omit<Extract<CommandInput, { type: "prompt.build" }>, "type" | "directory"> = {}) {
      return request({ type: "prompt.build", directory, ...options, id: ids("command"), clientId }, true)
    },
    async agentCommandPolicy(): Promise<{ ok: true; report: import("@mendcode/protocol").AgentCommandPolicyReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.agent-command.policy", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").AgentCommandPolicyReport } : reply
    },
    async createAgent(input: Omit<Extract<CommandInput, { type: "agent.create" }>, "type">): Promise<{ ok: true; report: import("@mendcode/protocol").AgentCreateReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ ...input, type: "agent.create", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").AgentCreateReport } : reply
    },
    async debugAgent(input: Omit<Extract<CommandInput, { type: "agent.debug" }>, "type">): Promise<{ ok: true; report: import("@mendcode/protocol").AgentDebugReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ ...input, type: "agent.debug", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").AgentDebugReport } : reply
    },
    async agentCommands(sessionId: SessionId): Promise<{ ok: true; report: import("@mendcode/protocol").AgentCommandsReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.agent-command.list", sessionId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").AgentCommandsReport } : reply
    },
    createAgentCommand(sessionId: SessionId, targetSessionId: SessionId, command: import("@mendcode/protocol").AgentCommandRequest, expiresAt?: number) {
      return request({ type: "session.agent-command.create", sessionId, targetSessionId, request: command, ...(expiresAt === undefined ? {} : { expiresAt }), id: ids("command"), clientId }, true)
    },
    reviewAgentCommand(sessionId: SessionId, commandId: import("@mendcode/protocol").CommandId, state: "accepted" | "rejected") {
      return request({ type: "session.agent-command.update", sessionId, commandId, state, id: ids("command"), clientId }, true)
    },
    /** Subscribes from `afterSeq` (0 = full history). The daemon replays, then streams live events. */
    subscribe(sessionId: SessionId, afterSeq = 0) {
      cursors.set(sessionId, afterSeq)
      return request({ id: ids("command"), clientId, type: "client.subscribe", sessionId, afterSeq }, true)
    },
    /**
     * The newest `limit` events of a session, to show a long session quickly without replaying its whole log. Follow with
     * `subscribe(sessionId, window.lastSeq)` to stream what comes next, and `loadBefore(sessionId, window.firstSeq)` to
     * page back. Events of undone turns are left out.
     */
    loadWindow(sessionId: SessionId, limit?: number): Promise<WindowReply> {
      return readWindow({ sessionId, ...(limit === undefined ? {} : { limit }) })
    },
    /** The `limit` events just older than `seq` (a window's `firstSeq`); `more` in the answer says whether even older ones exist. */
    loadBefore(sessionId: SessionId, seq: number, limit?: number): Promise<WindowReply> {
      return readWindow({ sessionId, before: seq, ...(limit === undefined ? {} : { limit }) })
    },
    /** The first `limit` events newer than `seq`, for a client that kept a cursor but did not subscribe. */
    loadAfter(sessionId: SessionId, seq: number, limit?: number): Promise<WindowReply> {
      return readWindow({ sessionId, after: seq, ...(limit === undefined ? {} : { limit }) })
    },
    async history(sessionId: SessionId, query: { before?: number; after?: number; limit?: number; turnId?: import("@mendcode/protocol").TurnId } = {}): Promise<{ ok: true; history: HistoryReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "session.history", sessionId, ...query }, true)
      return reply.ok ? { ok: true, history: reply.result as unknown as HistoryReport } : reply
    },
    async sessionChanges(sessionId: SessionId, atItemId?: import("@mendcode/protocol").ItemId): Promise<{ ok: true; report: import("@mendcode/protocol").ChangesReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "session.changes", sessionId, ...(atItemId ? { atItemId } : {}) }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").ChangesReport } : reply
    },
    async tasks(sessionId?: SessionId): Promise<{ ok: true; tasks: import("@mendcode/protocol").TaskRecord[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "task.list", ...(sessionId ? { sessionId } : {}) }, true)
      return reply.ok ? { ok: true, tasks: reply.result?.tasks as import("@mendcode/protocol").TaskRecord[] } : reply
    },
    async sessionChildren(sessionId: SessionId): Promise<{ ok: true; sessions: SessionDetail[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "session.children", sessionId }, true)
      return reply.ok ? { ok: true, sessions: reply.result?.sessions as SessionDetail[] } : reply
    },
    async backgroundSessions(directory?: string): Promise<{ ok: true; sessions: import("@mendcode/protocol").SessionBackgroundEntry[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "session.background.list", ...(directory ? { directory } : {}) }, true)
      return reply.ok ? { ok: true, sessions: reply.result?.sessions as import("@mendcode/protocol").SessionBackgroundEntry[] } : reply
    },
    registerBackground(sessionId: SessionId, patch: import("@mendcode/protocol").SessionBackgroundPatch = {}) {
      return request({ id: ids("command"), clientId, type: "session.background.register", sessionId, ...patch }, true)
    },
    removeBackground(sessionId: SessionId) {
      return request({ id: ids("command"), clientId, type: "session.background.remove", sessionId }, true)
    },
    acquireBackgroundWriter(sessionId: SessionId, ttlMs?: number) {
      return request({ id: ids("command"), clientId, type: "session.background.writer.acquire", sessionId, ...(ttlMs === undefined ? {} : { ttlMs }) }, true)
    },
    releaseBackgroundWriter(sessionId: SessionId) {
      return request({ id: ids("command"), clientId, type: "session.background.writer.release", sessionId }, true)
    },
    async agentViewMetadata(sessionId: SessionId): Promise<{ ok: true; metadata: import("@mendcode/protocol").AgentViewMetadata | null } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "session.agent-view.metadata.get", sessionId }, true)
      return reply.ok ? { ok: true, metadata: reply.result?.metadata as import("@mendcode/protocol").AgentViewMetadata | null } : reply
    },
    patchAgentViewMetadata(sessionId: SessionId, patch: import("@mendcode/protocol").AgentViewMetadataPatch) {
      return request({ id: ids("command"), clientId, type: "session.agent-view.metadata.patch", sessionId, patch }, true)
    },
    async agentViewMetadataList(directory?: string): Promise<{ ok: true; metadata: import("@mendcode/protocol").AgentViewMetadata[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "session.agent-view.metadata.list", ...(directory ? { directory } : {}) }, true)
      return reply.ok ? { ok: true, metadata: reply.result?.metadata as import("@mendcode/protocol").AgentViewMetadata[] } : reply
    },
    async incomingAgentCommands(sessionId?: SessionId): Promise<{ ok: true; commands: import("@mendcode/protocol").AgentCommandRecord[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, ...(sessionId ? { type: "session.agent-command.list-by-session", sessionId } as const : { type: "session.agent-command.list" } as const) }, true)
      return reply.ok ? { ok: true, commands: reply.result?.commands as import("@mendcode/protocol").AgentCommandRecord[] } : reply
    },
    patchAgentCommand(sessionId: SessionId, commandId: import("@mendcode/protocol").CommandId, patch: Pick<Extract<CommandInput, { type: "session.agent-command.patch" }>, "state" | "error" | "result">) {
      return request({ id: ids("command"), clientId, type: "session.agent-command.patch", sessionId, commandId, ...patch }, true)
    },
    async extractions(directory?: string): Promise<{ ok: true; jobs: Omit<import("@mendcode/protocol").ExtractionJob, "text">[]; configured: boolean } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "memory.extraction.list", ...(directory ? { directory } : {}) }, true)
      return reply.ok ? { ok: true, jobs: reply.result?.jobs as Omit<import("@mendcode/protocol").ExtractionJob, "text">[], configured: reply.result?.configured === true } : reply
    },
    async usage(query: Omit<Extract<CommandInput, { type: "usage.query" }>, "type">): Promise<{ ok: true; report: import("@mendcode/protocol").UsageReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "usage.query", ...query }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").UsageReport } : reply
    },
    async usageWeather(query: Omit<Extract<CommandInput, { type: "usage.weather.query" }>, "type">): Promise<{ ok: true; report: import("@mendcode/protocol").UsageWeatherReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "usage.weather.query", ...query })
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").UsageWeatherReport } : reply
    },
    async skills(directory: string): Promise<{ ok: true; report: SkillsReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "skills.list", directory }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as SkillsReport } : reply
    },
    async lsp(input: import("@mendcode/protocol/wire").LspInput & { directory: string }): Promise<{ ok: true; report: import("@mendcode/protocol/wire").LspReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "lsp.query", ...input }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol/wire").LspReport } : reply
    },
    async memoryWorkspaces(directory?: string): Promise<{ ok: true; report: import("@mendcode/protocol").MemoryWorkspacesReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "memory.workspaces", ...(directory ? { directory } : {}) }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").MemoryWorkspacesReport } : reply
    },
    async browseMemory(view: "project" | "user" | "all", directory?: string, root?: string): Promise<{ ok: true; report: import("@mendcode/protocol").MemoryBrowseReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "memory.browse", view, ...(directory ? { directory } : {}), ...(root ? { root } : {}) }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").MemoryBrowseReport } : reply
    },
    async sharingStatus(scope: import("@mendcode/protocol").SharingScope, directory?: string): Promise<{ ok: true; report: import("@mendcode/protocol").SharingStatusReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "memory.sharing.status", scope, ...(directory ? { directory } : {}) }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").SharingStatusReport } : reply
    },
    async memoryModel(directory: string, input: import("@mendcode/protocol").MemoryModelInput) {
      return request({ id: ids("command"), clientId, type: "memory.model", directory, input }, true)
    },
    async memoryAssistant(directory: string, text?: string, selection?: import("@mendcode/protocol").MemoryAssistantSelection): Promise<{ ok: true; thread: import("@mendcode/protocol").MemoryAssistantThread } | { ok: false; error: ErrorPayload }> {
      const reply = await request(text === undefined ? { id: ids("command"), clientId, type: "memory.assistant.get", directory } : { id: ids("command"), clientId, type: "memory.assistant.send", directory, text, ...(selection ? { selection } : {}) }, true)
      return reply.ok ? { ok: true, thread: reply.result?.thread as import("@mendcode/protocol").MemoryAssistantThread } : reply
    },
    /** Chat archive of the memory assistant: `archive` starts a new chat, `list`, `restore` and `delete` work on archived ones. */
    async memoryAssistantArchive(directory: string, action: "archive" | "list" | "restore" | "delete", archiveId?: string): Promise<{ ok: true; thread: import("@mendcode/protocol").MemoryAssistantThread; archives: import("@mendcode/protocol").MemoryAssistantArchive[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "memory.assistant.archive", directory, action, ...(archiveId ? { archiveId } : {}) }, true)
      return reply.ok ? { ok: true, thread: reply.result?.thread as import("@mendcode/protocol").MemoryAssistantThread, archives: reply.result?.archives as import("@mendcode/protocol").MemoryAssistantArchive[] } : reply
    },
    async memoryControl(directory: string, input: import("@mendcode/protocol").MemoryControlInput) {
      return request({ id: ids("command"), clientId, type: "memory.control", directory, input }, true)
    },
    async dreamControl(directory: string, input: import("@mendcode/protocol").DreamControlInput) {
      return request({ id: ids("command"), clientId, type: "dream.control", directory, input }, true)
    },
    /** Saves the active compaction's follow-up; rejected once that compaction ends. */
    setCompactionFollowUp(sessionId: SessionId, turnId: import("@mendcode/protocol").TurnId, text: string): Promise<CommandReply> {
      return request({ id: ids("command"), clientId, type: "session.compaction.set", sessionId, turnId, text }, true)
    },
    /** Commands waiting to be sent or answered (a count for "offline" hints). */
    get unanswered() {
      return pending.size
    },
    cursor(sessionId: SessionId) {
      return cursors.get(sessionId)
    },
    /** Drops the transport without closing the client, to exercise reconnect. */
    dropConnection() {
      socket?.end()
    },
    close() {
      closed = true
      live = false
      clearTimeout(reconnectTimer)
      socket?.end()
      holdOrFail(false)
    },
    /** Stores a pasted file as a media ref, project mention or bounded text, without reading in the client. */
    async pasteAttachment(path: string, directory?: string): Promise<{ ok: true; attachment: import("@mendcode/protocol").AttachmentPasteResult } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ id: ids("command"), clientId, type: "attachment.paste", path, ...(directory ? { directory } : {}) }, false)
      return reply.ok ? { ok: true, attachment: reply.result as unknown as import("@mendcode/protocol").AttachmentPasteResult } : reply
    },
    review(sessionId: SessionId, query: import("@mendcode/protocol").ReviewRead = { action: "current" }) {
      return request({ id: ids("command"), clientId, type: "review.query", sessionId, query }, true)
    },
    updateReview(sessionId: SessionId, change: import("@mendcode/protocol").ReviewChange) {
      return request({ id: ids("command"), clientId, type: "review.update", sessionId, change }, true)
    },
    async continuity(sessionId: SessionId, kind?: "job" | "question") {
      const reply = await request({ type: "continuity.list", sessionId, ...(kind ? { kind } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, records: reply.result?.records as import("@mendcode/protocol").ContinuitySummary[] } : reply
    },
    async continuityRecord(sessionId: SessionId, recordId: string, offset?: number, limit?: number) {
      const reply = await request({ type: "continuity.get", sessionId, recordId, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, record: reply.result?.record as import("@mendcode/protocol").ContinuityRecord & { nextOffset?: number } } : reply
    },
    answerQuestions(sessionId: SessionId, requestId: import("@mendcode/protocol").RequestId, answers: string[][]) {
      return request({ type: "request.resolve", id: ids("command"), clientId, sessionId, requestId, decision: { kind: "answer", text: answers.map((answer) => answer.join(", ")).join("\n"), answers } }, true)
    },
    reviewPlan(sessionId: SessionId, requestId: import("@mendcode/protocol").RequestId, reply: Omit<import("@mendcode/protocol").PlanReviewReply, "kind">) {
      return request({ type: "request.resolve", id: ids("command"), clientId, sessionId, requestId, decision: { kind: "plan_review", ...reply } }, true)
    },
    async planReviews(sessionId: SessionId) {
      const reply = await request({ type: "plan.review.list", id: ids("command"), clientId, sessionId }, true)
      return reply.ok ? { ok: true as const, reviews: reply.result?.reviews as import("@mendcode/protocol").PlanReviewRecord[] } : reply
    },
    async importSession(source: string | undefined, directory: string, options: { from?: "auto" | "mendcode" | "claude-code" | "codex"; latest?: boolean } = {}): Promise<{ ok: true; import: import("@mendcode/protocol").SessionImportResult } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.import", id: ids("command"), clientId, ...(source === undefined ? {} : { source }), directory, ...options }, true)
      return reply.ok ? { ok: true, import: reply.result as import("@mendcode/protocol").SessionImportResult } : reply
    },
    async exportSession(sessionId: SessionId, options: Omit<Extract<CommandInput, { type: "session.export" }>, "type" | "sessionId"> = { format: "markdown" }): Promise<{ ok: true; export: import("@mendcode/protocol").SessionExportResult } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.export", id: ids("command"), clientId, sessionId, ...options }, true)
      return reply.ok ? { ok: true, export: reply.result as import("@mendcode/protocol").SessionExportResult } : reply
    },
    async recentContext(sessionId: SessionId, limit = 20): Promise<{ ok: true; report: import("@mendcode/protocol").RecentContextReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "context.recent", sessionId, limit, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").RecentContextReport } : reply
    },
    async releaseInspect(): Promise<{ ok: true; report: import("@mendcode/protocol").ReleaseReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "release.inspect", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").ReleaseReport } : reply
    },
    async releaseSet(channel: import("@mendcode/protocol").ReleaseChannel) {
      return request({ type: "release.set", channel, id: ids("command"), clientId }, true)
    },
    async releaseCheck(): Promise<{ ok: true; report: import("@mendcode/protocol").ReleaseReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "release.check", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").ReleaseReport } : reply
    },
    async systemReport(directory: string, operation: Extract<CommandInput, { type: "system.query" }>["operation"] = "status", schema: { entry?: string; page?: number; index?: number } = {}): Promise<{ ok: true; report: import("@mendcode/protocol").SystemReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "system.query", directory, operation, ...(schema.entry !== undefined ? { entry: schema.entry } : {}), ...(schema.page !== undefined ? { page: schema.page } : {}), ...(schema.index !== undefined ? { index: schema.index } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").SystemReport } : reply
    },
    async debug(directory: string, input: import("@mendcode/protocol").DebugInput): Promise<{ ok: true; report: import("@mendcode/protocol").DebugReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "debug.query", directory, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").DebugReport } : reply
    },
    async database(operation: "path" | "query", sql?: string): Promise<{ ok: true; report: import("@mendcode/protocol").DatabaseReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "db.query", operation, ...(sql ? { sql } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").DatabaseReport } : reply
    },
    async modelsConfig(directory: string): Promise<{ ok: true; report: import("@mendcode/protocol").ModelsConfigReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "models.config.get", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").ModelsConfigReport } : reply
    },
    async setupStatus(directory: string) {
      const reply = await request({ type: "setup.status", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol/wire").SetupReport } : reply
    },
    budgetStatus(directory: string) {
      return request({ type: "budget.status", directory, id: ids("command"), clientId }, true)
    },
    setBudget(policy: import("@mendcode/protocol/wire").BudgetPolicy) {
      return request({ type: "budget.set", policy, id: ids("command"), clientId }, true)
    },
    async providersCatalog(): Promise<{ ok: true; report: import("@mendcode/protocol").ProvidersCatalogReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "providers.catalog", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").ProvidersCatalogReport } : reply
    },
    async formatterStatus(directory: string): Promise<{ ok: true; report: import("@mendcode/protocol/wire").FormatterStatusReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "formatter.status", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol/wire").FormatterStatusReport } : reply
    },
    async formatFile(directory: string, path: string): Promise<{ ok: true; report: import("@mendcode/protocol/wire").FormatterFileReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "formatter.file", directory, path, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol/wire").FormatterFileReport } : reply
    },
    validateTheme(file: string) {
      return request({ type: "theme.validate", file, id: ids("command"), clientId }, true)
    },
    installTheme(file: string, directory: string, options: { name?: string; scope?: "user" | "project" } = {}) {
      return request({ type: "theme.install", file, directory, ...options, scope: options.scope ?? "project", id: ids("command"), clientId }, true)
    },
    selectTheme(name: string, directory: string, scope: "user" | "project" = "project") {
      return request({ type: "theme.select", name, directory, scope, id: ids("command"), clientId }, true)
    },
    async loopSnapshot(loopId: import("@mendcode/protocol").LoopId): Promise<{ ok: true; snapshot: import("@mendcode/protocol").LoopSnapshot } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "loop.snapshot", loopId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, snapshot: reply.result as unknown as import("@mendcode/protocol").LoopSnapshot } : reply
    },
    async loopEvents(loopId: import("@mendcode/protocol").LoopId, limit = 50): Promise<{ ok: true; events: import("@mendcode/protocol").LoopJournalEvent[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "loop.events", loopId, limit, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, events: reply.result?.events as import("@mendcode/protocol").LoopJournalEvent[] } : reply
    },
    async searchSession(sessionId: SessionId, input: import("@mendcode/protocol").SessionRecallSearchInput): Promise<{ ok: true; page: import("@mendcode/protocol").SessionRecallPage } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.recall.search", sessionId, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, page: reply.result as unknown as import("@mendcode/protocol").SessionRecallPage } : reply
    },
    async readSession(sessionId: SessionId, input: import("@mendcode/protocol").SessionRecallReadInput = {}): Promise<{ ok: true; recall: import("@mendcode/protocol").SessionRecallPage | import("@mendcode/protocol").SessionRecallMessage } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.recall.read", sessionId, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, recall: reply.result as unknown as import("@mendcode/protocol").SessionRecallPage | import("@mendcode/protocol").SessionRecallMessage } : reply
    },
    async sessionNotes(sessionId: SessionId, input: import("@mendcode/protocol").SessionNotesInput = { action: "read" }): Promise<{ ok: true; notes: import("@mendcode/protocol").SessionNotesReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "session.notes", sessionId, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, notes: reply.result as unknown as import("@mendcode/protocol").SessionNotesReport } : reply
    },
    async commands(directory: string): Promise<{ ok: true; commands: import("@mendcode/protocol").CommandSummary[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "commands.list", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, commands: reply.result?.commands as import("@mendcode/protocol").CommandSummary[] } : reply
    },
    executeCommand(input: Omit<Extract<CommandInput, { type: "commands.execute" }>, "type">) {
      return request({ type: "commands.execute", ...input, id: ids("command"), clientId }, false)
    },
    discoverCommands(directory: string) {
      return request({ type: "commands.discover", directory, id: ids("command"), clientId }, false)
    },
    async queueMode(mode?: NonNullable<import("@mendcode/protocol").Settings["queue"]>["mode"]): Promise<{ ok: true; mode: "after-response" | "after-tools" | "immediate" } | { ok: false; error: ErrorPayload }> {
      const command: CommandInput = mode ? { type: "settings.set", patch: { queue: { mode } } } : { type: "settings.get" }
      const reply = await request({ ...command, id: ids("command"), clientId }, true)
      const settings = reply.ok ? reply.result?.settings as import("@mendcode/protocol").Settings : undefined
      return reply.ok ? { ok: true, mode: settings?.queue?.mode ?? "after-response" } : reply
    },
    async worktrees(directory: string, query: import("@mendcode/protocol").WorktreeRead = { operation: "status" }): Promise<{ ok: true; report: import("@mendcode/protocol").WorktreeReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "worktree.query", directory, query, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").WorktreeReport } : reply
    },
    async changeWorktree(directory: string, change: import("@mendcode/protocol").WorktreeChange): Promise<{ ok: true; report: import("@mendcode/protocol").WorktreeReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "worktree.change", directory, change, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").WorktreeReport } : reply
    },
    async saveWorkflow(input: Omit<Extract<CommandInput, { type: "workflow.save" }>, "type">): Promise<{ ok: true; receipt: import("@mendcode/protocol").WorkflowRevisionReceipt } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ ...input, type: "workflow.save", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, receipt: reply.result?.receipt as import("@mendcode/protocol").WorkflowRevisionReceipt } : reply
    },
    async workflowDefinitions(directory: string, limit = 50): Promise<{ ok: true; definitions: import("@mendcode/protocol").WorkflowDefinition[] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "workflow.definitions", directory, limit, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, definitions: reply.result?.definitions as import("@mendcode/protocol").WorkflowDefinition[] } : reply
    },
    setWorkflowPermissions(workflowId: import("@mendcode/protocol").WorkflowId, input: Omit<Extract<CommandInput, { type: "workflow.permissions" }>, "type" | "workflowId">): Promise<CommandReply> {
      return request({ ...input, type: "workflow.permissions", workflowId, id: ids("command"), clientId }, true)
    },
    retryWorkflowPhase(workflowId: import("@mendcode/protocol").WorkflowId, phaseId: string, reason?: string): Promise<CommandReply> {
      return request({ type: "workflow.retry-phase", workflowId, phaseId, ...(reason ? { reason } : {}), id: ids("command"), clientId }, true)
    },
    async workflowRevision(directory: string, revisionId: string): Promise<{ ok: true; receipt: import("@mendcode/protocol").WorkflowRevisionReceipt } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "workflow.revision.get", directory, revisionId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, receipt: reply.result?.receipt as import("@mendcode/protocol").WorkflowRevisionReceipt } : reply
    },
    async startWorkflow(input: Omit<Extract<CommandInput, { type: "workflow.start" }>, "type">): Promise<{ ok: true; workflow: import("@mendcode/protocol").WorkflowSummary } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ ...input, type: "workflow.start", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, workflow: reply.result?.workflow as import("@mendcode/protocol").WorkflowSummary } : reply
    },
    async getWorkflow(workflowId: import("@mendcode/protocol").WorkflowId): Promise<{ ok: true; workflow: import("@mendcode/protocol").WorkflowRun } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "workflow.get", workflowId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, workflow: reply.result?.workflow as import("@mendcode/protocol").WorkflowRun } : reply
    },
    async reviewLoop(input: Omit<Extract<CommandInput, { type: "loop.review" }>, "type">): Promise<{ ok: true; loop: import("@mendcode/protocol").Loop } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "loop.review", ...input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, loop: reply.result?.loop as import("@mendcode/protocol").Loop } : reply
    },
    async automationLedger(scope: import("@mendcode/protocol").LedgerScope, ownerId: string, operation: "events" | "artifacts" | "receipt", query: import("@mendcode/protocol").LedgerQuery = {}): Promise<{ ok: true; ledger: import("@mendcode/protocol").LedgerPage } | { ok: false; error: ErrorPayload }> {
      const command = scope === "workflow" ? { type: `workflow.${operation}`, workflowId: ownerId, ...query } : { type: `loop.${operation}`, loopId: ownerId, ...query }
      const reply = await request({ ...command, id: ids("command"), clientId } as Command, true)
      return reply.ok ? { ok: true, ledger: reply.result?.ledger as import("@mendcode/protocol").LedgerPage } : reply
    },
    async exportAutomation(scope: import("@mendcode/protocol").LedgerScope, ownerId: string, format: "json" | "markdown" = "json", query: import("@mendcode/protocol").LedgerQuery = {}): Promise<{ ok: true; export: import("@mendcode/protocol").LedgerExport } | { ok: false; error: ErrorPayload }> {
      const command = scope === "workflow" ? { type: "workflow.export", workflowId: ownerId, format, ...query } : { type: "loop.export", loopId: ownerId, format, ...query }
      const reply = await request({ ...command, id: ids("command"), clientId } as Command, true)
      return reply.ok ? { ok: true, export: reply.result?.export as import("@mendcode/protocol").LedgerExport } : reply
    },
    async promoteEvolution(input: Omit<Extract<CommandInput, { type: "evolution.promote" }>, "type">): Promise<{ ok: true; suggestion: import("@mendcode/protocol").EvolutionSuggestion; path: string } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "evolution.promote", ...input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, suggestion: reply.result?.suggestion as import("@mendcode/protocol").EvolutionSuggestion, path: String(reply.result?.path) } : reply
    },
    async rollbackEvolution(input: Omit<Extract<CommandInput, { type: "evolution.rollback" }>, "type">): Promise<{ ok: true; suggestion: import("@mendcode/protocol").EvolutionSuggestion } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "evolution.rollback", ...input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, suggestion: reply.result?.suggestion as import("@mendcode/protocol").EvolutionSuggestion } : reply
    },
    async compactionConfig(): Promise<{ ok: true; config: import("@mendcode/protocol").CompactionConfig } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "settings.get", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, config: (reply.result?.settings as import("@mendcode/protocol").Settings | undefined)?.compaction ?? {} } : reply
    },
    setCompactionConfig(config: import("@mendcode/protocol").CompactionConfig | null): Promise<CommandReply> {
      return request({ type: "settings.set", id: ids("command"), clientId, patch: { compaction: config } }, true)
    },
    async cacheStatus(input: import("@mendcode/protocol").CacheTarget): Promise<{ ok: true; report: import("@mendcode/protocol").CacheStatus } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "cache.status", ...input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").CacheStatus } : reply
    },
    async setCache(input: import("@mendcode/protocol").CacheMutation): Promise<{ ok: true; report: import("@mendcode/protocol").CacheStatus } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "cache.set", input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as import("@mendcode/protocol").CacheStatus } : reply
    },
    async compound(directory?: string, runId?: string): Promise<{ ok: true; report: import("@mendcode/protocol").CompoundReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "compound.get", ...(directory ? { directory } : {}), ...(runId ? { runId } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result?.report as import("@mendcode/protocol").CompoundReport } : reply
    },
    configureCompound(config: import("@mendcode/protocol").CompoundConfig, expectedHash: string): Promise<CommandReply> {
      return request({ type: "compound.configure", config, expectedHash, id: ids("command"), clientId }, true)
    },
    startCompound(input: import("@mendcode/protocol").CompoundRunInput): Promise<CommandReply> {
      return request({ type: "compound.start", input, id: ids("command"), clientId }, true)
    },
    cancelCompound(runId: string): Promise<CommandReply> {
      return request({ type: "compound.cancel", runId, id: ids("command"), clientId }, true)
    },
    deleteMessage(sessionId: SessionId, messageId: import("@mendcode/protocol").ItemId, expectedRevision = 0) {
      return request({ type: "session.message.delete", sessionId, messageId, expectedRevision, id: ids("command"), clientId }, true)
    },
    deletePart(sessionId: SessionId, messageId: import("@mendcode/protocol").ItemId, partId: import("@mendcode/protocol").MessagePart["id"], expectedRevision = 0) {
      return request({ type: "session.part.delete", sessionId, messageId, partId, expectedRevision, id: ids("command"), clientId }, true)
    },
    updatePart(sessionId: SessionId, messageId: import("@mendcode/protocol").ItemId, part: import("@mendcode/protocol").MessagePart, expectedRevision = 0) {
      return request({ type: "session.part.update", sessionId, messageId, partId: part.id, part, expectedRevision, id: ids("command"), clientId }, true)
    },
    async packageCatalog(directory: string, query = "", sourceId?: string): Promise<{ ok: true; report: import("@mendcode/protocol").PackageCatalogReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "packages.search", id: ids("command"), clientId, directory, query, ...(sourceId ? { sourceId } : {}) }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").PackageCatalogReport } : reply
    },
    async packagePreview(directory: string, sourceId: string, name?: string, scope: "user" | "project" = "user"): Promise<{ ok: true; report: import("@mendcode/protocol").PackagePreviewReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "packages.preview", id: ids("command"), clientId, directory, sourceId, scope, ...(name ? { name } : {}) }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").PackagePreviewReport } : reply
    },
    async authorPackage(directory: string, action: "create" | "update", options: Omit<Extract<CommandInput, { type: "packages.create" }>, "type" | "directory"> = {}): Promise<{ ok: true; report: import("@mendcode/protocol").PackageAuthoringReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: action === "create" ? "packages.create" : "packages.update", id: ids("command"), clientId, directory, ...options }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").PackageAuthoringReport } : reply
    },
    async deleteLocalPackage(directory: string): Promise<{ ok: true; report: import("@mendcode/protocol").PackageDeleteLocalReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "packages.delete-local", id: ids("command"), clientId, directory }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").PackageDeleteLocalReport } : reply
    },
    installPlugin(directory: string, spec: string, options: { global?: boolean; force?: boolean } = {}) {
      return request({ type: "plugins.install", directory, spec, ...options, id: ids("command"), clientId }, true)
    },
    pluginAuthMethods(directory: string) {
      return request({ type: "plugins.auth-methods", directory, id: ids("command"), clientId }, true)
    },
    startPluginAuth(directory: string, provider: string, method: number, inputs: Record<string, string> = {}) {
      return request({ type: "plugins.auth-start", directory, provider, method, inputs, id: ids("command"), clientId }, true)
    },
    completePluginAuth(directory: string, flowId: string, code?: string) {
      return request({ type: "plugins.auth-complete", directory, flowId, ...(code ? { code } : {}), id: ids("command"), clientId }, true)
    },
    workspaces(operation: "list" | "adapters" | "status" = "list") {
      return request({ type: "workspace.query", operation, id: ids("command"), clientId }, true)
    },
    registerWorkspace(name: string, directory: string) {
      return request({ type: "workspace.create", adapter: "local", name, directory, id: ids("command"), clientId }, true)
    },
    removeWorkspace(workspaceId: string) {
      return request({ type: "workspace.remove", workspaceId, id: ids("command"), clientId }, true)
    },
    restSessions(directory: string, input: import("@mendcode/protocol").RestReadInput) {
      return request({ type: "session.rest.read", directory, input, id: ids("command"), clientId }, true)
    },
    updateRestSession(sessionId: SessionId, patch: import("@mendcode/protocol").SessionRestUpdate["patch"]) {
      return request({ type: "session.rest.update", sessionId, patch, id: ids("command"), clientId }, true)
    },
    controlRestSession(sessionId: SessionId, input: Omit<Extract<CommandInput, { type: "session.rest.control" }>, "type" | "sessionId">) {
      return request({ type: "session.rest.control", sessionId, ...input, id: ids("command"), clientId }, true)
    },
    mutateRestSession(sessionId: SessionId, input: Omit<Extract<CommandInput, { type: "session.rest.mutate" }>, "type" | "sessionId">) {
      return request({ type: "session.rest.mutate", sessionId, ...input, id: ids("command"), clientId }, true)
    },
    async providerAuthMethods(provider?: string) {
      const reply = await request({ type: "providers.auth.methods", id: ids("command"), clientId, ...(provider ? { provider } : {}) }, true)
      return reply.ok ? { ok: true as const, methods: reply.result?.methods as Record<string, import("@mendcode/protocol").ProviderAuthMethod[]> } : reply
    },
    async providerAuthStatus(provider?: string) {
      const reply = await request({ type: "providers.auth.status", id: ids("command"), clientId, ...(provider ? { provider } : {}) }, true)
      return reply.ok ? { ok: true as const, statuses: reply.result?.statuses as import("@mendcode/protocol").ProviderAuthStatus[] } : reply
    },
    async providerLoginPlan(provider: string, method?: string) {
      const reply = await request({ type: "providers.auth.plan", id: ids("command"), clientId, provider, ...(method ? { method } : {}) }, true)
      return reply.ok ? { ok: true as const, plan: reply.result?.plan as import("@mendcode/protocol").ProviderLoginPlan } : reply
    },
    async authorizeProvider(provider: string, method?: string) {
      const reply = await request({ type: "providers.auth.authorize", id: ids("command"), clientId, provider, ...(method ? { method } : {}) }, true)
      return reply.ok ? { ok: true as const, authorization: reply.result?.authorization as import("@mendcode/protocol").ProviderAuthorization } : reply
    },
    async providerAuthAction(provider: string, action: "cancel" | "refresh" | "logout") {
      const reply = await request({ type: "providers.auth.action", id: ids("command"), clientId, provider, action }, true)
      return reply.ok ? { ok: true as const, status: reply.result?.status as import("@mendcode/protocol").ProviderAuthStatus } : reply
    },
    async providerMetadataLogin(url: string, execute = false) {
      return request({ type: "providers.auth.metadata", id: ids("command"), clientId, url, execute }, true)
    },
    async reasoningStatus(directory: string, sessionId?: SessionId): Promise<{ ok: true; report: import("@mendcode/protocol").ReasoningReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "reasoning.status", directory, ...(sessionId ? { sessionId } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").ReasoningReport } : reply
    },
    async configureReasoning(directory: string, config: import("@mendcode/protocol").ReasoningPolicy, expectedRevision: string, confirm: true): Promise<{ ok: true; report: import("@mendcode/protocol").ReasoningReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "reasoning.configure", directory, config, expectedRevision, confirm, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").ReasoningReport } : reply
    },
    async daemonStatus(): Promise<{ ok: true; report: import("@mendcode/protocol").DaemonStatusReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "daemon.status", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").DaemonStatusReport } : reply
    },
    async activityAudio(action: "start" | "stop" | "pulse", scale?: number) {
      return request({ type: "audio.play", action, ...(scale === undefined ? {} : { scale }), id: ids("command"), clientId })
    },
    async daemonLogs(lines = 100): Promise<{ ok: true; report: import("@mendcode/protocol").DaemonLogsReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "daemon.logs", lines, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").DaemonLogsReport } : reply
    },
    async configureTrace(enabled: boolean) {
      const reply = await request({ type: "trace.configure", enabled, id: ids("command"), clientId }, true)
      if (reply.ok) tracing = enabled
      return reply
    },
    async traces(sessionId?: SessionId, limit?: number): Promise<{ ok: true; report: import("@mendcode/protocol").TraceReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "trace.query", ...(sessionId ? { sessionId } : {}), ...(limit === undefined ? {} : { limit }), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").TraceReport } : reply
    },
    recordTrace,
    async tsm(directory: string, query: import("@mendcode/protocol").TsmRead = { operation: "status" }): Promise<{ ok: true; report: import("@mendcode/protocol").TsmReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "tsm.query", directory, query, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").TsmReport } : reply
    },
    async changeTsm(directory: string, change: import("@mendcode/protocol").TsmChange): Promise<{ ok: true; report: import("@mendcode/protocol").TsmReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "tsm.change", directory, change, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").TsmReport } : reply
    },
    async imageGeneration(settings?: import("@mendcode/protocol").ImageGenerationSettings | null): Promise<{ ok: true; settings: import("@mendcode/protocol").ImageGenerationSettings | undefined } | { ok: false; error: ErrorPayload }> {
      const command: CommandInput = settings === undefined ? { type: "settings.get" } : { type: "settings.set", patch: { image_generation: settings } }
      const reply = await request({ ...command, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, settings: (reply.result?.settings as import("@mendcode/protocol").Settings)?.image_generation } : reply
    },
    async installGithub(directory: string, input: import("@mendcode/protocol").GithubInstallInput) {
      const reply = await request({ type: "github.install", directory, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol").GithubInstallReport } : reply
    },
    async runGithub(directory: string, input: import("@mendcode/protocol").GithubRunInput, choice?: import("@mendcode/protocol").ModelChoice) {
      const reply = await request({ type: "github.run", directory, input, ...(choice ? { choice } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol").GithubRunReport } : reply
    },
    async finishGithub(runId: string, status: import("@mendcode/protocol").GithubFinishReport["status"]) {
      const reply = await request({ type: "github.finish", runId, status, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol").GithubFinishReport } : reply
    },
    async checkoutPr(directory: string, number: number, token?: string) {
      const reply = await request({ type: "pr.checkout", directory, number, ...(token ? { token } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol").PrCheckoutReport } : reply
    },
    async ideContext(directory: string): Promise<{ ok: true; report: import("@mendcode/protocol/wire").IdeReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "ide.query", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol/wire").IdeReport } : reply
    },
    async configureIde(directory: string, enabled: boolean, dbPath?: string, editor?: "zed" | "vscode"): Promise<{ ok: true; report: import("@mendcode/protocol/wire").IdeReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "ide.configure", directory, enabled, ...(editor ? { editor } : {}), ...(dbPath ? { dbPath } : {}), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol/wire").IdeReport } : reply
    },
    async openIdeFile(directory: string, filePath: string, line = 1, character = 1): Promise<{ ok: true; report: import("@mendcode/protocol/wire").IdeOpenReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "ide.open", directory, filePath, line, character, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol/wire").IdeOpenReport } : reply
    },
    async computerCapture(sessionId: SessionId, input: import("@mendcode/protocol/wire").ComputerCaptureInput = {}): Promise<{ ok: true; capture: import("@mendcode/protocol/wire").ComputerCaptureReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "computer.capture", sessionId, input, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, capture: reply.result as unknown as import("@mendcode/protocol/wire").ComputerCaptureReport } : reply
    },
    async computerKey(sessionId: SessionId, input: import("@mendcode/protocol/wire").ComputerKeyInput): Promise<{ ok: true; key: import("@mendcode/protocol/wire").ComputerKeyReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "computer.key", sessionId, input, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, key: reply.result as unknown as import("@mendcode/protocol/wire").ComputerKeyReport } : reply
    },
    async computerSession(sessionId: SessionId, input: import("@mendcode/protocol/wire").ComputerSessionInput): Promise<{ ok: true; session: import("@mendcode/protocol/wire").ComputerSessionReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "computer.session", sessionId, input, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, session: reply.result as unknown as import("@mendcode/protocol/wire").ComputerSessionReport } : reply
    },
    async computerObserve(sessionId: SessionId, input: import("@mendcode/protocol/wire").ComputerObserveInput): Promise<{ ok: true; observation: import("@mendcode/protocol/wire").ComputerObservation } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "computer.observe", sessionId, input, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, observation: reply.result as unknown as import("@mendcode/protocol/wire").ComputerObservation } : reply
    },
    async computerCode(sessionId: SessionId, input: import("@mendcode/protocol/wire").ComputerCodeInput): Promise<{ ok: true; execution: import("@mendcode/protocol/wire").ComputerCodeReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "computer.code", sessionId, input, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, execution: reply.result as unknown as import("@mendcode/protocol/wire").ComputerCodeReport } : reply
    },
    async mflow(directory: string, query: import("@mendcode/protocol").MflowRead = { operation: "status" }): Promise<{ ok: true; report: import("@mendcode/protocol").MflowReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "mflow.query", directory, query, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").MflowReport } : reply
    },
    async changeMflow(directory: string, change: import("@mendcode/protocol").MflowChange): Promise<{ ok: true; report: import("@mendcode/protocol").MflowReport } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "mflow.change", directory, change, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, report: reply.result as unknown as import("@mendcode/protocol").MflowReport } : reply
    },
    async console() {
      const reply = await request({ type: "console.get", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol").ConsoleReport } : reply
    },
    async consoleOrgs() {
      const reply = await request({ type: "console.listOrgs", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, orgs: reply.result?.orgs as import("@mendcode/protocol").ConsoleOrg[] } : reply
    },
    switchConsoleOrg(accountID: string, orgID: string) {
      return request({ type: "console.switchOrg", accountID, orgID, id: ids("command"), clientId }, true)
    },
    async sessionShare(sessionId: SessionId, action: "get" | "create" | "sync" | "remove" = "get") {
      const type = ({ get: "session.share.get", create: "session.share", sync: "session.share.sync", remove: "session.unshare" } as const)[action]
      const reply = await request({ type, sessionId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, share: reply.result as unknown as import("@mendcode/protocol").SessionShare } : reply
    },
    /** Console-free share: a local HTML page or a secret gist; `confirm` is required to create a gist. */
    async staticShare(sessionId: SessionId, target: "local" | "gist", action: "create" | "status" | "remove" = "status", confirm?: boolean) {
      const reply = await request({ type: "session.share.static", sessionId, target, action, ...(confirm === undefined ? {} : { confirm }), id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, share: reply.result as unknown as import("@mendcode/protocol").StaticShare } : reply
    },
    async mflowLease(directory: string, lease: import("@mendcode/protocol").MflowLease): Promise<{ ok: true; lease: import("@mendcode/protocol").MflowLeaseResult } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "mflow.lease", directory, lease, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, lease: reply.result as unknown as import("@mendcode/protocol").MflowLeaseResult } : reply
    },
    /** Full-authority v2 catalog/auth control used by the opt-in REST compatibility adapter. */
    async restCatalog(directory: string, input: import("@mendcode/protocol").CatalogRestInput) {
      return request({ type: "catalog.rest", directory, input, id: ids("command"), clientId }, false)
    },
    registerTuiControl(directory: string, enabled = true) {
      return request({ type: "tui.control.register", directory, enabled, id: ids("command"), clientId }, false)
    },
    sendTuiControl(directory: string, action: import("@mendcode/protocol").TuiRequestInput) {
      return request({ type: "tui.control.send", directory, request: action, id: ids("command"), clientId }, false)
    },
    async nextTuiControl(directory: string, timeoutMs = 25_000): Promise<{ ok: true; request: import("@mendcode/protocol").TuiRequest | null } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "tui.control.next", directory, timeoutMs, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true, request: reply.result?.request as import("@mendcode/protocol").TuiRequest | null } : reply
    },
    restProject(directory: string, input: import("@mendcode/protocol").ProjectRestInput) {
      return request({ type: "project.rest", directory, input, id: ids("command"), clientId }, false)
    },
    respondTuiControl(directory: string, requestID: import("@mendcode/protocol").CommandId, response: boolean) {
      return request({ type: "tui.control.response", directory, requestID, response, id: ids("command"), clientId }, false)
    },
    async pendingInteractions(directory: string, kind: import("@mendcode/protocol").InteractionKind) {
      const reply = await request({ type: "interaction.list", directory, kind, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, requests: reply.result?.requests as import("@mendcode/protocol").InteractionReport["requests"] } : reply
    },
    async memorySideChat(directory: string, payload: import("@mendcode/protocol").MemorySideChatPayload) {
      const reply = await request({ type: "memory.side-chat", directory, payload, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, response: reply.result as unknown as import("@mendcode/protocol").MemorySideChatResponse } : reply
    },
    async filesApi<T extends import("@mendcode/protocol").FileRestInput>(directory: string, input: T): Promise<{ ok: true; value: import("@mendcode/protocol").FileRestValues[T["operation"]] } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "file.rest.read", directory, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, value: reply.result?.value as import("@mendcode/protocol").FileRestValues[T["operation"]] } : reply
    },
    /** Exact-text read and compare-and-swap write; the server refuses it unless started with `--edit`. */
    async fileEdit(directory: string, input: import("@mendcode/protocol").FileEditInput): Promise<{ ok: true; value: import("@mendcode/protocol").FileEditResult } | { ok: false; error: ErrorPayload }> {
      const reply = await request({ type: "file.edit", directory, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true, value: reply.result as unknown as import("@mendcode/protocol").FileEditResult } : reply
    },
    async ptyShells(directory: string) {
      const reply = await request({ type: "pty.shells", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, shells: reply.result?.shells as import("@mendcode/protocol").PtyShell[] } : reply
    },
    async ptyList(directory: string) {
      const reply = await request({ type: "pty.list", directory, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, ptys: reply.result?.ptys as import("@mendcode/protocol").PtyInfo[] } : reply
    },
    async ptyCreate(directory: string, input: import("@mendcode/protocol").PtyCreateInput = {}) {
      const reply = await request({ type: "pty.create", directory, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, pty: reply.result?.pty as import("@mendcode/protocol").PtyInfo } : reply
    },
    async ptyGet(directory: string, ptyId: string) {
      const reply = await request({ type: "pty.get", directory, ptyId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, pty: reply.result?.pty as import("@mendcode/protocol").PtyInfo } : reply
    },
    async ptyUpdate(directory: string, ptyId: string, input: import("@mendcode/protocol").PtyUpdateInput) {
      const reply = await request({ type: "pty.update", directory, ptyId, input, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, pty: reply.result?.pty as import("@mendcode/protocol").PtyInfo } : reply
    },
    ptyRemove(directory: string, ptyId: string) {
      return request({ type: "pty.remove", directory, ptyId, id: ids("command"), clientId }, true)
    },
    async ptyConnectToken(directory: string, ptyId: string) {
      const reply = await request({ type: "pty.connect-token", directory, ptyId, id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, token: reply.result?.token as import("@mendcode/protocol").PtyConnectToken } : reply
    },
    async configureAzure(input: { provider?: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; models?: import("@mendcode/protocol").ProviderModel[]; azure?: import("@mendcode/protocol").AzureOptions; enabled?: boolean }) {
      const { provider = "azure", ...fields } = input
      const reply = await request({ type: "providers.set", provider, ...(provider !== "azure" ? { providerType: "azure" as const } : {}), ...fields, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureBedrock(input: { provider?: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; models?: import("@mendcode/protocol").ProviderModel[]; bedrock?: import("@mendcode/protocol").BedrockOptions; enabled?: boolean }) {
      const { provider = "amazon-bedrock", ...fields } = input
      const reply = await request({ type: "providers.set", provider, ...(provider !== "amazon-bedrock" ? { providerType: "amazon-bedrock" as const } : {}), ...fields, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureVertex(input: { provider?: string; baseUrl?: string; models?: import("@mendcode/protocol").ProviderModel[]; vertex?: import("@mendcode/protocol").VertexOptions; enabled?: boolean }) {
      const { provider = "google-vertex", ...fields } = input
      const reply = await request({ type: "providers.set", provider, ...(provider !== "google-vertex" ? { providerType: "google-vertex" as const } : {}), ...fields, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureVertexAnthropic(input: { provider?: string; baseUrl?: string; models?: import("@mendcode/protocol").ProviderModel[]; vertex?: import("@mendcode/protocol").VertexOptions; enabled?: boolean }) {
      const { provider = "google-vertex-anthropic", ...fields } = input
      const reply = await request({ type: "providers.set", provider, ...(provider !== "google-vertex-anthropic" ? { providerType: "google-vertex-anthropic" as const } : {}), ...fields, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureXai(input: { provider?: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; models?: import("@mendcode/protocol").ProviderModel[]; parameters?: import("@mendcode/protocol").ModelChoice["parameters"]; enabled?: boolean }) {
      const { provider = "xai", ...fields } = input
      const reply = await request({ type: "providers.set", provider, ...(provider !== "xai" ? { providerType: "xai" as const } : {}), ...fields, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureMistral(input: { provider?: string; baseUrl?: string; apiKey?: string; apiKeyEnv?: string; headers?: Record<string, string>; models?: import("@mendcode/protocol").ProviderModel[]; parameters?: import("@mendcode/protocol").ModelChoice["parameters"]; timeout?: number | false; chunkTimeout?: number | false; enabled?: boolean }) {
      const { provider = "mistral", ...fields } = input
      const reply = await request({ type: "providers.set", provider, ...(provider !== "mistral" ? { providerType: "mistral" as const } : {}), ...fields, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureDeepInfra(input: { baseUrl?: string; apiKey?: string; apiKeyEnv?: string; headers?: Record<string, string>; models?: import("@mendcode/protocol").ProviderModel[]; parameters?: import("@mendcode/protocol").ModelChoice["parameters"]; timeout?: number | false; chunkTimeout?: number | false; enabled?: boolean }) {
      const reply = await request({ type: "providers.set", provider: "deepinfra", ...input, id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureGitLab(input: Omit<Extract<CommandInput, { type: "providers.set" }>, "type" | "provider" | "providerType">) {
      const reply = await request({ type: "providers.set", ...input, provider: "gitlab", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureCloudflareWorkersAI(input: Omit<Extract<CommandInput, { type: "providers.set" }>, "type" | "provider" | "providerType">) {
      const reply = await request({ type: "providers.set", ...input, provider: "cloudflare-workers-ai", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureCerebras(input: Omit<Extract<CommandInput, { type: "providers.set" }>, "type" | "provider" | "providerType">) {
      const reply = await request({ type: "providers.set", ...input, provider: "cerebras", id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureCohere(input: Omit<Extract<CommandInput, { type: "providers.set" }>, "type" | "provider" | "providerType">) {
      const reply = await request({ type: "providers.set", ...input, provider: "cohere", id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async configureTogetherAI(input: Omit<Extract<CommandInput, { type: "providers.set" }>, "type" | "provider" | "providerType">) {
      const reply = await request({ type: "providers.set", ...input, provider: "togetherai", id: ids("command"), clientId }, false)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
    async consoleAccounts() {
      const reply = await request({ type: "console.accounts", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, report: reply.result as unknown as import("@mendcode/protocol").ConsoleReport } : reply
    },
    async configureCloudflareAIGateway(input: Omit<Extract<CommandInput, { type: "providers.set" }>, "type" | "provider" | "providerType">) {
      const reply = await request({ type: "providers.set", ...input, provider: "cloudflare-ai-gateway", id: ids("command"), clientId }, true)
      return reply.ok ? { ok: true as const, provider: reply.result?.provider as import("@mendcode/protocol").ProviderInfo } : reply
    },
  }
}
export type Client = ReturnType<typeof createClient>
export { connectPtySocket, ptyConnectUrl } from "./pty-socket"
export type { LoopbackAttach, LoopbackPeer } from "./loopback-socket"
