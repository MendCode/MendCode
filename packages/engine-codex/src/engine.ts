import { readFile } from "node:fs/promises"
import type { BlobRef, ItemId, ItemKind, SessionId, TodoListItem } from "@mendcode/protocol"
import { createPlanTurnNotes, todoListCard, todoListStatus } from "@mendcode/protocol/wire"
import { processMcpTurn, realClock, type Clock, type EngineEnvironment, type EnginePort, type EngineResolution, type GlobalEventDraft, type TimerHandle, type TurnInput, type TurnOutcome } from "@mendcode/kernel"
import { createRpc, spawnCodex, type Transport } from "./rpc"
import { codexLanguageInstruction, codexRunLimits, type CodexRunLimits } from "./run-limits"

/** The user's constraint for every AI call in development: one model, low effort. */
export const CODEX_MODEL = "gpt-6-luna"
export const CODEX_EFFORT = "low"
const MAX_TEXT = 60 * 1024

type ActiveTurn = {
  input: TurnInput
  codexTurnId?: string
  items: Map<string, ItemId>
  /** Items still being finished (a generated image being stored); the turn ends after them. */
  pending?: Promise<void>[]
  /** While the user decides on an approval, silence is expected and the watchdog is paused. */
  waitingUser: boolean
  watchdog?: TimerHandle
  /** The app-server process the turn runs in: its exit ends the turn. */
  transport?: Transport
  touch(): void
  finish(outcome: TurnOutcome): void
}

type QuotaDraft = Extract<GlobalEventDraft, { type: "quota.snapshot" }>

const KIND: Record<string, ItemKind | undefined> = {
  agentMessage: "agent_message",
  reasoning: "reasoning",
  commandExecution: "tool_call",
  fileChange: "tool_call",
  mcpToolCall: "tool_call",
  dynamicToolCall: "tool_call",
  webSearch: "tool_call",
  imageGeneration: "tool_call",
  plan: "artifact",
  contextCompaction: "compaction",
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  return undefined
}

function clip(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text
}

/**
 * A `turn/plan/updated` checklist (`plan: [{step, status: pending|inProgress|completed}]`) as MendCode's list card; an empty plan is an
 * empty card (it clears the list), none when `plan` is not a list.
 */
export function codexPlanCard(plan: unknown): { title: string; text: string } | undefined {
  if (!Array.isArray(plan)) return undefined
  return todoListCard(plan.flatMap((entry): TodoListItem[] => {
    const step = entry && typeof entry === "object" && typeof entry.step === "string" ? entry.step.trim() : ""
    return step ? [{ text: step, status: todoListStatus(entry.status) }] : []
  }))
}

