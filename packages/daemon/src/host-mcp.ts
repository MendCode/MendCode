import { randomBytes, timingSafeEqual } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { SessionId } from "@mendcode/protocol"
import { PROGRAM_NAME } from "@mendcode/program"
import { graphAutopilotText } from "./prompt-guidance"
import { hostMcpPrefix } from "./host-mcp-sweep"

/** The MCP server name Claude Code sees; its tools are `mcp__mendcode__<name>` there. */
export const HOST_MCP_SERVER = "mendcode"
/** Tool arguments are small; a larger body is not a tool call. */
const MAX_BODY = 1024 * 1024
/**
 * How long a tool call may wait on the user's answer before the harness is told it is pending. Claude Code gives a call to this
 * server about a minute and then drops it with "The operation timed out", which reads as a failure; the card stays open for the
 * user while the turn runs, and the call is answered as pending well before that.
 */
export const HOST_PENDING_MS = 40_000
export const HOST_PENDING_TEXT = "Pending: the user has not answered yet. The card is on their screen in MendCode and stays open while this turn runs; if they approve it, it takes effect then. Do not call this tool again for the same thing. Tell the user what is waiting for them and where, and check the outcome later by reading the state (for settings: action get)."
const json = (body: unknown, status = 200) => Response.json(body, { status })
type HostTool = Awaited<ReturnType<NonNullable<EnginePort["hostTools"]>>>[number]

/**
 * What the other harness's model is told about these tools (MCP `instructions`, which Claude Code puts in its system prompt).
 * Only what the session really has is named: a session with no graph tools is not told to use a graph. Codex has no ToolSearch:
 * there a deferred MCP tool is a nested tool of its `exec`, listed in `ALL_TOOLS` (codex 0.162). `unbridged` is the session's engine
 * key when it has no thread bridge: sub-agents on MendCode's other models are then off, and the model is told how they are turned on.
 */
