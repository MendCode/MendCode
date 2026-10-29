import { Command, HttpServerConfig, MAX_FRAME_BYTES, PROTOCOL_VERSION, createIdFactory, parseCommand, type Frame, type RestServerEvent } from "@mendcode/protocol"
import { readFileSync } from "node:fs"
import path from "node:path"
import { remoteBackoff, remoteTokens } from "./remote"
import { createWorkspaces } from "./workspaces"
import { createHttpSessions, sessionRestOpenApi } from "./http-sessions"
import { createHttpServerRest, serverRestOpenApi } from "./http-server-rest"
import { createHttpCatalogRest, catalogRestOpenApi } from "./http-catalog-rest"
import { createHttpTui, tuiOpenApi } from "./http-tui"
import { createHttpProjectRest, projectRestOpenApi } from "./http-project-rest"
import { createHttpWorkflows, workflowRestOpenApi } from "./http-workflows"
import { createHttpInteractions, interactionRestOpenApi } from "./http-interactions"
import { createHttpFiles, fileRestOpenApi } from "./http-files"
import { createHttpPty, ptyConnectPath, ptyErrorResponse, ptyOpenApi } from "./http-pty"
import type { PtyConnection, PtySocket } from "./pty"
import { createHttpConsole, consoleOpenApi } from "./http-console"
import { DEV_VERSION } from "@mendcode/program"

export type HttpPeer = { name: string; hash: string; readOnly: boolean }
export type HttpBridge = {
  request(command: Command, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Frame>
  stream(peer: HttpPeer, directory: string, write: (data: Uint8Array) => number, end: () => void): { receive(data: Uint8Array): void; close(): void }
  events?(peer: HttpPeer, directory: string | undefined, write: (event: RestServerEvent) => void): () => void
  pty?: {
    consume(directory: string, id: string, ticket: string): HttpPeer | undefined
    connect(peer: HttpPeer, directory: string, id: string, socket: PtySocket, cursor: number): PtyConnection
  }
}
export type HttpSocketData = { peer: HttpPeer; directory: string; stream?: ReturnType<HttpBridge["stream"]>; pty?: { id: string; cursor: number; connection?: PtyConnection } }
export type HttpOptions = Partial<HttpServerConfig>
export function httpConfig(dir: string, flags: HttpOptions = {}): HttpServerConfig {
  let value: unknown = {}
  try { value = JSON.parse(readFileSync(path.join(dir, "remote.json"), "utf8")).server ?? {} } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("invalid remote.json server")
  }
  const parsed = HttpServerConfig.safeParse({ ...(value as object), ...flags })
  if (!parsed.success) throw new Error("invalid HTTP server configuration (loopback only)")
  if (parsed.data.mdns) throw new Error("mDNS is unavailable for the loopback server; remove server.mdns or set it to false")
  for (const origin of parsed.data.cors) {
    const url = new URL(origin)
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("CORS entries must be exact HTTP origins")
  }
  return { ...parsed.data, hostname: parsed.data.hostname === "localhost" ? "127.0.0.1" : parsed.data.hostname }
}