/** `/bin/zsh -lc 'ls -la'` → `ls -la`: show the command the agent meant, not the shell wrapper. */
export function commandTitle(command: string) {
  const match = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(.+)$/s.exec(command.trim())
  if (!match) return command.trim()
  const inner = match[1]!.trim()
  const quoted = /^(['"])([\s\S]*)\1$/.exec(inner)
  return (quoted ? quoted[2]! : inner).trim()
}

function toolTitle(item: any): string {
  if (item.type === "commandExecution") return commandTitle(String(item.command ?? "comando"))
  if (item.type === "fileChange") return `editar ${(item.changes ?? []).map((c: any) => c.path).filter(Boolean).slice(0, 3).join(", ")}`
  if (item.type === "mcpToolCall") return `${item.server}.${item.tool}`
  if (item.type === "dynamicToolCall") return String(item.tool)
  // The same card as the native engine's hosted image tool.
  if (item.type === "imageGeneration") return "image_generation"
  return String(item.type)
}

function windowLabel(minutes: number) {
  if (minutes % 10_080 === 0) return `${minutes / 10_080 * 7}d`
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

export function codexQuota(rateLimits: any, fetchedAt: number): QuotaDraft | undefined {
  if (!rateLimits) return undefined
  const windows = (["primary", "secondary"] as const)
    .map((key) => ({ key, window: rateLimits[key] }))
    .filter(({ window }) => window && typeof window.usedPercent === "number")
    .map(({ key, window }) => ({
      id: key,
      label: typeof window.windowDurationMins === "number" ? windowLabel(window.windowDurationMins) : key,
      usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
      ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt * 1000 } : {}),
      ...(typeof window.windowDurationMins === "number" ? { windowMinutes: window.windowDurationMins } : {}),
    }))
  if (windows.length === 0) return undefined
  return {
    type: "quota.snapshot",
    provider: "codex",
    ...(typeof rateLimits.planType === "string" ? { plan: rateLimits.planType } : {}),
    windows,
    status: rateLimits.rateLimitReachedType ? "rejected" : "allowed",
    fetchedAt,
    source: "codex app-server account/rateLimits",
  }
}

/**
 * Engine backed by the user's Codex subscription through the official `codex app-server` protocol.
 * No credentials are read or copied: Codex authenticates itself. The process starts on first use
 * and is shared by all sessions (P6).
 */
/** Codex's own default drops inherited variables named like a key, secret or token: the credentials are kept, and the daemon's other such variables, and the bridge's bearers (`own`), still are dropped, by name. */
function credentialArgs(environment: EngineEnvironment | undefined, own: readonly string[]): string[] {
  if (!environment || !Object.keys(environment.values).length) return []
  const hidden = [...Object.keys(process.env).filter((name) => /KEY|SECRET|TOKEN/i.test(name) && !(name in environment.values)), ...own]
  return ["-c", "shell_environment_policy.ignore_default_excludes=true", "-c", `shell_environment_policy.exclude=${JSON.stringify(hidden)}`]
}

type HostServer = NonNullable<NonNullable<TurnInput["externalMcp"]>["servers"]>[number]
/** A MendCode tool call can wait on the user's approval card or a long computer-use step; Codex's own default cuts one at 60 s. */
const HOST_TOOL_TIMEOUT_SEC = 86_400

/**
 * MendCode's own tools (the daemon's loopback bridge) as this process's `mcp_servers`. The bearer is in the process environment
 * (`bearer_token_env_var`, a name with TOKEN in it, which Codex keeps out of its shells), never on the command line. MendCode asks
 * before it runs a call, so Codex does not ask again (`default_tools_approval_mode = "approve"`).
 */
function hostServerConfig(servers: readonly HostServer[]) {
  const args: string[] = []
  const env: Record<string, string> = {}
  const names = new Set<string>()
  for (const server of servers) {
    const token = /^Bearer (.+)$/.exec(server.headers.find((header) => header.name.toLowerCase() === "authorization")?.value ?? "")?.[1]
    if (!token || !/^[A-Za-z0-9_]+$/.test(server.name)) continue
    const variable = `MENDCODE_MCP_TOKEN_${server.name.toUpperCase()}`
    const key = `mcp_servers.${server.name}`
    env[variable] = token
    names.add(server.name)
    args.push("-c", `${key}.url=${JSON.stringify(server.url)}`, "-c", `${key}.bearer_token_env_var=${JSON.stringify(variable)}`, "-c", `${key}.default_tools_approval_mode="approve"`, "-c", `${key}.tool_timeout_sec=${HOST_TOOL_TIMEOUT_SEC}`)
  }
  return { args, env, names }
}

/** Codex is told only that its sandbox is read-only, so every turn in plan carries a short note; module-wide because a turn with its own MCP servers runs in a fresh engine. */
const planNotes = createPlanTurnNotes("reply")

export function createCodexEngine(options: {
  cwd: string
  bin?: string
  now?: () => number
  clock?: Clock
  /** Silence after which a turn is cut. Unset (the default) never cuts one, as the engine's own CLI does not: it times out and
   *  retries its own calls, and a long think can be quiet for minutes. */
  idleMs?: number
  processArgs?: string[]
  waitingForMcp?: (() => boolean) | undefined
  /** For explicitly selected Codex catalog models; the legacy Codex daemon keeps its fixed defaults. */
  model?: string
  effort?: string
  /** `/fast`: Codex's fast service tier (`service_tier = "fast"`, developers.openai.com/codex/speed) for this process. */
  fast?: boolean
  onQuota?(snapshot: QuotaDraft): void
  /** The session's `/env` credentials: in the process environment, and their names in the thread's developer instructions. */
  environment?: EngineEnvironment | undefined
  /** The session's run limits (`codexRunLimits`): a PR review child or fix session loads nothing of its checkout's own Codex setup. */
  runLimits?: CodexRunLimits | undefined
  /** Text for a project directory added to the thread's developer instructions, after Codex's own (which stay): what MendCode draws that Codex's terminal does not. */
  appendSystem?(cwd: string): string | undefined
  /** MendCode's own tools (code graph, computer use, image_gen, memory, settings…) for the one session this process serves, through the daemon's loopback MCP bridge. */
  hostServers?: readonly HostServer[]
  /** What the model is told about those tools. Codex keeps an MCP server's `instructions` out of the model's prompt (0.162), so they join the thread's developer instructions. */
  hostInstructions?: string | undefined
  /** What the model is told about this process's own MCP servers (`externalMcp.instructions`, the thread bridge's delegation and models). */
  processInstructions?: string | undefined
  transportFactory?: (input: { args: string[]; cwd: string; env?: Record<string, string> }) => Transport
  /** Stores an image Codex generated (it saves it under `savedPath`), so the transcript shows it as for a native session. */
  storeImage?(bytes: Uint8Array, mime: string, sessionId: SessionId): Promise<BlobRef>
  /** Debug aid: receives every raw JSON-RPC line (in/out). */
  trace?: (direction: "in" | "out", line: string) => void
  /** Persistent session → Codex thread mapping (the store), so a restart resumes the conversation. */
  bindings?: { get(sessionId: SessionId): string | undefined; set(sessionId: SessionId, threadId: string): void }
}): EnginePort & { stop(): void } {
  const clock = options.clock ?? realClock
  const now = options.now ?? (() => clock.now())
  const idleMs = options.idleMs
  const model = options.model ?? CODEX_MODEL
  const effort = options.effort ?? CODEX_EFFORT
  const host = hostServerConfig(options.hostServers ?? [])
  const isolated = new Set<ReturnType<typeof createCodexEngine>>()
  const threads = new Map<SessionId, string>()
  const turnsByCodexTurn = new Map<string, ActiveTurn>()
  const turnsByThread = new Map<string, ActiveTurn>()
  /** Each thread's last plan checklist, so a repeated `turn/plan/updated` adds no card. */
  const lastPlan = new Map<string, string>()
  let rpc: ReturnType<typeof createRpc> | undefined
  let transport: Transport | undefined
  let ready: Promise<void> | undefined

  function turnFor(params: any) {
    return (params?.turnId && turnsByCodexTurn.get(params.turnId)) || (params?.threadId && turnsByThread.get(params.threadId)) || undefined
  }

  function itemFor(turn: ActiveTurn, codexItemId: string) {
    return turn.items.get(codexItemId)
  }

  function onNotification(method: string, params: any) {
    if (method === "account/rateLimits/updated") {
      const quota = codexQuota(params?.rateLimits, now())
      if (quota) options.onQuota?.(quota)
      return
    }
    const turn = turnFor(params)
    if (!turn) return
    turn.touch()
    const input = turn.input
    switch (method) {
      case "turn/started":
        turn.codexTurnId = params.turn?.id
        if (turn.codexTurnId) turnsByCodexTurn.set(turn.codexTurnId, turn)
        return
      case "item/started": {
        const kind = KIND[params.item?.type]
        // A call of MendCode's own tools runs in the bridge as a call of this turn, which draws its card: none here.
        if (!kind || (params.item.type === "mcpToolCall" && host.names.has(params.item.server))) return
        const itemId = input.newItemId()
        turn.items.set(params.item.id, itemId)
        input.emit({ type: "item.started", itemId, kind, ...(kind === "tool_call" ? { meta: { tool: toolTitle(params.item).slice(0, 200) } } : {}) })
        return
      }
      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta": {
        const itemId = itemFor(turn, params.itemId)
        if (itemId && typeof params.delta === "string" && params.delta) input.emit({ type: "item.delta", itemId, text: params.delta.slice(0, MAX_TEXT) })
        return
      }
      case "item/completed": {
        const itemId = itemFor(turn, params.item?.id)
        if (!itemId) return
        const item = params.item
        const text =
          item.type === "agentMessage" ? item.text : item.type === "reasoning" ? (item.summary ?? []).join("\n") : item.type === "commandExecution" ? item.aggregatedOutput ?? "" : undefined
        const failed = item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0)
        if (item.type === "imageGeneration") {
          ;(turn.pending ??= []).push(generatedImage(item, input.sessionId).then((refs) => {
            const detail = [item.revisedPrompt, item.savedPath, item.failure?.message ?? (typeof item.failure === "string" ? item.failure : undefined)].filter((part) => typeof part === "string" && part).join("\n")
            input.emit({ type: "item.completed", itemId, status: failed || !item.savedPath ? "error" : "ok", ...(detail ? { text: clip(detail) } : {}), ...(refs.length ? { attachments: refs } : {}) })
          }))
          return
        }
        input.emit({ type: "item.completed", itemId, status: failed ? "error" : "ok", ...(typeof text === "string" ? { text: clip(text) } : {}) })
        return
      }
      // `update_plan`: Codex sends the whole checklist each time. It becomes MendCode's own list card (`todo d/n`), so the progress row
      // and the dock show it; an update that repeats the last list draws nothing, an empty one after a list clears it. (The `plan` item is
      // plan mode's proposal, prose: an artifact.)
      case "turn/plan/updated": {
        const card = codexPlanCard(params?.plan)
        if (!card || (lastPlan.get(params?.threadId) ?? "") === card.text) return
        lastPlan.set(params?.threadId, card.text)
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: card.title } })
        input.emit({ type: "item.completed", itemId, status: "ok", text: clip(card.text) })
        return
      }
      case "thread/tokenUsage/updated": {
        const last = params.tokenUsage?.last
        if (!last) return
        // `last` is one call (the thread's `total` is the running sum and is never the context): its prompt, cache included, plus its answer.
        const measured = Math.max(0, (last.inputTokens ?? 0) + (last.outputTokens ?? 0))
        const reported = params.tokenUsage?.modelContextWindow
        const contextWindow = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : undefined
        const clamped = contextWindow !== undefined && measured > contextWindow
        input.emit({
          type: "usage",
          provider: "codex",
          model,
          input: Math.max(0, (last.inputTokens ?? 0) - (last.cachedInputTokens ?? 0)),
          output: last.outputTokens ?? 0,
          reasoning: last.reasoningOutputTokens ?? 0,
          cacheRead: last.cachedInputTokens ?? 0,
          cacheWrite: last.cacheWriteInputTokens ?? 0,
          context: clamped ? contextWindow! : measured,
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(clamped ? { contextApprox: true as const } : {}),
        })
        return
      }
      case "turn/completed": {
        const status = params.turn?.status
        void Promise.all(turn.pending ?? []).then(() => {
          if (status === "failed") turn.finish({ status: "error", code: "codex_turn_failed", message: String(params.turn?.error?.message ?? "Codex turn failed") })
          else turn.finish({ status: "ok" })
        })
        return
      }
    }
  }

  /** The image a finished `imageGeneration` item saved, as a stored blob; none when it failed, is missing, or is not a PNG/JPEG/WebP under 20 MiB. */
  async function generatedImage(item: any, sessionId: SessionId): Promise<BlobRef[]> {
    if (!options.storeImage || typeof item.savedPath !== "string") return []
    try {
      const bytes = new Uint8Array(await readFile(item.savedPath))
      const mime = imageMime(bytes)
      if (!mime || bytes.length > MAX_IMAGE_BYTES) return []
      return [await options.storeImage(bytes, mime, sessionId)]
    } catch { return [] }
  }

  async function onRequest(method: string, params: any): Promise<unknown> {
    const turn = turnFor(params)
    if (method === "mcpServer/elicitation/request") {
      // `approve` keeps Codex from asking about MendCode's own tools; should a version ask anyway, MendCode asks when it runs the call.
      const own = turn && host.names.has(params?.serverName) && params?._meta?.codex_approval_kind === "mcp_tool_call"
      return { action: own ? "accept" : "decline", content: null, _meta: null }
    }
    const isApproval = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
    if (!turn || !isApproval) return { decision: "decline" }
    const isEdit = method === "item/fileChange/requestApproval"
    const mode = turn.input.permissionMode()
    if (mode === "full" || (mode === "edits" && isEdit)) return { decision: "accept" }
    // Codex has no plan tool here; in plan mode it stays read-only by declining every change.
    if (mode === "plan") return { decision: "decline" }
    const title = isEdit ? "Edit files" : "Run command"
    const detail = String(params.command ?? params.reason ?? "").slice(0, MAX_TEXT)
    turn.waitingUser = true
    turn.watchdog?.cancel()
    const answer: EngineResolution = await turn.input.ask({ kind: "approval", title, detail })
    turn.waitingUser = false
    turn.touch()
    if (answer.kind === "approve") return { decision: answer.scope === "session" ? "acceptForSession" : "accept" }
    return { decision: answer.kind === "abandoned" ? "cancel" : "decline" }
  }

  function ensureStarted() {
    if (ready && rpc && !rpc.closed) return ready
    // Live web search: the sandbox gives the child no network, so without it a Codex agent (a sub-agent too) cannot look anything up.
    const args = ["app-server", "-c", `model=${JSON.stringify(model)}`, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-c", `web_search="live"`, ...(options.fast ? ["-c", `service_tier="fast"`] : []), ...credentialArgs(options.environment, Object.keys(host.env)), ...codexRunLimits(options.runLimits, options.cwd), ...host.args, ...(options.processArgs ?? [])]
    const values = { ...options.environment?.values, ...host.env }
    const env = Object.keys(values).length ? { env: values } : {}
    transport = options.transportFactory?.({ args, cwd: options.cwd, ...env }) ?? spawnCodex({ bin: options.bin ?? "codex", args, cwd: options.cwd, ...env })
    rpc = createRpc(transport, { notification: onNotification, request: onRequest }, options.trace)
    const client = rpc
    // One observer per process, not one per turn: a turn's own would keep it in memory until the shared process exits.
    const started = transport
    void started.exited.then(() => {
      for (const turn of [...turnsByThread.values()]) if (turn.transport === started) turn.finish({ status: "error", code: "codex_exited", message: "[CODEX]: app-server exited during the turn" })
    })
    ready = (async () => {
      await client.request("initialize", { clientInfo: { name: "mendcode", title: "MendCode", version: "0.0.0" }, capabilities: null })
      client.notify("initialized")
      const limits = await client.request("account/rateLimits/read").catch(() => undefined)
      const quota = codexQuota(limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits, now())
      if (quota) options.onQuota?.(quota)
    })()
    threads.clear()
    return ready
  }

  async function threadFor(sessionId: SessionId, plan: boolean) {
    const existing = threads.get(sessionId)
    if (existing) return existing
    // `developerInstructions` is a developer message on top of Codex's base instructions; `baseInstructions` would replace them. A
    // thread's own developer instructions take the place of the process's (`developer_instructions`), so the language pin rides along.
    const own = [options.appendSystem?.(options.cwd), host.names.size ? options.hostInstructions : undefined, options.processInstructions, options.environment?.note].filter(Boolean)
    const developerInstructions = own.length ? [...own, codexLanguageInstruction(options.runLimits)].filter(Boolean).join("\n\n") : ""
    const settings = { model, cwd: options.cwd, approvalPolicy: "on-request", sandbox: plan ? "read-only" : "workspace-write", ...(developerInstructions ? { developerInstructions } : {}) }
    const bound = options.bindings?.get(sessionId)
    if (bound) {
      // Resume the same Codex conversation after a daemon restart; fall back to a new thread if it is gone.
      const resumed = await rpc!.request("thread/resume", { threadId: bound, excludeTurns: true, ...settings }).catch(() => undefined)
      if (resumed?.thread?.id) {
        threads.set(sessionId, String(resumed.thread.id))
        return String(resumed.thread.id)
      }
    }
    const started = await rpc!.request("thread/start", settings)
    const threadId = String(started.thread.id)
    threads.set(sessionId, threadId)
    options.bindings?.set(sessionId, threadId)
    return threadId
  }

  return {
    async runTurn(input) {
      if (input.externalMcp) {
        const mcp = input.externalMcp
        const { trace: _trace, ...processOptions } = options
        const child = createCodexEngine({ ...processOptions, cwd: mcp.cwd, processArgs: mcp.args, processInstructions: mcp.instructions, waitingForMcp: () => Boolean(mcp.waiting?.() || options.waitingForMcp?.()) })
        isolated.add(child)
        const turn = processMcpTurn(input)
        try { return await child.runTurn(turn) }
        finally { turn.flushProcessMcp(); child.stop(); isolated.delete(child) }
      }
      await ensureStarted()
      const threadId = await threadFor(input.sessionId, input.permissionMode() === "plan")
      // A cancel while Codex started or the thread opened: its abort event is gone, so nothing may be sent now.
      if (input.signal.aborted) return { status: "ok" }
      const planNote = planNotes.next(input.sessionId, input.permissionMode() === "plan")
      return new Promise<TurnOutcome>((resolve) => {
        let settled = false
        const turn: ActiveTurn = {
          input,
          items: new Map(),
          waitingUser: false,
          ...(transport ? { transport } : {}),
          touch() {
            turn.watchdog?.cancel()
            if (settled || turn.waitingUser || idleMs === undefined) return
            turn.watchdog = clock.setTimer(idleMs, () => {
              if (options.waitingForMcp?.()) { turn.touch(); return }
              if (turn.codexTurnId) void rpc?.request("turn/interrupt", { threadId, turnId: turn.codexTurnId }).catch(() => {})
              turn.finish({ status: "error", code: "stream_idle", message: `[CODEX]: no activity for ${Math.round(idleMs / 1000)} s; turn interrupted` })
            })
          },
          finish(outcome) {
            if (settled) return
            settled = true
            turn.watchdog?.cancel()
            turnsByThread.delete(threadId)
            if (turn.codexTurnId) turnsByCodexTurn.delete(turn.codexTurnId)
            resolve(outcome)
          },
        }
        turnsByThread.set(threadId, turn)
        turn.touch()
        input.signal.addEventListener(
          "abort",
          () => {
            if (turn.codexTurnId) void rpc?.request("turn/interrupt", { threadId, turnId: turn.codexTurnId }).catch(() => turn.finish({ status: "ok" }))
            else turn.finish({ status: "ok" })
          },
          { once: true },
        )
        rpc!
          .request("turn/start", {
            threadId, input: [{ type: "text", text: planNote ? `${input.text}\n${planNote}` : input.text, text_elements: [] }], model, effort,
            // A resumed thread may have had a different ceiling on its previous turn.
            sandboxPolicy: input.permissionMode() === "plan" ? { type: "readOnly" } : { type: "workspaceWrite", writableRoots: [options.cwd], networkAccess: false },
          })
          .then((response) => {
            const id = response?.turn?.id
            if (id && !turn.codexTurnId) {
              turn.codexTurnId = id
              turnsByCodexTurn.set(id, turn)
              if (input.signal.aborted) void rpc?.request("turn/interrupt", { threadId, turnId: id }).catch(() => turn.finish({ status: "ok" }))
            }
          })
          .catch((error: Error) => turn.finish({ status: "error", code: "codex_request", message: error.message }))
      })
    },
    needsCompaction: () => false,
    compact: async () => ({ status: "ok" }),
    stop() {
      for (const child of isolated) child.stop()
      isolated.clear()
      transport?.close()
      rpc = undefined
      ready = undefined
    },
  }
}
