import { existsSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import type { SandboxPolicy } from "@mendcode/tools"
import type { BlobRef, ModelChoice, PermissionMode, SessionId } from "@mendcode/protocol"
import { attachmentOrder } from "@mendcode/protocol/wire"
import { environmentKey, realClock, type Clock, type EngineEnvironment, type EnginePort, type EngineRequest, type EngineResolution, type TimerHandle, type TurnInput, type TurnOutcome } from "@mendcode/kernel"
import type { PiCapabilities, ResolvedPiConfig } from "./config"
import { createPiMapper, MAX_TEXT } from "./events"
import { gateDetail, GATE_READY, GATE_STATUS_KEY, GATE_TOKEN_ENV, parseGateRequest, piToolPermission, writeGateExtension, type GateRequest } from "./gate"
import { createPiPeer, PiRpcError, type PiPeer } from "./rpc"
import { spawnPi, type PiTransport } from "./transport"

/** A pi process is stopped after this long without a turn; the next turn resumes its session file. */
export const DEFAULT_PROCESS_IDLE_MS = 10 * 60_000
/** Without `agent_settled` (an old pi), a run is over when `agent_end` was final and nothing else happened for this long. */
export const DEFAULT_SETTLE_QUIET_MS = 1_500
/** How long the approval bridge may take to announce itself before a turn that needs it is refused. */
export const DEFAULT_GATE_TIMEOUT_MS = 15_000
/** How long a cancelled run may take to answer `abort` before the process is stopped anyway. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000
const START_TIMEOUT_MS = 60_000
const STATE_TIMEOUT_MS = 15_000
const COMPACT_TIMEOUT_MS = 10 * 60_000
const POSITIVE = /^(allow|yes|approve|ok|proceed|continue|confirm|run)\b/i
const NEGATIVE = /^(deny|no|block|reject|cancel|stop|decline)\b/i

type Json = Record<string, any>

type ActiveTurn = {
  input: TurnInput
  mapper: ReturnType<typeof createPiMapper>
  /** Open questions to the user; the watchdog does not run while any is open. */
  waiting: number
  interrupted: boolean
  /** `agent_start` seen: events from before it belong to an earlier run. */
  started: boolean
  /** The last `agent_end` was final (no retry announced). */
  ended: boolean
  compacting: boolean
  retrying: boolean
  /** Messages in pi's own steering and follow-up queues. */
  queued: number
  steering: boolean
  completeAfterSteer: boolean
  done: boolean
  watchdog?: TimerHandle
  grace?: TimerHandle
  quiet?: TimerHandle
  touch(): void
  finish(outcome: TurnOutcome): void
}

type Dialog = { controller: AbortController; timer?: TimerHandle }

type Connection = {
  sessionId: SessionId
  policyKey: string
  /** `--model` pattern the process was started with ("" for pi's own choice). */
  pattern: string
  transport: PiTransport
  rpc: PiPeer
  ready: Promise<void>
  sessionFile?: string
  /** The approval bridge announced itself (pi loaded it). */
  gate: boolean
  gateToken: string
  gateWaiters: Array<() => void>
  /** `agent_settled` was seen on this process, so the fallback is never needed. */
  sawSettled: boolean
  /** Tool calls the user approved for the rest of the session. */
  sessionAllowed: Set<string>
  dialogs: Map<string, Dialog>
  effort?: string | undefined
  turns: number
  turn?: ActiveTurn
  compact?: { mapper: ReturnType<typeof createPiMapper>; seen: boolean }
  idle?: TimerHandle
  closed: boolean
}