/** This is the v2 adapter contract. Compatibility REST groups can add routes without another runtime. */
export function httpOpenApi() {
  const endpoint = (id: string, status = "200") => ({ operationId: id, responses: { [status]: { description: "Success" }, "400": { description: "Invalid request" }, "401": { description: "Token required" }, "403": { description: "Forbidden" } } })
  const { "/command": catalogCommands, ...catalogPaths } = catalogRestOpenApi()
  return {
    openapi: "3.1.0", info: { title: "MendCode", version: DEV_VERSION },
    security: [{ token: [] }, { basicToken: [] }],
    components: { securitySchemes: { token: { type: "http", scheme: "bearer" }, basicToken: { type: "http", scheme: "basic", description: "Password is a MendCode remote token" }, ptyTicket: { type: "apiKey", in: "query", name: "ticket", description: "Single-use, owner-bound PTY ticket; 60 second lifetime" } }, schemas: { Command: Command.toJSONSchema({ io: "input" }) } },
    paths: {
      "/global/health": { get: endpoint("global.health") },
      "/command": { ...catalogCommands, post: { ...endpoint("command.execute"), parameters: [{ name: "x-opencode-directory", in: "header", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Command" } } } } } },
      "/wire": { get: endpoint("wire.upgrade", "101") },
      "/event": { post: { ...endpoint("event.subscribe"), responses: { "200": { description: "Hello JSON or newline SSE frames", content: { "text/event-stream": { schema: { type: "string" } }, "application/json": { schema: { type: "object" } } } } } } },
      "/experimental/workspace": { get: endpoint("experimental.workspace.list"), post: endpoint("experimental.workspace.create") },
      "/experimental/workspace/adapter": { get: endpoint("experimental.workspace.adapter.list") },
      "/experimental/workspace/status": { get: endpoint("experimental.workspace.status") },
      "/experimental/workspace/{id}": { delete: { ...endpoint("experimental.workspace.remove"), parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
      ...sessionRestOpenApi(),
      ...serverRestOpenApi(),
      ...catalogPaths,
      ...tuiOpenApi(),
      ...projectRestOpenApi(),
      ...workflowRestOpenApi(),
      ...interactionRestOpenApi(),
      ...fileRestOpenApi(),
      ...ptyOpenApi(),
      ...consoleOpenApi(),
    },
  }
}

export function createHttpAdapter(input: { dir: string; directory: string; config: HttpServerConfig; bridge: HttpBridge; buildId?: string | undefined; web?: string | undefined; workspaces?: ReturnType<typeof createWorkspaces> }) {
  const tokens = remoteTokens(input.dir)
  const backoff = remoteBackoff()
  const workspaces = input.workspaces ?? createWorkspaces(input.dir, input.directory)
  const ids = createIdFactory()
  const clientId = ids("client")
  const encoder = new TextEncoder()
  const sockets = new Set<Bun.ServerWebSocket<HttpSocketData>>()
  const streams = new Set<() => void>()
  const cors = new Set(input.config.cors)
  const json = (body: unknown, status = 200) => Response.json(body, { status })
  function authenticate(request: Request, address: string) {
    if (backoff.blocked(address)) return undefined
    const authorization = request.headers.get("authorization") ?? ""
    let token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
    if (authorization.startsWith("Basic ")) {
      try {
        const basic = Buffer.from(authorization.slice(6), "base64").toString("utf8")
        const colon = basic.indexOf(":")
        if (basic.slice(0, colon) === input.config.username) token = basic.slice(colon + 1)
      } catch {}
    }
    let peer: HttpPeer | undefined
    if (token && token.length <= 4096) try { peer = tokens.authenticate(token) } catch {}
    if (!peer) backoff.fail(address)
    return peer
  }
  function active(peer: HttpPeer) {
    try { return tokens.active(peer) } catch { return false }
  }
  async function body(request: Request) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON content type required")
    const reader = request.body?.getReader()
    if (!reader) throw new Error("JSON body required")
    let size = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_FRAME_BYTES) { await reader.cancel(); throw new Error("body too large") }
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  }
  async function execute(command: unknown, peer: HttpPeer, directory: string, signal: AbortSignal) {
    const parsed = parseCommand(command)
    if (!parsed.success || parsed.data.type === "hello" || parsed.data.type.startsWith("client.")) return json({ error: { code: "invalid_command", message: "invalid HTTP command" } }, 400)
    const frame = await input.bridge.request(parsed.data, peer, directory, signal)
    if (frame.kind === "error") return json({ error: frame.error }, frame.error.code === "unsupported" ? 501 : frame.error.code === "forbidden" || frame.error.code === "target_mismatch" ? 403 : frame.error.code === "unknown_session" ? 404 : frame.error.code === "busy" ? 409 : 400)
    if (frame.kind !== "ack") return json({ error: { code: "internal", message: "invalid daemon reply" } }, 500)
    return json(frame.result ?? {})
  }
  const sessions = createHttpSessions({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const serverRest = createHttpServerRest({ body, active, streams, events: input.bridge.events, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const catalogRest = createHttpCatalogRest({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const pty = createHttpPty({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const workflows = createHttpWorkflows({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const tui = createHttpTui({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const interactions = createHttpInteractions({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const projects = createHttpProjectRest({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  const files = createHttpFiles({ command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  function resolveDirectory(request: Request, url: URL) {
    return workspaces.resolve({ directory: request.headers.get("x-opencode-directory") ?? url.searchParams.get("directory") ?? undefined, workspaceId: request.headers.get("x-mendcode-workspace") ?? url.searchParams.get("workspace") ?? undefined })
  }
  const consoleRest = createHttpConsole({ body, command: async (value, peer, directory, signal) => {
    const response = await execute({ ...value, id: ids("command"), clientId }, peer, directory, signal)
    if (!response.ok) throw response
    return response.json()
  } })
  async function route(request: Request, server?: Bun.Server<HttpSocketData>) {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")
    // No ambient cookies: every call must carry a token. Still reject unapproved browser origins before auth.
    if (origin && origin !== url.origin && !cors.has(origin)) return json({ error: { code: "forbidden", message: "origin not allowed" } }, 403)
    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    const address = server?.requestIP(request)?.address ?? "local-adapter"
    if (backoff.blocked(address)) return json({ error: { code: "rate_limited", message: "auth rate limited" } }, 429)
    const connect = request.method === "GET" ? ptyConnectPath.exec(url.pathname) : null
    const ticket = connect ? url.searchParams.get("ticket") : null
    let selected: string | undefined
    let peer: HttpPeer | undefined
    const cursorValue = url.searchParams.get("cursor")
    const cursor = cursorValue === null ? 0 : Number(cursorValue)
    if (connect && (!Number.isSafeInteger(cursor) || cursor < -1 || cursorValue === "")) return json({ error: { code: "invalid_command", message: "Invalid PTY cursor" } }, 400)
    if (ticket) {
      try { selected = resolveDirectory(request, url) } catch { return json({ error: { code: "target_mismatch", message: "Unknown workspace" } }, 403) }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: { code: "upgrade_required", message: "WebSocket required" } }, 426)
      peer = input.bridge.pty?.consume(selected, connect![1]!, ticket)
      if (!peer || !active(peer)) { backoff.fail(address); return json({ error: { code: "forbidden", message: "Invalid PTY ticket" } }, 403) }
    } else peer = authenticate(request, address)
    if (!peer) return new Response(JSON.stringify({ error: { code: "unauthorized", message: "token required" } }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="MendCode", charset="UTF-8"' } })
    if (url.pathname === "/" && request.method === "GET" && input.web) return new Response(input.web, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${url.protocol === "https:" ? "wss" : "ws"}://${url.host}; base-uri 'none'; frame-ancestors 'none'` } })
    if (request.method === "GET" && (url.pathname === "/doc" || url.pathname === "/openapi.json")) return json(httpOpenApi())
    let directory: string
    try { directory = selected ?? resolveDirectory(request, url) } catch { return json({ error: { code: "target_mismatch", message: "unknown workspace or directory mismatch" } }, 403) }
    if (connect) {
      if (peer.readOnly) return json({ error: { code: "forbidden", message: "Full token required" } }, 403)
      const check = await execute({ type: "pty.get", ptyId: connect[1], directory, id: ids("command"), clientId }, peer, directory, request.signal)
      if (!check.ok) return ptyErrorResponse(check)
      if (sockets.size >= 128) return json({ error: { code: "busy", message: "Socket limit" } }, 409)
      if (server?.upgrade(request, { data: { peer, directory, pty: { id: connect[1]!, cursor } } })) return undefined
      return json({ error: { code: "upgrade_required", message: "WebSocket required" } }, 426)
    }
    if (url.pathname === "/wire" && request.method === "GET") {
      if (server?.upgrade(request, { data: { peer, directory } })) return undefined
      return json({ error: { code: "upgrade_required", message: "WebSocket required" } }, 426)
    }
    const base = { id: ids("command"), clientId }
    try {
      const ptyResponse = await pty(request, url, peer, directory)
      if (ptyResponse) return ptyResponse
      const serverResponse = await serverRest.route(request, url, peer, directory)
      if (serverResponse) return serverResponse
      const catalogResponse = await catalogRest(request, url, peer, directory)
      if (catalogResponse) return catalogResponse
      const tuiResponse = await tui(request, url, peer, directory)
      if (tuiResponse) return tuiResponse
      const projectResponse = await projects(request, url, peer, directory)
      if (projectResponse) return projectResponse
      const workflowResponse = await workflows(request, url, peer, directory)
      if (workflowResponse) return workflowResponse
      const interactionResponse = await interactions(request, url, peer, directory)
      if (interactionResponse) return interactionResponse
      const fileResponse = await files(request, url, peer, directory)
      if (fileResponse) return fileResponse
      const consoleResponse = await consoleRest(request, url, peer, directory)
      if (consoleResponse) return consoleResponse
      if (url.pathname === "/event" && request.method === "POST") {
        const value = await body(request)
        const hello = parseCommand({ ...base, clientId: value.clientId, type: "hello", protocolVersion: PROTOCOL_VERSION, client: { name: "mendcode-web", version: DEV_VERSION }, capabilities: [] })
        if (!hello.success || hello.data.type !== "hello") return json({ error: { code: "invalid_command", message: "invalid event client" } }, 400)
        if (value.hello === true) {
          const frame = await input.bridge.request(hello.data, peer, directory, request.signal)
          return frame.kind === "ack" ? json(frame.result) : json({ error: { code: "forbidden", message: "hello failed" } }, 403)
        }
        const subscribe = parseCommand({ ...base, id: ids("command"), clientId: value.clientId, type: "client.subscribe", sessionId: value.sessionId, afterSeq: value.afterSeq ?? 0 })
        if (!subscribe.success) return json({ error: { code: "invalid_command", message: "invalid subscription" } }, 400)
        if (streams.size >= 128) return json({ error: { code: "busy", message: "event stream limit" } }, 503)
        let close = () => {}
        const response = new ReadableStream<Uint8Array>({
          start(controller) {
            let ended = false
            let stream: ReturnType<HttpBridge["stream"]> | undefined
            let heartbeat: ReturnType<typeof setInterval> | undefined
            close = () => {
              if (ended) return
              ended = true
              clearInterval(heartbeat)
              request.signal.removeEventListener("abort", close)
              stream?.close()
              streams.delete(close)
              try { controller.close() } catch {}
            }
            const write = (data: Uint8Array) => {
              if (ended) return data.byteLength
              const lines = new TextDecoder().decode(data).split("\n").filter(Boolean)
              const chunk = encoder.encode(lines.map((line) => `data: ${line}\n\n`).join(""))
              if ((controller.desiredSize ?? 0) < chunk.byteLength) close()
              else controller.enqueue(chunk)
              return data.byteLength
            }
            stream = input.bridge.stream(peer, directory, write, close)
            streams.add(close)
            if (request.signal.aborted) return close()
            request.signal.addEventListener("abort", close, { once: true })
            heartbeat = setInterval(() => { if (!ended && (controller.desiredSize ?? 0) > 16) controller.enqueue(encoder.encode(": heartbeat\n\n")) }, 15_000)
            heartbeat.unref()
            stream.receive(encoder.encode(`${JSON.stringify({ v: PROTOCOL_VERSION, kind: "command", body: hello.data })}\n${JSON.stringify({ v: PROTOCOL_VERSION, kind: "command", body: subscribe.data })}\n`))
          },
          cancel() { close() },
        }, { highWaterMark: 4 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 })
        return new Response(response, { headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" } })
      }
      if (url.pathname === "/command" && request.method === "POST") return execute(await body(request), peer, directory, request.signal)
      const sessionResponse = await sessions(request, url, peer, directory)
      if (sessionResponse) return sessionResponse
      if (url.pathname === "/experimental/workspace" && request.method === "GET") return execute({ ...base, type: "workspace.query", operation: "list" }, peer, directory, request.signal)
      if (url.pathname === "/experimental/workspace/adapter" && request.method === "GET") return execute({ ...base, type: "workspace.query", operation: "adapters" }, peer, directory, request.signal)
      if (url.pathname === "/experimental/workspace/status" && request.method === "GET") return execute({ ...base, type: "workspace.query", operation: "status" }, peer, directory, request.signal)
      if (url.pathname === "/experimental/workspace" && request.method === "POST") return execute({ ...await body(request), ...base, type: "workspace.create" }, peer, directory, request.signal)
      const remove = /^\/experimental\/workspace\/(ws_[a-f0-9]{24})$/.exec(url.pathname)
      if (remove && request.method === "DELETE") return execute({ ...base, type: "workspace.remove", workspaceId: remove[1] }, peer, directory, request.signal)
    } catch { return json({ error: { code: "invalid_command", message: "invalid HTTP request" } }, 400) }
    return json({ error: { code: "not_found", message: "unknown route" } }, 404)
  }
  return {
    async fetch(request: Request, server?: Bun.Server<HttpSocketData>) {
      const response = await route(request, server)
      if (!response) return response
      const headers = new Headers(response.headers)
      headers.set("cache-control", "no-store")
      headers.set("x-content-type-options", "nosniff")
      const origin = request.headers.get("origin")
      headers.set("vary", "Origin")
      if (origin && (origin === new URL(request.url).origin || cors.has(origin))) {
        headers.set("access-control-allow-origin", origin)
        headers.set("access-control-allow-methods", "GET, POST, DELETE, PATCH, PUT, OPTIONS")
        headers.set("access-control-allow-headers", "Authorization, Content-Type, X-Opencode-Directory, X-Mendcode-Workspace, X-Mendcode-Ticket, X-Opencode-Ticket")
      }
      return new Response(response.body, { status: response.status, headers })
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws: Bun.ServerWebSocket<HttpSocketData>) {
        sockets.add(ws)
        if (!active(ws.data.peer)) return ws.close(1008, "token revoked")
        if (ws.data.pty) {
          try { ws.data.pty.connection = input.bridge.pty!.connect(ws.data.peer, ws.data.directory, ws.data.pty.id, { send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) }, ws.data.pty.cursor) }
          catch { ws.close(1008, "PTY unavailable") }
          return
        }
        ws.data.stream = input.bridge.stream(ws.data.peer, ws.data.directory, (data) => {
          const written = ws.send(data)
          if (written < 0) ws.close(1013, "slow client")
          return data.byteLength
        }, () => ws.close())
      },
      message(ws: Bun.ServerWebSocket<HttpSocketData>, message: string | Buffer) {
        if (!active(ws.data.peer)) return ws.close(1008, "token revoked")
        if (ws.data.pty) { ws.data.pty.connection?.message(typeof message === "string" ? message : new TextDecoder().decode(message)); return }
        ws.data.stream?.receive(typeof message === "string" ? encoder.encode(message) : message)
      },
      close(ws: Bun.ServerWebSocket<HttpSocketData>) { sockets.delete(ws); ws.data.stream?.close(); ws.data.pty?.connection?.close() },
    },
    sweep() { serverRest.sweep(); for (const ws of sockets) if (!active(ws.data.peer)) ws.close(1008, "token revoked") },
    close() { for (const close of streams) close(); for (const ws of sockets) { ws.data.stream?.close(); ws.data.pty?.connection?.close(); ws.close(1001, "server stopped") }; sockets.clear() },
  }
}
