import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import type { Clock, TurnInput } from "@mendcode/kernel"
import type { TaskInput } from "@mendcode/protocol"
import type { BridgeEngine } from "./thread-mcp-policy"
export { threadMcpEnabled } from "./thread-mcp-policy"
import type { ThreadPort, ThreadResult } from "@mendcode/tools"
import type { createOrchestrationReceipts } from "./orchestration-receipts"

const target = { sessionId: z.string().min(4).max(64) }
const paging = { limit: z.number().int().min(1).max(10).optional(), before: z.string().max(100).optional() }
const retry = { clientRequestId: z.string().min(1).max(128).optional() }
const schemas = {
  thread_list: z.strictObject({ limit: paging.limit }),
  thread_create: z.strictObject({ title: z.string().min(1).max(80), ...retry }),
  thread_message: z.strictObject({ ...target, text: z.string().min(1).max(8_000), ...retry }),
  thread_wait: z.strictObject({ ...target, timeoutSeconds: z.number().int().min(1).max(120).optional() }),
  thread_read: z.strictObject({ ...target, ...paging }),
  thread_search: z.strictObject({ ...target, ...paging, query: z.string().min(1).max(8_000) }),
  thread_interrupt: z.strictObject({ ...target, ...retry }),
  delegate_task: z.strictObject({
    description: z.string().min(1).max(80), prompt: z.string().min(1).max(20_000),
    engine: z.string().regex(/^(native|claude|codex|pi|acp:[a-zA-Z0-9_.-]+)$/).optional(),
    model: z.string().min(1).max(200).optional(), variant: z.string().min(1).max(80).optional(),
    agent: z.string().min(1).max(64).optional(), background: z.boolean().optional(),
    task_id: z.string().min(1).max(80).optional(),
    ...retry,
  }),
  orchestrator_capabilities: z.strictObject({}),
}
type Name = keyof typeof schemas
const descriptions: Record<Name, string> = {
  thread_list: "List other local threads in this project. Use their exact ids.",
  thread_create: "Create an idle child thread in this project with inherited permissions. Use thread_message to start it.",
  thread_message: "Send a self-contained message to another project thread. Normal approvals and peer rate limits apply.",
  thread_wait: "Wait until a project thread is idle and read its latest answer. Timeout does not cancel it.",
  thread_read: "Read a bounded, redacted page of another project thread. Reasoning is excluded.",
  thread_search: "Search a bounded page of another project thread. Follow the before cursor for older history.",
  thread_interrupt: "Interrupt the running turn of another project thread.",
  delegate_task: "Start a child agent on any configured engine/model with fresh context and inherited permission ceiling. Default: async; background=false waits for completion. task_id continues a child you started, with its history; add model to go on with another model (after a usage limit, or a cheaper one).",
  orchestrator_capabilities: "Describe this process's project-scoped thread tools and limits.",
}
const tools = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name as Name], inputSchema: z.toJSONSchema(schema), annotations: { readOnlyHint: ["thread_list", "thread_read", "thread_search", "thread_wait", "orchestrator_capabilities"].includes(name) } }))

type Lease = {
  token: string
  turn: TurnInput
  born: number
  touched: number
  calls: number
  /** Calls running or waiting their turn; one runs at a time. */
  pending: number
  queue: Promise<void>
  retries: Map<string, { digest: string; result: ThreadResult }>
  controller: AbortController
  allowed(): boolean
  run(name: Name, args: Record<string, unknown>, signal: AbortSignal): Promise<ThreadResult>
  release(): void
}
const IDLE_MS = 10 * 60_000
const MAX_MS = 60 * 60_000
const MAX_BODY = 64 * 1024
const json = (body: unknown, status = 200) => Response.json(body, { status })
const content = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError })

