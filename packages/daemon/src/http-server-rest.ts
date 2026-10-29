import { MAX_FRAME_BYTES, ProcessMemory, RestConfig, RestLogInput, RestProjectConfig, RestUpgradeInput, RestUpgradeResult, type RestServerEvent } from "@mendcode/protocol"
import type { HttpBridge, HttpPeer } from "./http"

export function serverRestOpenApi() {
  const config = RestConfig.toJSONSchema({ io: "input" }), project = RestProjectConfig.toJSONSchema({ io: "input" })
  const boolean = { type: "boolean" }
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [route, method, operationId, payload, schema] of [
    ["/config", "get", "config.get", undefined, config], ["/config", "patch", "config.update", project, config],
    ["/log", "post", "app.log", RestLogInput.toJSONSchema(), boolean],
    ["/global/health", "get", "global.health", undefined, { type: "object", required: ["healthy", "version", "channel"], properties: { healthy: { const: true }, version: { type: "string" }, channel: { type: "string" } } }],
    ["/global/diagnostics/memory", "get", "global.diagnostics.memory", undefined, ProcessMemory.toJSONSchema()],
    ["/global/event", "get", "global.event", undefined, { type: "string" }],
    ["/global/config", "get", "global.config.get", undefined, config], ["/global/config", "patch", "global.config.update", config, config],
    ["/global/dispose", "post", "global.dispose", undefined, boolean],
    ["/global/upgrade", "post", "global.upgrade", RestUpgradeInput.toJSONSchema(), RestUpgradeResult.toJSONSchema()],
    ["/instance/dispose", "post", "instance.dispose", undefined, boolean],
  ] as const) {
    paths[route] ??= {}
    paths[route]![method] = {
      operationId,
      ...(route === "/config" || route === "/instance/dispose" || route === "/global/event" ? { parameters: [{ name: "directory", in: "query", schema: { type: "string" } }, { name: "workspace", in: "query", schema: { type: "string" } }] } : {}),
      ...(payload ? { requestBody: { required: true, content: { "application/json": { schema: payload } } } } : {}),
      responses: {
        "200": { description: "Success", content: { [route === "/global/event" ? "text/event-stream" : "application/json"]: { schema } } },
        "400": { description: "Invalid request or upgrade disabled" }, "401": { description: "Token required" }, "403": { description: "Full token required or workspace mismatch" },
        "409": { description: "Active instance work" }, "500": { description: "Update failed" }, "501": { description: "Configuration field has no v2 runtime equivalent" }, "503": { description: "Event stream limit" },
      },
    }
  }
  return paths
}