export type PiEngineOptions = {
  config: { resolved(): ResolvedPiConfig; patternOf(modelId: string | undefined): string | undefined; owns(modelId: string | undefined): boolean }
  /** The session's model, or the turn's own when `override` is given. */
  modelFor(sessionId: SessionId, override?: ModelChoice): ModelChoice | undefined
  cwdFor(sessionId: SessionId): string
  /** The session's `/env` credentials: in the process environment, and their names in the system prompt when the engine has one. */
  environment?(sessionId: SessionId): EngineEnvironment | undefined
  /** Existing project-tools trust, checked before every turn and compaction. Absent means untrusted. */
  projectTrusted?(cwd: string): boolean
  sandbox?(input: { sessionId: SessionId; cwd: string }): SandboxPolicy | undefined
  /** Compaction has no TurnInput. Absent means ask. */
  permissionFor?(sessionId: SessionId): PermissionMode
  /** Native shell analysis for pi bash in smart mode. */
  smartBash?(input: { sessionId: SessionId; cwd: string; args: Record<string, unknown> }): "allow" | "ask" | "deny"
  /** What the installed pi supports (from its version); an unknown version falls back to `agent_end` plus a quiet period. */
  capabilities?(): PiCapabilities
  clock?: Clock
  /** Silence after which a turn is cut. Unset (the default) never cuts one, as the engine's own CLI does not: it times out and
   *  retries its own calls, and a long think can be quiet for minutes. */
  idleMs?: number
  processIdleMs?: number
  settleQuietMs?: number
  gateTimeoutMs?: number
  cancelGraceMs?: number
  /** Persistent MendCode session → pi session file, so a restart resumes the conversation in pi's own session store. */
  bindings?: { get(sessionId: SessionId): string | undefined; set(sessionId: SessionId, sessionFile: string): void }
  readBlob?(ref: BlobRef): Promise<Uint8Array>
  /** Whether a bound session file still exists; a missing one starts a new pi session. */
  fileExists?(path: string): boolean
  /** The approval bridge extension; written to a temporary directory on first use when absent. */
  gatePath?: string
  transportFactory?(input: { command: string; args: string[]; env: Record<string, string>; cwd: string; sandbox?: SandboxPolicy }): PiTransport
  trace?: (direction: "in" | "out", line: string) => void
}

const fail = (code: string, message: string): TurnOutcome => ({ status: "error", code, message: `[PI]: ${message}` })

const AUTH_PATTERN = /api key|no key|not logged in|log in|login|unauthori[sz]ed|authentication|credentials|\b401\b/i

/** A short single-line title for an approval. */
function gateTitle(request: GateRequest): string {
  const { tool, input } = request
  const first = (value: unknown) => (typeof value === "string" ? value.split("\n")[0]!.trim() : "")
  const subject = tool === "bash" ? first(input.command) : first(input.path)
  return `${tool}${subject ? ` ${subject}` : ""}`.slice(0, 200)
}

/** Key order does not change an operation; every argument, including nested content, does. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
const grantKey = (request: GateRequest) => createHash("sha256").update(JSON.stringify([request.tool, canonical(request.input)])).digest("hex")

/**
 * Engine for the user's own pi (`pi --mode rpc`): pi runs its own loop, tools, extensions, skills, models and login;
 * MendCode shows the turn and keeps the lifecycle in pi's hands. Sessions are pi's session files (resumed with
 * `--session` after a restart), a run ends at `agent_settled` (never at the first `agent_end`, which may be followed by a
 * retry, a compaction or queued messages), messages sent while it works are delivered as pi `steer`, `/compact` is pi's
 * `compact`, and cancel is `clear_queue`, `abort_retry` and `abort`. pi has no permission prompts: a small extension
 * written to a temporary directory asks MendCode before every tool call, so MendCode's permission mode applies, and a
 * turn outside `full` mode is refused when that bridge did not load. Extension dialogs (`confirm`, `select`, `input`,
 * `editor`) become approvals and questions. No credential of pi is read or copied.
 */