/** Stateless Streamable HTTP MCP. Loaded on first opted-in turn; never mounted on the daemon's remote API. */
export function createThreadMcp(options: {
  clock: Clock
  /** Tests inject a listener without opening a socket. */
  listen?(handler: (request: Request) => Promise<Response>): { url: string; stop(): void }
}) {
  const leases = new Set<Lease>()
  let listener: { url: string; stop(): void } | undefined
  const valid = (lease: Lease) => leases.has(lease) && !lease.controller.signal.aborted && !lease.turn.signal.aborted && lease.allowed() && options.clock.now() - lease.born < MAX_MS && options.clock.now() - lease.touched < IDLE_MS

  async function handle(request: Request): Promise<Response> {
    // No browser origins, redirects, remote hosts or alternate routes: protects the localhost bearer boundary.
    if (!listener || request.url !== listener.url || request.headers.has("origin")) return new Response(null, { status: 403 })
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const bytes = Buffer.from(bearer)
    const lease = [...leases].find((entry) => bytes.length === entry.token.length && timingSafeEqual(bytes, Buffer.from(entry.token)))
    if (!lease || !valid(lease)) return new Response(null, { status: 401 })
    if (request.method === "GET") return new Response(null, { status: 405 })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 })
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response(null, { status: 413 })
    let body = ""
    const reader = request.body?.getReader()
    if (reader) {
      let bytes = 0
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_BODY) { await reader.cancel(); return new Response(null, { status: 413 }) }
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
    }
    let message: { jsonrpc?: string; id?: string | number; method?: string; params?: any }
    try { message = JSON.parse(body) } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }) }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number")) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } })
    if (!valid(lease)) return new Response(null, { status: 401 })
    lease.touched = options.clock.now()
    const reply = (result: unknown) => json({ jsonrpc: "2.0", id: message.id, result })
    const error = (code: number, text: string) => json({ jsonrpc: "2.0", id: message.id, error: { code, message: text } })
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === "initialize") return reply({ protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mendcode-threads", version: "1" } })
    if (message.method === "ping") return reply({})
    if (message.method === "tools/list") return reply({ tools })
    if (message.method !== "tools/call") return error(-32601, "Unknown method")
    const name = message.params?.name as Name
    if (typeof name !== "string" || !Object.hasOwn(schemas, name)) return error(-32602, "Unknown tool")
    const parsed = schemas[name].safeParse(JSON.parse(JSON.stringify(message.params?.arguments ?? {}).replaceAll(lease.token, "[redacted]")))
    if (!parsed.success) return error(-32602, "Invalid tool arguments")
    const retryId = "clientRequestId" in parsed.data ? parsed.data.clientRequestId : undefined
    const retryKey = typeof retryId === "string" ? `${name}:${retryId}` : undefined
    const digest = JSON.stringify(parsed.data)
    const previous = retryKey ? lease.retries.get(retryKey) : undefined
    if (previous && previous.digest !== digest) return error(-32602, "Conflicting clientRequestId")
    if (++lease.calls > 200) return reply(content("Bridge call limit reached: 200 calls in this turn", true))
    // One call runs at a time. Claude Code sends parallel tool calls together, so a call that comes while another runs waits its turn.
    const before = lease.queue
    let done!: () => void
    lease.queue = new Promise<void>((resolve) => { done = resolve })
    lease.pending++
    try {
      await before
      if (!valid(lease)) return reply(content("Bridge released or disabled", true))
      const result = await lease.run(name, parsed.data, lease.controller.signal)
      if (!valid(lease)) return reply(content("Bridge released or disabled", true))
      const text = result.ok ? result.output : result.message
      const output = content(text.replaceAll(lease.token, "[redacted]"), !result.ok)
      if (retryKey) lease.retries.set(retryKey, { digest, result: result.ok ? { ok: true, output: text.replaceAll(lease.token, "[redacted]") } : { ok: false, message: text.replaceAll(lease.token, "[redacted]") } })
      return reply(output)
    } catch (error) {
      // The cause goes back to the engine that called (a limit, an unknown task, a model that does not exist): "failed" alone left it guessing.
      const cause = (error instanceof Error ? error.message : String(error)).replaceAll(lease.token, "[redacted]").slice(0, 2_000)
      return reply(content(cause ? `Thread operation failed: ${cause}` : "Thread operation failed", true))
    }
    finally {
      lease.pending--
      done()
    }
  }

  return {
    handle,
    open(input: {
      engine: BridgeEngine
      turn: TurnInput
      allowed(): boolean
      threads: ThreadPort
      create(title: string): Promise<ThreadResult>
      delegate(args: TaskInput, signal: AbortSignal): Promise<ThreadResult>
      /** Normal host tool policy, including explicit deny; rechecked after approval. */
      authorize(name: string, args: Record<string, unknown>, read: boolean): Promise<boolean>
      receipts?: { project: string; run: ReturnType<typeof createOrchestrationReceipts>["run"] }
    }) {
      if (!input.allowed() || input.turn.signal.aborted) throw new Error("Bridge disabled or turn cancelled")
      listener ??= options.listen?.(handle) ?? (() => {
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_BODY, idleTimeout: 0, fetch: handle })
        return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => void server.stop(true) }
      })()
      const controller = new AbortController()
      let configDir: string | undefined
      const lease: Lease = {
        token: randomBytes(32).toString("hex"), turn: input.turn, born: options.clock.now(), touched: options.clock.now(), calls: 0, pending: 0, queue: Promise.resolve(), retries: new Map(), controller,
        allowed: input.allowed,
        async run(name, args, signal) {
          if (name === "orchestrator_capabilities") return { ok: true, output: "Local project only. create, message, wait, read, search, interrupt, delegate_task. Full tier; normal approvals; child permission ceiling; 10-minute idle / 1-hour maximum token lifetime. 200 calls per turn; calls sent together run one after another. delegate_task children: 4 running at once per agent and 16 in the conversation by default (the user changes both in /settings, Subagents); a limit error says the current number. No engine-internal child projection." }
          const read = name === "thread_list" || (["thread_read", "thread_search", "thread_wait"].includes(name) && input.threads.granted(String(args.sessionId)))
          if (!await input.authorize(name, args, read) || !valid(lease)) return { ok: false, message: "Thread operation denied" }
          const execute = async (): Promise<ThreadResult> => {
            switch (name) {
              case "thread_list": return input.threads.list(args.limit as number | undefined)
              case "thread_create": return input.create(String(args.title))
              case "thread_message": return input.threads.message(args as { sessionId: string; text: string })
              case "thread_read": return input.threads.read(args as { sessionId: string; limit?: number; before?: string })
              case "thread_search": return input.threads.search(args as { sessionId: string; query: string; limit?: number; before?: string })
              case "thread_wait": return input.threads.wait({ ...args as { sessionId: string; timeoutSeconds?: number }, signal })
              case "thread_interrupt": return input.threads.interrupt(args as { sessionId: string })
              case "delegate_task": return input.delegate({ ...args as TaskInput, background: args.background !== false }, signal)
            }
          }
          if (input.receipts && typeof args.clientRequestId === "string") return input.receipts.run({ project: input.receipts.project, owner: input.turn.sessionId, operation: name, requestId: args.clientRequestId, args, execute: async () => {
            const result = await execute()
            return result.ok ? { ok: true, output: result.output.replaceAll(lease.token, "[redacted]") } : { ok: false, message: result.message.replaceAll(lease.token, "[redacted]") }
          } })
          const previous = typeof args.clientRequestId === "string" ? lease.retries.get(`${name}:${args.clientRequestId}`) : undefined
          if (previous) return previous.result
          return execute()
        },
        release() {
          if (!leases.delete(lease)) return
          controller.abort()
          input.turn.signal.removeEventListener("abort", lease.release)
          expiry.cancel()
          if (configDir) rmSync(configDir, { recursive: true, force: true })
          if (!leases.size) { listener?.stop(); listener = undefined }
        },
      }
      leases.add(lease)
      const expiry = options.clock.setTimer(MAX_MS, () => lease.release())
      input.turn.signal.addEventListener("abort", lease.release, { once: true })
      try {
        let args: string[]
        const servers = [{ type: "http" as const, name: "mendcode_threads", url: listener.url, headers: [{ name: "Authorization", value: `Bearer ${lease.token}` }] }]
        if (input.engine === "claude") {
          configDir = mkdtempSync(path.join(tmpdir(), "mendcode-thread-mcp-"))
          const file = path.join(configDir, "mcp.json")
          writeFileSync(file, JSON.stringify({ mcpServers: { mendcode_threads: { type: "http", url: listener.url, headers: { Authorization: `Bearer ${lease.token}` } } } }), { mode: 0o600 })
          args = ["--mcp-config", file]
        } else if (input.engine === "codex") {
          args = ["-c", `mcp_servers.mendcode_threads.url=${JSON.stringify(listener.url)}`, "-c", `mcp_servers.mendcode_threads.http_headers={Authorization=${JSON.stringify(`Bearer ${lease.token}`)}}`]
        } else {
          args = []
        }
        const scrub = (text: string) => text.replaceAll(lease.token, "[redacted]")
        const stream = () => {
          let held = ""
          return {
            push(text: string) {
              const safe = scrub(held + text)
              const cut = Math.max(0, safe.length - lease.token.length + 1)
              held = safe.slice(cut)
              return safe.slice(0, cut)
            },
            flush() { const safe = scrub(held); held = ""; return safe },
          }
        }
        return { args, servers, scrub, stream, waiting: () => leases.has(lease) && lease.pending > 0, release: lease.release }
      } catch (error) { lease.release(); throw error }
    },
    stop() { for (const lease of [...leases]) lease.release() },
  }
}