export function hostInstructions(tools: readonly HostTool[], harness: "claude" | "codex" = "claude", unbridged?: string, graphAutopilot = false) {
  const has = (prefix: string) => tools.some((tool) => tool.name.startsWith(prefix))
  const codex = harness === "codex"
  return [
    `MendCode's own tools (mcp__mendcode__<tool>) run in MendCode with its approvals; where one fits, call it first.${codex ? " One not listed as a tool of its own is a nested tool of exec (await tools.mcp__mendcode__graph_find({ query })), named in ALL_TOOLS." : ""}`,
    ...(has("graph_") ? [`Code: for where something is, how it works, who calls it or what a file exports, call mcp__mendcode__graph_find (then graph_callers, graph_file_api, graph_map) BEFORE ${codex ? "rg, grep, find or reading whole files" : "Bash grep/rg/find, Grep, Glob or reading whole files"}; it answers with file:line. Text search is for literal strings, logs, non-code files or when the graph has no answer.${codex ? "" : " If deferred, load them once at the first code task: ToolSearch \"select:mcp__mendcode__graph_find,mcp__mendcode__graph_callers,mcp__mendcode__graph_file_api\"."}`] : []),
    // The same line a native session carries (feature `graph_autopilot`): MendCode builds and refreshes the graph, so it is never skipped for lack of one.
    ...(graphAutopilot && has("graph_") ? [graphAutopilotText().harness] : []),
    ...(has("computer_") ? ["Screen and apps: you DO have computer use here. To look at, click or type in an app on the user's computer, call mcp__mendcode__computer_session, computer_observe, computer_key and computer_capture. Do not drive apps with AppleScript or say you have no computer use."] : []),
    ...(has("image_gen") ? [`Images: you DO have image generation: call mcp__mendcode__image_gen${codex ? "" : " (ToolSearch \"select:mcp__mendcode__image_gen\" if deferred)"}; it saves and shows the file. Never say you cannot or suggest another tool or engine.`] : []),
    ...(has("webfetch") || has("websearch") ? ["Web: when your own fetch or search is refused, blocked or missing, use mcp__mendcode__webfetch (page, PDF, public repository) or mcp__mendcode__websearch, run from the user's machine; say which you used."] : []),
    ...(has("remember") || has("memory") ? ["Memory: remember saves a durable fact about the user or project; memory reads what was saved."] : []),
    ...(has("customize_ui") ? ["MendCode's look (theme, footer, prompt box): customize_ui, not its profile files by hand. A MendCode source checkout is ordinary code: edit it like any project."] : []),
    ...(has("pr_watch") ? [`Pull requests: pr_watch only wakes this session on one PR's checks, comments or conflicts; it reviews nothing. To review PRs and keep reviewing every new PR and push (two passes, inline comments on GitHub, threads resolved when a push fixes them, the @mendcode commands), MendCode has its own reviewer that runs in its daemon and survives this session: the user types /pr review <n> for one PR and /pr watch-repo for the repository (${PROGRAM_NAME} docs --search pr review). Offer that before a cron job, a cloud routine or a GitHub Action, and do not post reviews with gh yourself.`] : []),
    ...(has("review_config") ? ["PR reviewer settings: mcp__mendcode__review_config. Always pass scope: global is the repository's reviewer (.mendcode/review.yaml, shared with everyone), personal is the user's own reviewer profile for this repository. When the user did not say which, ask them; never change global when they meant their own. To set up PR review with the user, call action setup first (no scope, read only) and walk them through its questions."] : []),
    ...(has("pr_review") ? ["Review one PR now: mcp__mendcode__pr_review with action review (MendCode's own reviewer, as /pr review <n>; it posts only as the user's /pr publish consent allows). Never post an @mendcode comment, or anything else, from the user's account to start a review."] : []),
    ...(has("review_config") && !has("pr_review") ? ["Never post an @mendcode comment from the user's account to start a review: the user runs /pr review <n>."] : []),
    ...(has("mendcode_settings") ? ["MendCode's settings (tier, permissions, models, roles, compaction, budgets, output style, experimental): you CAN change them: mcp__mendcode__mendcode_settings get, then propose the exact patch; it is saved only once the user approves its card (\"Pending\": it waits for them, do not propose it again). Never tell the user to change it themselves, edit MendCode's database or run mendcode commands for it."] : []),
    ...(unbridged ? [`Sub-agents on MendCode's other models (\`${PROGRAM_NAME} models\`) need the full tier and /tier thread_mcp on ${unbridged}; your own sub-agent tool runs only this harness's. Say so, never that the model does not exist.`] : []),
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
  /** The session's engine key (`claude`, `codex`, `acp:<name>`) when it has no thread bridge, which delegates to MendCode's other models. */
  unbridged?(sessionId: SessionId): string | undefined
  /** Whether the graph autopilot (feature `graph_autopilot`) is on: the instructions then add its line about the graph tools. */
  graphAutopilot?(): boolean
  /** Tests shorten how long a call waits on the user before it is answered as pending. */
  pendingMs?: number
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
    if (message.method === "initialize") return reply({ protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: HOST_MCP_SERVER, version: "1" }, instructions: hostInstructions(await listed(), "claude", options.unbridged?.(sessionId), options.graphAutopilot?.() ?? false) })
    if (message.method === "ping") return reply({})
    if (message.method === "tools/list") return reply({ tools: (await listed()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: mcpInputSchema(tool.parameters) })) })
    if (message.method !== "tools/call") return error(-32601, "Unknown method")
    const name = message.params?.name
    if (typeof name !== "string") return error(-32602, "Unknown tool")
    const turn = turns.get(sessionId)
    if (!turn || turn.signal.aborted) return reply({ content: [{ type: "text", text: "No turn is running in this session" }], isError: true })
    pending++
    // The call keeps running when its answer is pending; only the reply to the harness is cut short, and only while the user is the one being waited on.
    const startedAt = Date.now()
    let asking = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let onPending!: () => void
    const timedOut = new Promise<"pending">((resolve) => { onPending = () => resolve("pending") })
    const watch = () => {
      clearTimeout(timer)
      if (asking > 0) timer = setTimeout(onPending, Math.max(0, (options.pendingMs ?? HOST_PENDING_MS) - (Date.now() - startedAt)))
    }
    const counted: TurnInput = { ...turn, ask: async (request) => { asking++; watch(); try { return await turn.ask(request) } finally { asking--; watch() } } }
    const running = options.call({ turn: counted, name, args: message.params?.arguments ?? {} })
    void running.then(() => undefined, () => undefined).finally(() => { clearTimeout(timer); pending-- })
    try {
      const result = await Promise.race([running, timedOut])
      if (result === "pending") return reply({ content: [{ type: "text", text: HOST_PENDING_TEXT }], isError: false })
      const token = sessions.get(sessionId)?.token
      const text = token ? result.output.replaceAll(token, "[redacted]") : result.output
      return reply({ content: [{ type: "text", text }, ...(result.images ?? []).map((image) => ({ type: "image", mimeType: image.mime, data: Buffer.from(image.bytes).toString("base64") }))], isError: result.isError })
    } catch (failure) {
      return reply({ content: [{ type: "text", text: `Tool failed: ${failure instanceof Error ? failure.message : String(failure)}` }], isError: true })
    }
  }

  return {
    handle,
    /** What the main model is told about these tools, for the harness's own sub-agents and for Codex, which does not forward a server's instructions; nothing when the feature is off or no tool is served. */
    async instructions(sessionId: SessionId, harness?: "claude" | "codex"): Promise<string | undefined> {
      const directory = options.directory(sessionId)
      if (!options.enabled() || !directory) return undefined
      const tools = await options.tools({ directory, sessionId }).catch(() => [])
      return tools.length ? hostInstructions(tools, harness, options.unbridged?.(sessionId), options.graphAutopilot?.() ?? false) : undefined
    },
    /** `claude` flags that connect one session's process to this server; empty when the feature is off. The same flags every time, so the process is kept between turns. */
    args(sessionId: SessionId): string[] {
      const entry = entryFor(sessionId)
      if (!entry || !listener) return []
      // Written again for each process: the listener's port changes when the daemon restarts, the file's path does not within one.
      writeFileSync(entry.file, JSON.stringify({ mcpServers: { [HOST_MCP_SERVER]: { type: "http", url: listener.url, headers: { Authorization: `Bearer ${entry.token}` } } } }), { mode: 0o600 })
      return ["--mcp-config", entry.file]
    },
    /** The same server as an ACP `mcpServers` entry, for an agent that takes HTTP MCP, and as Codex's `mcp_servers` for one session's app-server; empty when the feature is off. */
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
      const dir = mkdtempSync(path.join(tmpdir(), hostMcpPrefix()))
      entry = { token: randomBytes(32).toString("hex"), dir, file: path.join(dir, "mcp.json") }
      sessions.set(sessionId, entry)
    }
    return entry
  }
}
