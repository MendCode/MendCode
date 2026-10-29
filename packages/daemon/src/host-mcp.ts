import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { SessionId } from "@mendcode/protocol"

/** The MCP server name Claude Code sees; its tools are `mcp__mendcode__<name>` there. */
export const HOST_MCP_SERVER = "mendcode"
/** Tool arguments are small; a larger body is not a tool call. */
const MAX_BODY = 1024 * 1024
const json = (body: unknown, status = 200) => Response.json(body, { status })
type HostTool = Awaited<ReturnType<NonNullable<EnginePort["hostTools"]>>>[number]

/**
 * What the other harness's model is told about these tools (MCP `instructions`, which Claude Code puts in its system prompt).
 * Only what the session really has is named: a session with no graph tools is not told to use a graph.
 */
export function hostInstructions(tools: readonly HostTool[]) {
  const has = (prefix: string) => tools.some((tool) => tool.name.startsWith(prefix))
  return [
    "MendCode's own tools, named mcp__mendcode__<tool>. They run in MendCode with its approvals. Where one fits, call it first: it is what the user sees and expects in this app.",
    ...(has("graph_") ? ["Code search and navigation: the project has a prebuilt code graph. For where something is, how it works, who calls it or what a file exports, call mcp__mendcode__graph_find (then graph_callers, graph_file_api, graph_map) BEFORE Bash grep/rg/find, Grep, Glob or reading whole files. It answers with exact file:line. Fall back to text search only for literal strings in logs or non-code files, or when the graph has no answer. If these tools are listed by name only (deferred), load them once, at the start of the first code task: ToolSearch \"select:mcp__mendcode__graph_find,mcp__mendcode__graph_callers,mcp__mendcode__graph_file_api\"."] : []),
    ...(has("computer_") ? ["Screen and apps: you DO have computer use here. To look at, click or type in an app on the user's computer, call mcp__mendcode__computer_session, computer_observe, computer_key and computer_capture. Do not drive apps with AppleScript or say you have no computer use."] : []),
    ...(has("image_gen") ? ["Images: you DO have image generation here. When the user asks for an image, call mcp__mendcode__image_gen (load it with ToolSearch \"select:mcp__mendcode__image_gen\" if deferred); it saves the file and shows it in MendCode. Do not say you cannot or suggest another tool or engine."] : []),
    ...(has("webfetch") || has("websearch") ? ["Web: when your own web fetch or search refuses a site, is blocked or is missing, call mcp__mendcode__webfetch (a page, PDF or public repository) or mcp__mendcode__websearch. They run in MendCode from the user's machine; say which one you used."] : []),
    ...(has("remember") || has("memory") ? ["Memory: remember saves a durable fact about the user or project; memory reads what was saved."] : []),
    ...(has("customize_ui") ? ["MendCode's look (theme, footer, prompt box): customize_ui. Do not edit MendCode's files by hand."] : []),
    ...(has("mendcode_settings") ? ["MendCode's daemon settings (tier, permissions, models and roles, compaction, budgets, output style, experimental): you CAN change them. Read with mcp__mendcode__mendcode_settings get, then propose the exact patch; the user approves it on a card and only then is it saved. Do not tell the user to change it themselves, and do not edit MendCode's database or run mendcode commands to do it."] : []),
  ].join("\n")
}

type JsonSchema = Record<string, unknown>
const isSchema = (value: unknown): value is JsonSchema => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A tool's parameters as an MCP `inputSchema`, which must be an object schema with no union at its root: Claude Code drops the
 * server's whole tool list when one tool's schema has another shape. A root `oneOf`/`anyOf` of object variants (an `action`
 * per variant) becomes one object: every variant's properties, a property's different `const`s as an `enum`, other
 * differences as `anyOf`, and required only what every variant requires. MendCode still checks a call against the real schema.
 */
