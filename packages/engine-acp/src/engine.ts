import type { BlobRef, PermissionMode, SessionId } from "@mendcode/protocol"
import { layoutAttachments } from "@mendcode/protocol/wire"
import { environmentKey, processMcpTurn, realClock, type Clock, type EngineEnvironment, type EnginePort, type EngineRequest, type EngineResolution, type TimerHandle, type TurnInput, type TurnOutcome } from "@mendcode/kernel"
import type { AcpAgentConfig, AcpModelOption } from "./agents"
import { AcpRpcError, createRpcPeer, type RpcPeer } from "./rpc"
import { spawnAcp, type AcpTransport } from "./transport"
import { acpKindPermission, createUpdateMapper, MAX_TEXT, toolContentText } from "./updates"

/** The ACP revision this client speaks. */
export const ACP_PROTOCOL_VERSION = 1
/** An agent process is stopped after this long without a turn; the next turn resumes or starts a session. */
export const DEFAULT_PROCESS_IDLE_MS = 10 * 60_000
/** A session no client shows any more keeps its agent process this long (several hundred MB each): enough to switch back. */
export const RELEASED_PROCESS_IDLE_MS = 60_000
/** How long a cancelled prompt may take to answer before the turn is ended anyway. */
const CANCEL_GRACE_MS = 5_000
const INITIALIZE_TIMEOUT_MS = 60_000
const SESSION_TIMEOUT_MS = 30_000
const AUTH_REQUIRED = -32000

type Json = Record<string, any>
type PermissionOption = { optionId: string; name: string; kind: string }

type ActiveTurn = {
  input: TurnInput
  mapper: ReturnType<typeof createUpdateMapper>
  waitingUser: boolean
  interrupted: boolean
  watchdog?: TimerHandle
  /** Ends the turn when a cancelled prompt never answers. */
  grace?: TimerHandle
  touch(): void
  finish(outcome: TurnOutcome): void
}

type Connection = {
  sessionId: SessionId
  agent: string
  /** `environmentKey` of the credentials the process started with. */
  envKey: string
  transport: AcpTransport
  rpc: RpcPeer
  /** Resolves with the agent's session id once `session/new` or `session/load` answered. */
  ready: Promise<string>
  acpSessionId?: string
  capabilities: { loadSession: boolean; image: boolean; http: boolean }
  /** The agent's `model` config option, when it offers one, and the value in force. */
  modelOption?: { configId: string; current?: string }
  /** The agent's effort option (ACP category `thought_level`) for the model in force, when that model has one: its values and the one in force. */
  effortOption?: { configId: string; values: string[]; current?: string }
  turn?: ActiveTurn
  idle?: TimerHandle
  closed: boolean
}

export type AcpEngineOptions = {
  agents: { get(name: string): AcpAgentConfig | undefined }
  /** The agent (by configured name) a session's model names; undefined when the session's model is not an ACP agent. */
  agentFor(sessionId: SessionId, override?: import("@mendcode/protocol").ModelChoice): string | undefined
  /** The agent's own model value a session's `acp:<name>/<model>` id names; undefined leaves the agent's model as it is. */
  modelFor?(sessionId: SessionId, override?: import("@mendcode/protocol").ModelChoice): string | undefined
  /** Called with the models an agent offers in its `model` config option, each time it lists them. */
  onModels?(agent: string, models: AcpModelOption[]): void
  /** The reasoning effort a session's turn asks for (its model choice's); undefined asks for the agent's default level. */
  effortFor?(sessionId: SessionId, override?: import("@mendcode/protocol").ModelChoice): string | undefined
  /** Called with the levels the agent's effort option offers for one of its models (`[]` when that model has none), each time it lists them. */
  onEfforts?(agent: string, model: string, efforts: string[]): void
  cwdFor(sessionId: SessionId): string
  /** The session's `/env` credentials, in the agent process's environment (ACP has no system prompt to name them in). */
  environment?(sessionId: SessionId): EngineEnvironment | undefined
  clock?: Clock
  /** Silence after which a turn is cut. Unset (the default) never cuts one, as the engine's own CLI does not: it times out and
   *  retries its own calls, and a long think can be quiet for minutes. */
  idleMs?: number
  processIdleMs?: number
  /** How long a released session's process stays (RELEASED_PROCESS_IDLE_MS); never longer than `processIdleMs`. */
  releasedIdleMs?: number
  /** Persistent (session, agent) → agent session id, so a restart resumes the conversation when the agent can `session/load`. */
  bindings?: { get(sessionId: SessionId, agent: string): string | undefined; set(sessionId: SessionId, agent: string, acpSessionId: string): void }
  readBlob?(ref: BlobRef): Promise<Uint8Array>
  transportFactory?(input: { agent: string; config: AcpAgentConfig; cwd: string; env: Record<string, string> }): AcpTransport
  trace?: (direction: "in" | "out", line: string) => void
  /** Daemon-owned configuration for an isolated bridge process only. */
  mcpServers?: NonNullable<TurnInput["externalMcp"]>["servers"]
  /** MendCode's own tools (code graph, memory, settings…) for a session, given to an agent that takes HTTP MCP; one that does not runs without them. */
  hostServers?: (sessionId: SessionId) => NonNullable<NonNullable<TurnInput["externalMcp"]>["servers"]>
  waitingForMcp?: (() => boolean) | undefined
}