export function createPiEngine(options: PiEngineOptions): EnginePort & { stop(): void } {
  const clock = options.clock ?? realClock
  const idleMs = options.idleMs
  const processIdleMs = options.processIdleMs ?? DEFAULT_PROCESS_IDLE_MS
  const settleQuietMs = options.settleQuietMs ?? DEFAULT_SETTLE_QUIET_MS
  const gateTimeoutMs = options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
  const fileExists = options.fileExists ?? existsSync
  const connections = new Map<SessionId, Connection>()
  let created: ReturnType<typeof writeGateExtension> | undefined
  const gatePath = () => options.gatePath ?? (created ??= writeGateExtension()).path

  function cancelDialogs(connection: Connection, answer: boolean) {
    for (const [id, dialog] of connection.dialogs) {
      dialog.timer?.cancel()
      dialog.controller.abort()
      if (answer && !connection.closed) connection.rpc.send({ type: "extension_ui_response", id, cancelled: true })
    }
    connection.dialogs.clear()
  }

  function close(connection: Connection) {
    if (connection.closed) return
    connection.closed = true
    connection.idle?.cancel()
    cancelDialogs(connection, false)
    for (const wake of connection.gateWaiters.splice(0)) wake()
    // The process's own exit is ignored once it is closed here, so a turn still running ends now: cancelled, or stopped with the engine.
    const turn = connection.turn
    if (turn) {
      turn.mapper.finish(turn.interrupted ? "interrupted" : "error")
      turn.finish(turn.interrupted ? { status: "ok" } : fail("pi_stopped", "pi was stopped during the turn"))
    }
    if (connections.get(connection.sessionId) === connection) connections.delete(connection.sessionId)
    connection.rpc.close()
  }

  /** Answers a dialog once; a dialog that was cancelled, timed out or whose process is gone is dropped silently. */
  function reply(connection: Connection, id: string, body: Json) {
    const dialog = connection.dialogs.get(id)
    if (!dialog || connection.closed) return
    connection.dialogs.delete(id)
    dialog.timer?.cancel()
    connection.rpc.send({ type: "extension_ui_response", id, ...body })
  }

  async function ask(turn: ActiveTurn, request: EngineRequest, signal: AbortSignal): Promise<EngineResolution> {
    turn.waiting++
    turn.watchdog?.cancel()
    try {
      return await turn.input.ask({ ...request, signal })
    } finally {
      turn.waiting--
      turn.touch()
    }
  }

  /** The decision for one tool call of the bridge: reads always pass; `full` passes all; `edits` passes writes; `plan` refuses the rest; otherwise the user is asked. */
  async function gateDecision(connection: Connection, turn: ActiveTurn, request: GateRequest, signal: AbortSignal): Promise<"allow" | "deny"> {
    const permission = piToolPermission(request.tool)
    const mode: PermissionMode = turn.input.permissionMode()
    if (mode !== "full" && !connection.gate) return "deny"
    if (permission === "read") return "allow"
    if (mode === "plan") return "deny"
    const smart = mode === "smart" && request.tool === "bash" ? options.smartBash?.({ sessionId: connection.sessionId, cwd: options.cwdFor(connection.sessionId), args: request.input }) : undefined
    if (smart === "deny") return "deny"
    if (smart === "allow") return "allow"
    if (mode === "full" || (mode === "edits" && permission === "write") || connection.sessionAllowed.has(grantKey(request))) return "allow"
    const itemId = turn.mapper.itemOf(request.id)
    const answer = await ask(turn, { kind: "approval", title: gateTitle(request), detail: gateDetail(request).slice(0, MAX_TEXT), tool: request.tool, permission, ...(itemId ? { itemId } : {}) }, signal)
    if (answer.kind !== "approve") return "deny"
    if (answer.scope === "session") connection.sessionAllowed.add(grantKey(request))
    return "allow"
  }

  /** The `extension_ui_response` body for a dialog an extension of pi opened. */
  async function dialogAnswer(turn: ActiveTurn, event: Json, signal: AbortSignal): Promise<Json> {
    const cancelled = { cancelled: true }
    const title = String(event.title ?? "pi extension").slice(0, 200)
    const mode: PermissionMode = turn.input.permissionMode()
    if (event.method === "confirm") {
      // pi's extensions gate dangerous actions with confirm; plan mode refuses them instead of asking.
      if (mode === "plan") return { confirmed: false }
      const answer = await ask(turn, { kind: "approval", title, detail: String(event.message ?? "").slice(0, MAX_TEXT), tool: "pi extension", permission: "execute" }, signal)
      return answer.kind === "approve" ? { confirmed: true } : answer.kind === "deny" ? { confirmed: false } : cancelled
    }
    if (event.method === "select") {
      const options: string[] = Array.isArray(event.options) ? event.options.filter((option: unknown) => typeof option === "string") : []
      const positive = options.find((option) => POSITIVE.test(option))
      const negative = options.find((option) => NEGATIVE.test(option))
      if (options.length >= 2 && options.length <= 4 && positive && negative) {
        if (mode === "plan") return { value: negative }
        const answer = await ask(turn, { kind: "approval", title: title.split("\n")[0]!, detail: title.slice(0, MAX_TEXT), tool: "pi extension", permission: "execute" }, signal)
        return answer.kind === "approve" ? { value: positive } : answer.kind === "deny" ? { value: negative } : cancelled
      }
      const answer = await ask(turn, { kind: "question", title, detail: "", options: options.map((label) => ({ label })) }, signal)
      if (answer.kind !== "answer") return cancelled
      const picked = options.find((option) => option.toLowerCase() === answer.text.trim().toLowerCase())
      return picked ? { value: picked } : cancelled
    }
    if (event.method === "input" || event.method === "editor") {
      const detail = event.method === "editor" ? String(event.prefill ?? "") : String(event.placeholder ?? "")
      const answer = await ask(turn, { kind: "question", title, detail: detail.slice(0, MAX_TEXT) }, signal)
      return answer.kind === "answer" ? { value: answer.text } : cancelled
    }
    return cancelled
  }

  function onDialog(connection: Connection, event: Json) {
    const id = String(event.id ?? "")
    const method = String(event.method ?? "")
    if (method === "setStatus") {
      if (event.statusKey === GATE_STATUS_KEY && event.statusText === `${GATE_READY}:${connection.gateToken}`) {
        connection.gate = true
        for (const wake of connection.gateWaiters.splice(0)) wake()
      }
      return
    }
    // Fire-and-forget methods (notify, setWidget, setTitle, set_editor_text) have nothing to show in a transcript.
    if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return
    const turn = connection.turn
    // Nobody is there to answer outside a turn.
    if (!turn || turn.done || !id) {
      if (id && !connection.closed) connection.rpc.send({ type: "extension_ui_response", id, cancelled: true })
      return
    }
    const controller = new AbortController()
    const dialog: Dialog = { controller }
    // pi resolves a dialog with a timeout by itself; ours disappears with it.
    if (typeof event.timeout === "number" && event.timeout > 0) {
      dialog.timer = clock.setTimer(event.timeout, () => {
        connection.dialogs.delete(id)
        controller.abort()
      })
    }
    connection.dialogs.set(id, dialog)
    void (async () => {
      const gate = method === "select" ? parseGateRequest(event.title) : undefined
      let body: Json
      try {
        body = gate ? { value: await gateDecision(connection, turn, gate, controller.signal) } : await dialogAnswer(turn, event, controller.signal)
      } catch {
        body = { cancelled: true }
      }
      if (controller.signal.aborted) return
      reply(connection, id, body)
    })()
  }

  function settledCapable(connection: Connection) {
    return connection.sawSettled || options.capabilities?.().settled === true
  }

  /** Ends the turn according to how pi's last assistant message ended. */
  function complete(connection: Connection, turn: ActiveTurn) {
    if (turn.done) return
    if (turn.steering) {
      // A message is being handed to pi; decide again when that is done.
      turn.completeAfterSteer = true
      return
    }
    const last = turn.mapper.lastMessage()
    const failure = turn.mapper.retryFailure()
    if (turn.interrupted || (last.stopReason === "aborted" && !failure)) {
      turn.mapper.finish("interrupted")
      return turn.finish({ status: "ok" })
    }
    if (failure || last.stopReason === "error") {
      turn.mapper.finish("error")
      const message = failure ?? last.errorMessage ?? "pi reported an error"
      if (AUTH_PATTERN.test(message)) return turn.finish(fail("pi_auth", `pi could not authenticate (${message.slice(0, 200)}); sign in inside pi itself (its /login), MendCode does not handle pi's credentials`))
      return turn.finish(fail(failure ? "pi_retry_failed" : "pi_turn_failed", message.slice(0, 1_000)))
    }
    turn.mapper.finish("ok")
    if (last.stopReason === "length") return turn.finish(fail("pi_limit", "pi stopped: output limit reached"))
    turn.finish({ status: "ok" })
  }

  /** Fallback for a pi without `agent_settled`: the run is over after a quiet period that follows a final `agent_end`. */
  function armQuiet(connection: Connection, turn: ActiveTurn) {
    turn.quiet?.cancel()
    if (settledCapable(connection) || !turn.started || !turn.ended || turn.compacting || turn.retrying || turn.queued > 0 || turn.done) return
    turn.quiet = clock.setTimer(settleQuietMs, () => complete(connection, turn))
  }

  /** After `prompt` was accepted without any run starting (an extension command, a handled template), pi's own state says whether it is idle. */
  async function idleCheck(connection: Connection, turn: ActiveTurn, afterSteer = false) {
    if (turn.done || (turn.started && !afterSteer)) return
    const state = (await connection.rpc.command("get_state", {}, { timeoutMs: STATE_TIMEOUT_MS }).catch(() => undefined)) as Json | undefined
    if (!state || turn.done || connection.closed || (turn.started && !afterSteer) || turn.steering) return
    if (state.isStreaming === false && state.isCompacting === false && Number(state.pendingMessageCount ?? 0) === 0) {
      turn.started = true
      turn.ended = true
      complete(connection, turn)
    }
  }

  async function content(input: Pick<TurnInput, "text" | "attachments">, connection: Connection): Promise<{ message: string; images: Array<{ type: "image"; data: string; mimeType: string }> }> {
    const images: Array<{ type: "image"; data: string; mimeType: string }> = []
    const markers: string[] = []
    // pi takes one message and a list of images, so it cannot interleave: the images follow the order of the tokens in the text, which keeps its labels.
    for (const at of attachmentOrder(input.text, input.attachments)) {
      const ref = input.attachments[at]!
      if (ref.mime.startsWith("image/") && options.readBlob) {
        const bytes = await options.readBlob(ref).catch(() => undefined)
        if (bytes) {
          images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: ref.mime })
          continue
        }
      }
      markers.push(`[attachment ${ref.name ?? ref.sha256.slice(0, 12)} · ${ref.mime} · not sent]`)
    }
    return { message: [...markers, input.text].join("\n"), images }
  }

  /** Hands a message the user queued while the run works to pi as `steer`; when pi has no run left it starts one with `prompt`. */
  async function steerQueued(connection: Connection, turn: ActiveTurn) {
    const take = turn.input.takeQueued
    if (turn.steering || !take) return
    turn.steering = true
    try {
      for (let count = 0; count < 64 && !turn.interrupted && !turn.done && !connection.closed; count++) {
        const queued = await take()
        if (!queued) break
        const body = await content(queued, connection)
        const fields = { message: body.message, ...(body.images.length ? { images: body.images } : {}) }
        try {
          await connection.rpc.command("steer", fields, { timeoutMs: STATE_TIMEOUT_MS })
        } catch (error) {
          if (!(error instanceof PiRpcError) || connection.closed) throw error
          // The run had ended: the message starts the next one inside the same turn.
          turn.started = false
          turn.ended = false
          turn.quiet?.cancel()
          await connection.rpc.command("prompt", fields, { timeoutMs: STATE_TIMEOUT_MS })
          void idleCheck(connection, turn)
        }
      }
    } catch (error) {
      turn.mapper.finish("error")
      turn.finish(fail("pi_steer_failed", error instanceof Error ? error.message : String(error)))
    } finally {
      turn.steering = false
      // An end was held back while the message was handed over: pi's own state says whether it is really idle.
      if (turn.completeAfterSteer && !turn.done) {
        turn.completeAfterSteer = false
        void idleCheck(connection, turn, true)
      }
    }
  }

  function onEvent(connection: Connection, event: Json) {
    if (event.type === "extension_ui_request") return onDialog(connection, event)
    if (event.type === "agent_settled") connection.sawSettled = true
    const turn = connection.turn
    if (!turn || turn.done) {
      if (connection.compact && (event.type === "compaction_start" || event.type === "compaction_end")) {
        connection.compact.seen = true
        connection.compact.mapper.accept(event)
      }
      return
    }
    turn.quiet?.cancel()
    turn.touch()
    switch (event.type) {
      case "agent_start":
        turn.started = true
        turn.ended = false
        return
      case "agent_end":
        // A run that will retry is not over.
        if (turn.started) turn.ended = event.willRetry !== true
        return armQuiet(connection, turn)
      case "agent_settled":
        // A settled event before this turn's own agent_start is the previous run's.
        if (turn.started) complete(connection, turn)
        return
      case "queue_update":
        turn.queued = (Array.isArray(event.steering) ? event.steering.length : 0) + (Array.isArray(event.followUp) ? event.followUp.length : 0)
        return armQuiet(connection, turn)
      case "turn_end":
        void steerQueued(connection, turn)
        return
      case "compaction_start":
        turn.compacting = true
        break
      case "compaction_end":
        turn.compacting = false
        break
      case "auto_retry_start":
        turn.retrying = true
        break
      case "auto_retry_end":
        turn.retrying = false
        break
    }
    turn.mapper.accept(event)
    if (event.type === "compaction_end" || event.type === "auto_retry_end") armQuiet(connection, turn)
  }

  function onClosed(connection: Connection) {
    if (connection.closed) return
    const tail = connection.transport.stderrTail()
    const turn = connection.turn
    // Answers to dialogs of this process can no longer be delivered; the questions go away.
    cancelDialogs(connection, false)
    turn?.mapper.finish("error")
    turn?.finish(fail("pi_exited", `pi exited during the turn${tail ? `: ${tail.slice(-1_000)}` : ""}`))
    close(connection)
  }

  function open(sessionId: SessionId, pattern: string, policy: { cwd: string; trusted: boolean; sandbox: SandboxPolicy | undefined; environment: EngineEnvironment | undefined; key: string }): Connection {
    const { cwd, trusted, sandbox } = policy
    const config = options.config.resolved()
    const disableExtensions = options.capabilities?.().disableExtensions === true
    // Explicit -e paths survive --no-extensions. Refuse extras until trust is granted, including package sources.
    if (!trusted && config.args.some((arg) => arg === "-e" || arg === "--extension" || arg.startsWith("--extension="))) throw new Error("pi extensions supplied through pi.json require project trust; trust this project in /extensions")
    if (config.args.includes("--")) throw new Error("pi.json args cannot end option parsing before MendCode's safety flags")
    const bound = options.bindings?.get(sessionId)
    // A session file that is gone (pi's own store was cleaned) starts a new pi session instead of failing.
    const file = bound && fileExists(bound) ? bound : undefined
    const args = ["--mode", "rpc", ...config.args, ...(policy.environment?.note ? ["--append-system-prompt", policy.environment.note] : []), ...(!trusted && disableExtensions ? ["--no-extensions"] : []), "-e", gatePath(), ...(config.sessionDir ? ["--session-dir", config.sessionDir] : []), ...(file ? ["--session", file] : []), ...(pattern ? ["--model", pattern] : [])]
    const gateToken = randomUUID()
    const launch = { command: config.command, args, env: { ...config.env, ...policy.environment?.values, [GATE_TOKEN_ENV]: gateToken }, cwd, ...(sandbox ? { sandbox } : {}) }
    const transport = options.transportFactory?.(launch) ?? spawnPi(launch)
    const connection: Connection = { sessionId, pattern, policyKey: policy.key, transport, rpc: undefined as unknown as PiPeer, ready: Promise.resolve(), gate: false, gateToken, gateWaiters: [], sawSettled: false, sessionAllowed: new Set(), dialogs: new Map(), turns: 0, closed: false }
    connection.rpc = createPiPeer({
      transport,
      trace: options.trace,
      handlers: { onEvent: (event) => onEvent(connection, event), onClosed: () => onClosed(connection) },
    })
    connections.set(sessionId, connection)
    connection.ready = (async () => {
      const state = (await connection.rpc.command("get_state", {}, { timeoutMs: START_TIMEOUT_MS })) as Json | undefined
      remember(connection, state)
    })()
    // A failed start is reported by runTurn; without this a connection nobody awaits would be an unhandled rejection.
    connection.ready.catch(() => undefined)
    return connection
  }

  function remember(connection: Connection, state: Json | undefined) {
    const file = state?.sessionFile
    if (typeof file !== "string" || !file || file === connection.sessionFile) return
    connection.sessionFile = file
    options.bindings?.set(connection.sessionId, file)
  }

  async function connectionFor(sessionId: SessionId, pattern: string): Promise<Connection> {
    const cwd = options.cwdFor(sessionId)
    const trusted = options.projectTrusted?.(cwd) === true
    const sandbox = options.sandbox?.({ sessionId, cwd })
    // Unknown/older pi builds fail closed when project resources could contain extensions or package declarations.
    if (!trusted && options.capabilities?.().disableExtensions !== true && existsSync(join(cwd, ".pi"))) {
      const connection = connections.get(sessionId)
      if (connection) close(connection)
      throw new Error("pi cannot disable project extensions; trust this project in /extensions or update pi")
    }
    const environment = options.environment?.(sessionId)
    const policy = { cwd, trusted, sandbox, environment, key: JSON.stringify([cwd, trusted, sandbox, environmentKey(environment)]) }
    let connection = connections.get(sessionId)
    // Trust revocation and sandbox changes must not reuse a less confined process; new `/env` credentials need a new one too.
    if (connection && (connection.pattern !== pattern || connection.policyKey !== policy.key)) {
      close(connection)
      connection = undefined
    }
    connection ??= open(sessionId, pattern, policy)
    connection.idle?.cancel()
    try {
      await connection.ready
    } catch (error) {
      const tail = connection.transport.stderrTail()
      close(connection)
      // A pi that died while starting explains itself on stderr.
      if (tail) throw new Error(`${error instanceof Error ? error.message : String(error)}: ${tail.slice(-500)}`)
      throw error
    }
    return connection
  }

  function startMessage(error: unknown): TurnOutcome {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|not found|No such file/i.test(message)) return fail("pi_missing", "could not start pi: command not found (install pi or set \"command\" in pi.json)")
    if (AUTH_PATTERN.test(message)) return fail("pi_auth", "pi needs you to sign in; run pi itself and use its /login")
    return fail("pi_start", `pi did not start: ${message}`)
  }

  /** On a process that already served a turn: pi must be idle (a cut-off run is aborted first), and the reasoning level follows the choice. */
  async function prepare(connection: Connection, choice: ModelChoice | undefined) {
    if (connection.turns > 0) {
      const state = (await connection.rpc.command("get_state", {}, { timeoutMs: STATE_TIMEOUT_MS })) as Json | undefined
      remember(connection, state)
      if (state?.isStreaming === true || state?.isCompacting === true) await connection.rpc.command("abort", {}, { timeoutMs: cancelGraceMs }).catch(() => undefined)
    }
    if (choice?.effort && connection.effort !== choice.effort) {
      // A model without reasoning refuses the level; that is not an error of the turn.
      await connection.rpc.command("set_thinking_level", { level: choice.effort }, { timeoutMs: STATE_TIMEOUT_MS }).then(() => (connection.effort = choice.effort), () => undefined)
    }
  }

  function waitForGate(connection: Connection): Promise<boolean> {
    if (connection.gate) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = clock.setTimer(gateTimeoutMs, () => {
        connection.gateWaiters = connection.gateWaiters.filter((wake) => wake !== done)
        resolve(connection.gate)
      })
      const done = () => {
        timer.cancel()
        resolve(connection.gate)
      }
      connection.gateWaiters.push(done)
    })
  }

  /** Cancel: pi's queued messages are dropped (they would run after the abort), a retry wait is ended, then the run is aborted; pi answers `abort` once it is idle. */
  function cancelTurn(connection: Connection, turn: ActiveTurn) {
    turn.interrupted = true
    cancelDialogs(connection, true)
    turn.grace = clock.setTimer(cancelGraceMs, () => {
      turn.mapper.finish("interrupted")
      turn.finish({ status: "ok" })
      close(connection)
    })
    void (async () => {
      const quick = { timeoutMs: cancelGraceMs }
      if (turn.retrying) await connection.rpc.command("abort_retry", {}, quick).catch(() => undefined)
      await connection.rpc.command("clear_queue", {}, quick).catch(() => undefined)
      await connection.rpc.command("abort", {}, quick).catch(() => undefined)
      turn.mapper.finish("interrupted")
      turn.finish({ status: "ok" })
    })()
  }

  return {
    async runTurn(input) {
      if (input.signal.aborted) return { status: "ok" }
      const choice = options.modelFor(input.sessionId, input.selection?.model)
      if (!options.config.owns(choice?.model)) return fail("pi_no_model", "this session's model is not a pi model (is pi.json present?)")
      const pattern = options.config.patternOf(choice?.model) ?? ""
      let connection: Connection
      try {
        connection = await connectionFor(input.sessionId, pattern)
      } catch (error) {
        return startMessage(error)
      }
      try {
        await prepare(connection, choice)
      } catch (error) {
        close(connection)
        return fail("pi_start", `pi did not answer: ${error instanceof Error ? error.message : String(error)}`)
      }
      // pi has no permission prompts of its own: outside `full` mode the bridge must be loaded or nothing runs.
      if (input.permissionMode() !== "full" && !(await waitForGate(connection))) {
        close(connection)
        return fail("pi_gate_missing", "pi did not load MendCode's approval bridge, so tool calls cannot be approved; use full permission mode or update pi")
      }
      if (connection.closed) return fail("pi_exited", "pi exited before the turn started")
      const body = await content(input, connection)
      // A cancel while pi started or the attachments were read: its abort event is gone, so nothing may be sent now.
      if (input.signal.aborted) {
        if (!connection.closed) connection.idle = clock.setTimer(processIdleMs, () => close(connection))
        return { status: "ok" }
      }
      connection.turns++
      return new Promise<TurnOutcome>((resolve) => {
        let settled = false
        const turn: ActiveTurn = {
          input,
          mapper: createPiMapper({ newItemId: input.newItemId, emit: input.emit }),
          waiting: 0,
          interrupted: false,
          started: false,
          ended: false,
          compacting: false,
          retrying: false,
          queued: 0,
          steering: false,
          completeAfterSteer: false,
          done: false,
          touch() {
            turn.watchdog?.cancel()
            if (settled || turn.waiting > 0 || idleMs === undefined) return
            turn.watchdog = clock.setTimer(idleMs, () => {
              cancelDialogs(connection, true)
              void connection.rpc.command("abort", {}, { timeoutMs: cancelGraceMs }).catch(() => close(connection))
              turn.mapper.finish("interrupted")
              turn.finish(fail("stream_idle", `no activity from pi for ${Math.round(idleMs / 1000)} s; turn aborted`))
            })
          },
          finish(outcome) {
            if (settled) return
            settled = true
            turn.done = true
            turn.watchdog?.cancel()
            turn.grace?.cancel()
            turn.quiet?.cancel()
            if (connection.turn === turn) delete connection.turn
            if (!connection.closed) connection.idle = clock.setTimer(processIdleMs, () => close(connection))
            resolve(outcome)
          },
        }
        connection.turn = turn
        turn.touch()
        input.signal.addEventListener("abort", () => cancelTurn(connection, turn), { once: true })
        connection.rpc.command("prompt", { message: body.message, ...(body.images.length ? { images: body.images } : {}) }, { timeoutMs: STATE_TIMEOUT_MS }).then(
          () => void idleCheck(connection, turn),
          (error: unknown) => {
            turn.mapper.finish("error")
            if (turn.interrupted) return turn.finish({ status: "ok" })
            turn.finish(fail("pi_rejected", error instanceof Error ? error.message : String(error)))
          },
        )
      })
    },
    needsCompaction: () => false,
    // pi compacts its own context; /compact asks it to.
    async compact(input) {
      const choice = options.modelFor(input.sessionId)
      if (!options.config.owns(choice?.model)) return { status: "ok" }
      let connection: Connection
      try {
        connection = await connectionFor(input.sessionId, options.config.patternOf(choice?.model) ?? "")
      } catch (error) {
        return startMessage(error)
      }
      if ((options.permissionFor?.(input.sessionId) ?? "ask") !== "full" && !(await waitForGate(connection))) {
        close(connection)
        return fail("pi_gate_missing", "pi did not load MendCode's approval bridge; compaction refused")
      }
      if (connection.closed) return fail("pi_exited", "pi exited before compaction started")
      const mapper = createPiMapper({ newItemId: input.newItemId, emit: input.emit })
      connection.compact = { mapper, seen: false }
      const abort = () => void connection.rpc.command("abort", {}, { timeoutMs: cancelGraceMs }).catch(() => undefined)
      input.signal.addEventListener("abort", abort, { once: true })
      try {
        const data = (await connection.rpc.command("compact", input.instructions ? { customInstructions: input.instructions } : {}, { timeoutMs: COMPACT_TIMEOUT_MS })) as Json | undefined
        // A pi that answered without streaming compaction events still gets its card.
        if (!connection.compact.seen && typeof data?.summary === "string") {
          const itemId = input.newItemId()
          input.emit({ type: "item.started", itemId, kind: "compaction", meta: { engine: "pi" } })
          input.emit({ type: "item.completed", itemId, status: "ok", text: data.summary.slice(0, MAX_TEXT) })
        }
        mapper.finish("ok")
        return { status: "ok" }
      } catch (error) {
        mapper.finish("error")
        return input.signal.aborted ? { status: "ok" } : fail("pi_compact_failed", error instanceof Error ? error.message : String(error))
      } finally {
        input.signal.removeEventListener("abort", abort)
        delete connection.compact
        if (!connection.closed) connection.idle = clock.setTimer(processIdleMs, () => close(connection))
      }
    },
    stop() {
      for (const connection of [...connections.values()]) close(connection)
      created?.remove()
      created = undefined
    },
  }
}