export function mcpInputSchema(parameters: unknown): JsonSchema {
  const schema = isSchema(parameters) ? parameters : {}
  const variants = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(variants)) return schema.type === "object" ? schema : { ...schema, type: "object" }
  const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = schema
  const objects = variants.filter(isSchema)
  const shapes = new Map<string, JsonSchema[]>()
  for (const variant of objects) {
    for (const [name, property] of Object.entries(isSchema(variant.properties) ? variant.properties : {})) {
      if (!isSchema(property)) continue
      const seen = shapes.get(name) ?? []
      if (!seen.some((entry) => JSON.stringify(entry) === JSON.stringify(property))) seen.push(property)
      shapes.set(name, seen)
    }
  }
  const merged = (seen: JsonSchema[]): JsonSchema => {
    if (seen.length === 1) return seen[0]!
    if (seen.every((entry) => "const" in entry && entry.type === seen[0]!.type)) return { type: seen[0]!.type, enum: seen.map((entry) => entry.const) }
    return { anyOf: seen }
  }
  const requiredBy = (variant: JsonSchema) => new Set(Array.isArray(variant.required) ? variant.required.filter((name): name is string => typeof name === "string") : [])
  const required = objects.length ? [...requiredBy(objects[0]!)].filter((name) => objects.every((variant) => requiredBy(variant).has(name))) : []
  return { ...rest, type: "object", properties: Object.fromEntries([...shapes].map(([name, seen]) => [name, merged(seen)])), ...(required.length ? { required } : {}) }
}

/**
 * A loopback MCP server that lends MendCode's native tools to another harness running a MendCode session (Claude Code): the code
 * graph, computer use, memory, settings and the rest of what that harness does not have. One bearer per session, kept in memory
 * and in a 0600 file only that harness's process reads. A call is served only while that session has a turn running, and runs as a
 * call of that turn: the same approvals, authority, masking and card as in a native session.
 */