export function createHttpServerRest(input: {
  command(value: Record<string, unknown>, peer: HttpPeer, directory: string, signal: AbortSignal): Promise<Record<string, unknown>>
  body(request: Request): Promise<unknown>
  events: HttpBridge["events"]
  active(peer: HttpPeer): boolean
  streams: Set<() => void>
}) {
  const subscriptions = new Map<() => void, HttpPeer>()
  const encoder = new TextEncoder()
  function events(request: Request, peer: HttpPeer, directory?: string) {
    if (!input.events) return Response.json({ error: { code: "unsupported", message: "Global events unavailable" } }, { status: 501 })
    if (input.streams.size >= 128) return Response.json({ error: { code: "busy", message: "Event stream limit" } }, { status: 503 })
    let close = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false
        let release: (() => void) | undefined
        let heartbeat: ReturnType<typeof setInterval> | undefined
        close = () => {
          if (ended) return
          ended = true
          clearInterval(heartbeat)
          request.signal.removeEventListener("abort", close)
          release?.()
          subscriptions.delete(close)
          input.streams.delete(close)
          try { controller.close() } catch {}
        }
        const write = (event: RestServerEvent) => {
          if (ended) return
          if (!input.active(peer)) return close()
          const chunk = encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`)
          if (chunk.byteLength > MAX_FRAME_BYTES || (controller.desiredSize ?? 0) < chunk.byteLength) return close()
          try { controller.enqueue(chunk) } catch { close() }
        }
        input.streams.add(close)
        subscriptions.set(close, peer)
        if (request.signal.aborted) return close()
        request.signal.addEventListener("abort", close, { once: true })
        release = input.events!(peer, directory, write)
        write({ payload: { id: crypto.randomUUID(), type: "server.connected", properties: {} } })
        if (ended) { release(); return }
        heartbeat = setInterval(() => write({ payload: { id: crypto.randomUUID(), type: "server.heartbeat", properties: {} } }), 10_000)
        heartbeat.unref()
      },
      cancel() { close() },
    }, { highWaterMark: 512 * 1024, size: (chunk) => chunk?.byteLength ?? 0 })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" } })
  }
  return {
    sweep() { for (const [close, peer] of subscriptions) if (!input.active(peer)) close() },
    async route(request: Request, url: URL, peer: HttpPeer, directory: string): Promise<Response | undefined> {
      if (!["/config", "/log", "/global/health", "/global/diagnostics/memory", "/global/event", "/global/config", "/global/dispose", "/global/upgrade", "/instance/dispose"].includes(url.pathname)) return undefined
      const json = (body: unknown, status = 200) => Response.json(body, { status })
      if (peer.readOnly && !["/global/health", "/global/diagnostics/memory"].includes(url.pathname)) return json({ error: { code: "forbidden", message: "Full token required" } }, 403)
      const call = (value: Record<string, unknown>) => input.command(value, peer, directory, request.signal)
      const body = () => request.body ? input.body(request) : Promise.resolve({})
      try {
        const route = url.pathname
        if (request.method === "GET") {
          if (route === "/global/health") return json(await call({ type: "server.health" }))
          if (route === "/global/diagnostics/memory") return json(await call({ type: "server.memory" }))
          if (route === "/global/event") {
            const selected = request.headers.has("x-opencode-directory") || request.headers.has("x-mendcode-workspace") || url.searchParams.has("directory") || url.searchParams.has("workspace")
            return events(request, peer, selected ? directory : undefined)
          }
          if (route === "/config" || route === "/global/config") return json((await call({ type: "server.config.get", ...(route === "/config" ? { directory } : {}) })).config)
        }
        if (request.method === "PATCH" && (route === "/config" || route === "/global/config")) {
          const value = await body()
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required")
          const schema = route === "/config" ? RestProjectConfig : RestConfig
          const parsed = schema.safeParse(value)
          if (!parsed.success) {
            const unsupported = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")
            return json({ error: { code: unsupported ? "unsupported" : "invalid_command", message: unsupported ? "Configuration field has no v2 runtime equivalent in this scope" : "Invalid configuration" } }, unsupported ? 501 : 400)
          }
          return json((await call({ type: "server.config.update", patch: parsed.data, ...(route === "/config" ? { directory } : {}) })).config)
        }
        if (request.method === "POST") {
          if (route === "/log") { await call({ type: "app.log", input: RestLogInput.parse(await body()) }); return json(true) }
          if (route === "/global/dispose" || route === "/instance/dispose") {
            const value = await body()
            if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length) throw new Error("empty body required")
            await call({ type: "server.dispose", ...(route === "/instance/dispose" ? { directory } : {}) })
            return json(true)
          }
          if (route === "/global/upgrade") {
            const result = RestUpgradeResult.parse((await call({ type: "server.upgrade", input: RestUpgradeInput.parse(await body()) })).upgrade)
            return json(result, result.success ? 200 : result.error.startsWith("Runtime upgrade is disabled") ? 400 : 500)
          }
        }
        return json({ error: { code: "not_found", message: "Unknown server route or method" } }, 404)
      } catch (error) {
        if (error instanceof Response) return error
        return url.pathname === "/global/upgrade" ? json({ success: false, error: "Invalid request body" }, 400) : json({ error: { code: "invalid_command", message: "Invalid server request" } }, 400)
      }
    },
  }
}