const fail = (code: string, message: string): TurnOutcome => ({ status: "error", code, message: `[ACP]: ${message}` })

function permissionDetail(params: Json): string {
  const tool: Json = params.toolCall ?? {}
  const parts = [toolContentText(tool.content), tool.rawInput === undefined ? "" : JSON.stringify(tool.rawInput, null, 2)].filter((part) => part !== "")
  return parts.join("\n\n").slice(0, MAX_TEXT)
}

/**
 * Engine for an external agent that speaks the Agent Client Protocol (JSON-RPC 2.0 over the agent's stdio). The agent
 * runs its own loop, tools and model with its own login; MendCode shows the turn, answers `session/request_permission`
 * through the normal approval flow and cancels with `session/cancel`. No file-system or terminal capability is
 * offered, so the agent works in its own sandbox. One process per session stays up between turns.
 */
export function createAcpEngine(options: AcpEngineOptions): EnginePort & { stop(): void } {
  const clock = options.clock ?? realClock
  const idleMs = options.idleMs
  const processIdleMs = options.processIdleMs ?? DEFAULT_PROCESS_IDLE_MS
  const connections = new Map<SessionId, Connection>()
  const isolatedEngines = new Set<ReturnType<typeof createAcpEngine>>()

  function close(connection: Connection) {
    if (connection.closed) return
    connection.closed = true
    connection.idle?.cancel()
    if (connections.get(connection.sessionId) === connection) connections.delete(connection.sessionId)
    connection.rpc.close()
  }

  /** The option to select for an answer, preferring the first kind listed; undefined when the agent offered none of them. */
  function pick(options: PermissionOption[], kinds: string[]): string | undefined {
    for (const kind of kinds) {
      const found = options.find((option) => option.kind === kind)
      if (found) return found.optionId
    }
    return undefined
  }

  async function answerPermission(connection: Connection, params: Json): Promise<unknown> {
    const choices: PermissionOption[] = Array.isArray(params.options) ? params.options.filter((option: any) => option && typeof option.optionId === "string").map((option: any) => ({ optionId: option.optionId, name: String(option.name ?? ""), kind: String(option.kind ?? "") })) : []
    const selected = (optionId: string | undefined) => (optionId === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } })
    const turn = connection.turn
    if (!turn) return selected(pick(choices, ["reject_once", "reject_always"]))
    const tool: Json = params.toolCall ?? {}
    const permission = acpKindPermission(tool.kind)
    const mode: PermissionMode = turn.input.permissionMode()
    if (mode === "full" || (mode === "edits" && permission === "write")) return selected(pick(choices, ["allow_once", "allow_always"]))
    if (mode === "plan" && permission !== "read") return selected(pick(choices, ["reject_once", "reject_always"]))
    const itemId = turn.mapper.itemOf(tool.toolCallId)
    const request: EngineRequest = {
      kind: "approval",
      title: String(tool.title ?? tool.kind ?? "Agent action").slice(0, 200),
      // An agent that offers no one-time allow remembers any approval: the card says so before the user answers.
      detail: `${permissionDetail(params)}${!pick(choices, ["allow_once"]) && pick(choices, ["allow_always"]) ? "\n\nThis agent can only allow this always: approving lets it repeat this action without asking again." : ""}`,
      tool: String(tool.title ?? tool.kind ?? "tool").slice(0, 200),
      permission,
      ...(itemId ? { itemId } : {}),
    }
    turn.waitingUser = true
    turn.watchdog?.cancel()
    let answer: EngineResolution
    try {
      answer = await turn.input.ask(request)
    } finally {
      turn.waitingUser = false
      turn.touch()
    }
    if (answer.kind === "approve") return selected(answer.scope === "session" ? pick(choices, ["allow_always", "allow_once"]) : pick(choices, ["allow_once", "allow_always"]))
    if (answer.kind === "deny") return selected(pick(choices, ["reject_once", "reject_always"]))
    return selected(undefined)
  }

  function onRequest(connection: Connection, method: string, params: Json): Promise<unknown> {
    if (method === "session/request_permission") return answerPermission(connection, params)
    // No fs or terminal capability was advertised, so a well-behaved agent never asks.
    return Promise.reject(new AcpRpcError(`method not supported: ${method}`, -32601))
  }

  /**
   * Reads the `model` select and the effort select (category `thought_level`) from an agent's `configOptions`
   * (session/new, session/load, set_config_option or an update). The effort select follows the model in force: OpenCode
   * lists its variants (`low`, `high`, `max`, `default`…) for a model that has them and leaves the select out otherwise.
   */
  function noteConfig(connection: Connection, configOptions: unknown) {
    if (!Array.isArray(configOptions)) return
    const select = (wanted: (entry: Json) => boolean): Json | undefined => configOptions.find((entry: Json) => entry?.type === "select" && typeof entry.id === "string" && wanted(entry))
    // Options may be grouped: `{ group, name, options: [...] }`.
    const flat = (list: unknown): Json[] => (Array.isArray(list) ? list.flatMap((entry: Json) => (Array.isArray(entry?.options) ? flat(entry.options) : [entry])) : [])
    const option = select((entry) => entry.category === "model" || entry.id === "model")
    if (option) {
      const models: AcpModelOption[] = flat(option.options).filter((entry) => typeof entry?.value === "string" && entry.value).map((entry) => ({ value: entry.value, name: typeof entry.name === "string" && entry.name ? entry.name : entry.value }))
      connection.modelOption = { configId: option.id, ...(typeof option.currentValue === "string" ? { current: option.currentValue } : {}) }
      if (models.length) options.onModels?.(connection.agent, models)
    }
    const effort = select((entry) => entry.category === "thought_level" || entry.id === "effort" || entry.id === "thought_level")
    const values = effort ? flat(effort.options).flatMap((entry) => (typeof entry?.value === "string" && entry.value ? [entry.value as string] : [])) : []
    if (effort && values.length) connection.effortOption = { configId: effort.id, values, ...(typeof effort.currentValue === "string" ? { current: effort.currentValue } : {}) }
    else delete connection.effortOption
    const model = connection.modelOption?.current
    if (model) options.onEfforts?.(connection.agent, model, values.filter((value) => value !== "default"))
  }

  function onNotification(connection: Connection, method: string, params: Json) {
    if (method !== "session/update") return
    if (params.sessionId === connection.acpSessionId && params.update?.sessionUpdate === "config_option_update") noteConfig(connection, params.update.configOptions)
    const turn = connection.turn
    if (!turn || params.sessionId !== connection.acpSessionId) return
    turn.touch()
    turn.mapper.accept(params.update)
  }

  function onClosed(connection: Connection) {
    if (connection.closed) return
    const tail = connection.transport.stderrTail()
    connection.turn?.mapper.finish("error")
    connection.turn?.finish(fail("acp_exited", `agent "${connection.agent}" exited during the turn${tail ? `: ${tail.slice(-1_000)}` : ""}`))
    close(connection)
  }

  async function establishSession(connection: Connection, cwd: string): Promise<string> {
    const { sessionId, agent } = connection
    const mcpServers = [...(options.mcpServers ?? []), ...(connection.capabilities.http ? options.hostServers?.(sessionId) ?? [] : [])]
    const known = options.bindings?.get(sessionId, agent)
    if (known && connection.capabilities.loadSession) {
      try {
        connection.acpSessionId = known
        // The agent replays the history as session/update notifications; with no turn running they are dropped.
        const loaded = (await connection.rpc.request("session/load", { sessionId: known, cwd, mcpServers }, { timeoutMs: SESSION_TIMEOUT_MS })) as Json | undefined
        noteConfig(connection, loaded?.configOptions)
        return known
      } catch (error) {
        if (error instanceof AcpRpcError && error.code === AUTH_REQUIRED) throw error
        delete connection.acpSessionId
      }
    }
    const created = (await connection.rpc.request("session/new", { cwd, mcpServers }, { timeoutMs: SESSION_TIMEOUT_MS })) as Json
    if (typeof created?.sessionId !== "string") throw new AcpRpcError("session/new returned no sessionId")
    connection.acpSessionId = created.sessionId
    noteConfig(connection, created.configOptions)
    options.bindings?.set(sessionId, agent, created.sessionId)
    return created.sessionId
  }

  function open(sessionId: SessionId, agent: string, config: AcpAgentConfig): Connection {
    const cwd = options.cwdFor(sessionId)
    const environment = options.environment?.(sessionId)
    const transport = options.transportFactory?.({ agent, config, cwd, env: environment?.values ?? {} }) ?? spawnAcp({ command: config.command, args: config.args ?? [], env: { ...config.env, ...environment?.values }, cwd })
    const connection: Connection = { sessionId, agent, envKey: environmentKey(environment), transport, rpc: undefined as unknown as RpcPeer, ready: Promise.resolve(""), capabilities: { loadSession: false, image: false, http: false }, closed: false }
    connection.rpc = createRpcPeer({
      transport,
      trace: options.trace,
      handlers: {
        onRequest: (method, params) => onRequest(connection, method, params),
        onNotification: (method, params) => onNotification(connection, method, params),
        onClosed: () => onClosed(connection),
      },
    })
    connections.set(sessionId, connection)
    connection.ready = (async () => {
      const init = (await connection.rpc.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "mendcode", title: "MendCode", version: "2" },
        },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      )) as Json
      const capabilities: Json = init?.agentCapabilities ?? {}
      if (options.mcpServers?.length && capabilities.mcpCapabilities?.http !== true) throw new AcpRpcError("agent does not advertise HTTP MCP support; disable its thread bridge opt-in or use an HTTP-capable agent")
      connection.capabilities = { loadSession: capabilities.loadSession === true, image: capabilities.promptCapabilities?.image === true, http: capabilities.mcpCapabilities?.http === true }
      return establishSession(connection, cwd)
    })()
    // A failed start is reported by runTurn; without this a connection nobody awaits would be an unhandled rejection.
    connection.ready.catch(() => undefined)
    return connection
  }

  async function connectionFor(input: TurnInput, agent: string, config: AcpAgentConfig): Promise<Connection> {
    let connection = connections.get(input.sessionId)
    // A session that switched to another agent restarts on the new one, and on new `/env` credentials.
    if (connection && (connection.agent !== agent || connection.envKey !== environmentKey(options.environment?.(input.sessionId)))) {
      close(connection)
      connection = undefined
    }
    connection ??= open(input.sessionId, agent, config)
    connection.idle?.cancel()
    // A bridge must not leave a bearer-bearing process waiting for initialization after cancellation.
    const cancelStart = () => close(connection!)
    if (options.mcpServers?.length) {
      input.signal.addEventListener("abort", cancelStart, { once: true })
      if (input.signal.aborted) cancelStart()
    }
    try {
      await connection.ready
    } catch (error) {
      const tail = connection.transport.stderrTail()
      close(connection)
      // An agent that died while starting explains itself on stderr.
      if (tail && !(error instanceof AcpRpcError && error.code !== undefined)) throw new Error(`${error instanceof Error ? error.message : String(error)}: ${tail.slice(-500)}`)
      throw error
    } finally { input.signal.removeEventListener("abort", cancelStart) }
    return connection
  }

  async function content(input: TurnInput, connection: Connection): Promise<Array<Record<string, unknown>>> {
    const block = async (ref: TurnInput["attachments"][number]): Promise<Record<string, unknown>> => {
      if (ref.mime.startsWith("image/") && connection.capabilities.image && options.readBlob) {
        const bytes = await options.readBlob(ref).catch(() => undefined)
        if (bytes) return { type: "image", mimeType: ref.mime, data: Buffer.from(bytes).toString("base64") }
      }
      return { type: "text", text: `[attachment ${ref.name ?? ref.sha256.slice(0, 12)} · ${ref.mime} · not sent]` }
    }
    // Inline attachment tokens: the prompt blocks follow the sentence, each attachment right after its token.
    const layout = layoutAttachments(input.text, input.attachments)
    if (layout) return Promise.all(layout.map((part) => ("text" in part ? { type: "text", text: part.text } : block(input.attachments[part.ref]!))))
    const parts: Array<Record<string, unknown>> = []
    for (const ref of input.attachments) parts.push(await block(ref))
    parts.push({ type: "text", text: input.text })
    return parts
  }

  function startMessage(error: unknown, agent: string): TurnOutcome {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof AcpRpcError && error.code === AUTH_REQUIRED) return fail("acp_auth", `agent "${agent}" needs you to sign in; run its own login command first`)
    if (/ENOENT|not found|No such file/i.test(message)) return fail("acp_missing", `could not start agent "${agent}": command not found (check acp-agents.json)`)
    return fail("acp_start", `agent "${agent}" did not start: ${message}`)
  }

  return {
    async runTurn(input) {
      if (input.externalMcp) {
        const previous = connections.get(input.sessionId)
        if (previous) close(previous)
        const mcp = input.externalMcp
        const { trace: _trace, ...processOptions } = options
        const isolated = createAcpEngine({ ...processOptions, mcpServers: mcp.servers ?? [], waitingForMcp: mcp.waiting, cwdFor: () => mcp.cwd })
        isolatedEngines.add(isolated)
        const turn = processMcpTurn(input)
        try {
          const outcome = await isolated.runTurn(turn)
          return outcome.status === "error" ? { ...outcome, message: mcp.scrub(outcome.message) } : outcome
        } finally { turn.flushProcessMcp(); isolated.stop(); isolatedEngines.delete(isolated) }
      }
      const agent = options.agentFor(input.sessionId, input.selection?.model)
      if (input.signal.aborted) return { status: "ok" }
      if (!agent) return fail("acp_no_agent", "this session's model is not a configured ACP agent")
      const config = options.agents.get(agent)
      if (!config) return fail("acp_no_agent", `agent "${agent}" is not in acp-agents.json`)
      let connection: Connection
      try {
        connection = await connectionFor(input, agent, config)
      } catch (error) {
        if (input.signal.aborted) return { status: "ok" }
        return startMessage(error, agent)
      }
      if (input.signal.aborted) return { status: "ok" }
      const acpSessionId = connection.acpSessionId as string
      const wanted = options.modelFor?.(input.sessionId, input.selection?.model)
      if (wanted !== undefined && wanted !== connection.modelOption?.current) {
        if (!connection.modelOption) return fail("acp_model", `agent "${agent}" offers no model choice; pick acp:${agent} to use its default`)
        try {
          const changed = (await connection.rpc.request("session/set_config_option", { sessionId: acpSessionId, configId: connection.modelOption.configId, value: wanted }, { timeoutMs: SESSION_TIMEOUT_MS })) as Json | undefined
          noteConfig(connection, changed?.configOptions)
          connection.modelOption.current = wanted
        } catch (error) {
          return fail("acp_model", `agent "${agent}" did not switch to model "${wanted}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // After the model: the effort select lists that model's levels. No effort asked = the agent's own default level.
      const effortOption = connection.effortOption
      if (effortOption) {
        const asked = options.effortFor?.(input.sessionId, input.selection?.model)
        const level = asked && effortOption.values.includes(asked) ? asked : effortOption.values.includes("default") ? "default" : undefined
        if (level !== undefined && level !== effortOption.current) {
          try {
            const changed = (await connection.rpc.request("session/set_config_option", { sessionId: acpSessionId, configId: effortOption.configId, value: level }, { timeoutMs: SESSION_TIMEOUT_MS })) as Json | undefined
            noteConfig(connection, changed?.configOptions)
            if (connection.effortOption?.configId === effortOption.configId) connection.effortOption.current = level
          } catch (error) {
            return fail("acp_effort", `agent "${agent}" did not switch to effort "${level}": ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const body = await content(input, connection)
      // A cancel while the agent started or the attachments were read: its abort event is gone, so nothing may be sent now.
      if (input.signal.aborted) {
        if (!connection.closed) connection.idle = clock.setTimer(processIdleMs, () => close(connection))
        return { status: "ok" }
      }
      return new Promise<TurnOutcome>((resolve) => {
        let settled = false
        const cancel = () => {
          if (!connection.closed) connection.rpc.notify("session/cancel", { sessionId: acpSessionId })
        }
        const turn: ActiveTurn = {
          input,
          mapper: createUpdateMapper({ newItemId: input.newItemId, emit: input.emit }),
          waitingUser: false,
          interrupted: false,
          touch() {
            turn.watchdog?.cancel()
            if (settled || turn.waitingUser || idleMs === undefined) return
            turn.watchdog = clock.setTimer(idleMs, () => {
              if (options.waitingForMcp?.()) { turn.touch(); return }
              cancel()
              turn.mapper.finish("interrupted")
              turn.finish(fail("stream_idle", `no activity from "${agent}" for ${Math.round(idleMs / 1000)} s; turn cancelled`))
            })
          },
          finish(outcome) {
            if (settled) return
            settled = true
            turn.watchdog?.cancel()
            turn.grace?.cancel()
            if (connection.turn === turn) delete connection.turn
            if (!connection.closed) connection.idle = clock.setTimer(processIdleMs, () => close(connection))
            resolve(outcome)
          },
        }
        connection.turn = turn
        turn.touch()
        input.signal.addEventListener(
          "abort",
          () => {
            turn.interrupted = true
            cancel()
            // The agent should answer the prompt with stopReason "cancelled"; if it does not, the turn ends anyway and so does the process:
            // a prompt it still runs would send its late updates into the next turn. The next turn starts a process that loads the session.
            turn.grace = clock.setTimer(CANCEL_GRACE_MS, () => {
              turn.mapper.finish("interrupted")
              turn.finish({ status: "ok" })
              close(connection)
            })
          },
          { once: true },
        )
        connection.rpc.request("session/prompt", { sessionId: acpSessionId, prompt: body }).then(
          (result) => {
            const reason = (result as Json | undefined)?.stopReason
            if (reason === "cancelled" || turn.interrupted) {
              turn.mapper.finish("interrupted")
              return turn.finish({ status: "ok" })
            }
            if (reason === "refusal") {
              turn.mapper.finish("ok")
              return turn.finish(fail("acp_refusal", `agent "${agent}" refused to continue`))
            }
            if (reason === "max_tokens" || reason === "max_turn_requests") {
              turn.mapper.finish("ok")
              return turn.finish(fail("acp_limit", `agent "${agent}" stopped: ${reason === "max_tokens" ? "token limit reached" : "turn request limit reached"}`))
            }
            turn.mapper.finish("ok")
            turn.finish({ status: "ok" })
          },
          (error: unknown) => {
            turn.mapper.finish("error")
            if (turn.interrupted) return turn.finish({ status: "ok" })
            const code = error instanceof AcpRpcError && error.code === AUTH_REQUIRED ? "acp_auth" : "acp_turn_failed"
            turn.finish(fail(code, error instanceof Error ? error.message : String(error)))
          },
        )
      })
    },
    needsCompaction: () => false,
    // The agent manages its own context.
    compact: async () => ({ status: "ok" }),
    release(sessionId) {
      const connection = connections.get(sessionId)
      if (!connection || connection.closed || connection.turn) return
      connection.idle?.cancel()
      connection.idle = clock.setTimer(Math.min(options.releasedIdleMs ?? RELEASED_PROCESS_IDLE_MS, processIdleMs), () => close(connection))
    },
    stop() {
      for (const isolated of isolatedEngines) isolated.stop()
      for (const connection of [...connections.values()]) close(connection)
    },
  }
}