export function createHostMcp(options: {
  enabled(): boolean
  directory(sessionId: SessionId): string | undefined
  tools(input: { directory: string; sessionId: SessionId }): Promise<HostTool[]>
  call(input: { turn: TurnInput; name: string; args: unknown }): ReturnType<NonNullable<EnginePort["hostCall"]>>
  /** Tests inject a listener without opening a socket. */
  listen?(handler: (request: Request) => Promise<Response>): { url: string; stop(): void }
}) {
  const sessions = new Map<SessionId, { token: string; dir: string; file: string }>()
  const turns = new Map<SessionId, TurnInput>()
  let listener: { url: string; stop(): void } | undefined
  let pending = 0

  function sessionOf(bearer: string) {
    const bytes = Buffer.from(bearer)
    for (const [sessionId, entry] of sessions) if (bytes.length === entry.token.length && timingSafeEqual(bytes, Buffer.from(entry.token))) return sessionId
    return undefined
  }

  async function handle(request: Request): Promise<Response> {
    // No browser origins, remote hosts or other routes: the bearer is only good on this loopback address.
    if (!listener || request.url !== listener.url || request.headers.has("origin")) return new Response(null, { status: 403 })
    const sessionId = sessionOf(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")
    if (!sessionId || !options.enabled()) return new Response(null, { status: 401 })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 })
    const body = await request.text()
    if (body.length > MAX_BODY) return new Response(null, { status: 413 })
    let message: { jsonrpc?: string; id?: string | number; method?: string; params?: any }
    try { message = JSON.parse(body) } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }) }
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } })
    if (message.id === undefined) return new Response(null, { status: 202 })
    const reply = (result: unknown) => json({ jsonrpc: "2.0", id: message.id, result })
    const error = (code: number, text: string) => json({ jsonrpc: "2.0", id: message.id, error: { code, message: text } })
    const directory = options.directory(sessionId)
    const listed = async () => (directory ? await options.tools({ directory, sessionId }).catch(() => []) : [])
    if (message.method === "initialize") return reply({ protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: HOST_MCP_SERVER, version: "1" }, instructions: hostInstructions(await listed()) })
    if (message.method === "ping") return reply({})
    if (message.method === "tools/list") return reply({ tools: (await listed()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: mcpInputSchema(tool.parameters) })) })
    if (message.method !== "tools/call") return error(-32601, "Unknown method")
    const name = message.params?.name
    if (typeof name !== "string") return error(-32602, "Unknown tool")
    const turn = turns.get(sessionId)
    if (!turn || turn.signal.aborted) return reply({ content: [{ type: "text", text: "No turn is running in this session" }], isError: true })
    pending++
    try {
      const result = await options.call({ turn, name, args: message.params?.arguments ?? {} })
      const token = sessions.get(sessionId)?.token
      const text = token ? result.output.replaceAll(token, "[redacted]") : result.output
      return reply({ content: [{ type: "text", text }, ...(result.images ?? []).map((image) => ({ type: "image", mimeType: image.mime, data: Buffer.from(image.bytes).toString("base64") }))], isError: result.isError })
    } catch (failure) {
      return reply({ content: [{ type: "text", text: `Tool failed: ${failure instanceof Error ? failure.message : String(failure)}` }], isError: true })
    } finally { pending-- }
  }

  return {
    handle,
    /** What the main model is told about these tools, for the harness's own sub-agents; nothing when the feature is off or no tool is served. */
    async instructions(sessionId: SessionId): Promise<string | undefined> {
      const directory = options.directory(sessionId)
      if (!options.enabled() || !directory) return undefined
      const tools = await options.tools({ directory, sessionId }).catch(() => [])
      return tools.length ? hostInstructions(tools) : undefined
    },
    /** `claude` flags that connect one session's process to this server; empty when the feature is off. The same flags every time, so the process is kept between turns. */
    args(sessionId: SessionId): string[] {
      const entry = entryFor(sessionId)
      if (!entry || !listener) return []
      // Written again for each process: the listener's port changes when the daemon restarts, the file's path does not within one.
      writeFileSync(entry.file, JSON.stringify({ mcpServers: { [HOST_MCP_SERVER]: { type: "http", url: listener.url, headers: { Authorization: `Bearer ${entry.token}` } } } }), { mode: 0o600 })
      return ["--mcp-config", entry.file]
    },
    /** The same server as an ACP `mcpServers` entry, for an agent that takes HTTP MCP; empty when the feature is off. */
    servers(sessionId: SessionId): Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }> {
      const entry = entryFor(sessionId)
      if (!entry || !listener) return []
      return [{ type: "http", name: HOST_MCP_SERVER, url: listener.url, headers: [{ name: "Authorization", value: `Bearer ${entry.token}` }] }]
    },
    /** The session's running turn, which the calls made during it belong to. */
    enter(turn: TurnInput) {
      turns.set(turn.sessionId, turn)
      return () => { if (turns.get(turn.sessionId) === turn) turns.delete(turn.sessionId) }
    },
    /** A call is waiting (on the user's approval, on the tool): the other harness is not idle. */
    waiting: () => pending > 0,
    stop() {
      for (const entry of sessions.values()) rmSync(entry.dir, { recursive: true, force: true })
      sessions.clear()
      turns.clear()
      listener?.stop()
      listener = undefined
    },
  }

  function entryFor(sessionId: SessionId) {
    if (!options.enabled()) return undefined
    listener ??= options.listen?.(handle) ?? (() => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_BODY, idleTimeout: 0, fetch: handle })
      return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => void server.stop(true) }
    })()
    let entry = sessions.get(sessionId)
    if (!entry) {
      const dir = mkdtempSync(path.join(tmpdir(), "mendcode-host-mcp-"))
      entry = { token: randomBytes(32).toString("hex"), dir, file: path.join(dir, "mcp.json") }
      sessions.set(sessionId, entry)
    }
    return entry
  }
}
