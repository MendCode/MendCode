import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { MAX_FRAME_BYTES, startedQueueIds, visibleEvents,type ChangesReport, type Command, type ItemId, type RestMessage, type RestReadInput, type RestSession, type SessionDetail, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { SessionActor } from "@mendcode/kernel"
import type { ModelMessage } from "@mendcode/engine-native"
import { sanitizeSession } from "./session-automation"
import { usageProject } from "./usage"
import type { Outcome } from "./session-history"
import { restUsage } from "./session-rest-usage"
import { restFileDiffs, restMessageSummary, restRevert, restSessionSummary } from "./session-rest-diff"
import type { SessionPermissionRules } from "./session-permission-rules"
import { DEV_VERSION } from "@mendcode/program"

const CONTEXT_TEXT_LIMIT = 40_000
type Control = Extract<Command, { type: "session.rest.control" }>
type Update = Extract<Command, { type: "session.rest.update" }>
const failure = (code: "invalid_command" | "unknown_session" | "target_mismatch" | "busy", message: string): Outcome<Record<string, unknown>> => ({ ok: false, code, message })
type Cursor = { scope: string; operation: string; anchor: string; order: "asc" | "desc"; previous?: boolean; filters: Pick<RestReadInput, "roots" | "start" | "search" | "archived" | "global" | "scope" | "path"> }
const encode = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString("base64url")
const exact = (directory: string) => { try { return realpathSync(directory) } catch { return path.resolve(directory) } }
/** Project-relative location of a session directory, forward-slashed; "" at the project root. */
function projectPlace(directory: string) {
  const project = usageProject(directory)
  const relative = path.relative(project.directory, exact(directory)).split(path.sep).join("/")
  return { id: project.id, root: project.directory, path: relative === ".." || relative.startsWith("../") ? "" : relative }
}
const normalizePath = (value: string) => value.replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".").join("/")
const idle = (state: string) => state === "idle" || state === "error"
const nameOfError = (error: { message: string; code?: string }) => ({ name: error.code === "structured_output" ? "StructuredOutputError" : "UnknownError", data: { message: error.message } })

export function createRestSessions(input: {
  dir: string; store: Store; now(): number
  detail(id: SessionId): SessionDetail | undefined
  model(id: SessionId): RestSession["model"]
  actor(id: SessionId): SessionActor | undefined
  mask(id: SessionId, text: string): string
  /** The session's net change report, or one user message's (`itemId`); undefined when unavailable. */
  changes(id: SessionId, itemId?: string): ChangesReport | undefined
  /** Per-session permission rules the engine evaluates; absent when the embedding keeps none. */
  permissions?: SessionPermissionRules
}) {
  const { store } = input
  const file = path.join(input.dir, "session-rest.json")
  let archives: Record<string, number> = {}
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) throw new Error("invalid session-rest.json")
    archives = value
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const observers = new Set<() => void>()
  const cancellations = new Set<() => void>()
  function events(id: SessionId) {
    const result: SessionEvent[] = []
    for (let cursor = 0;;) {
      const page = store.readAfter(id, cursor, 1_000)
      result.push(...page)
      if (page.length < 1_000) break
      cursor = page.at(-1)!.seq
    }
    return visibleEvents(result)
  }
  function safe<T>(id: SessionId, value: T): T {
    const mask = (entry: unknown): unknown => typeof entry === "string" ? input.mask(id, entry) : Array.isArray(entry) ? entry.map(mask) : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, mask(value)])) : entry
    return mask(sanitizeSession(value)) as T
  }
  /** `detailed` adds the session's persisted change summary (reads every turn's summary, so single-session reads only). */
  function session(id: SessionId, detailed = false): RestSession | undefined {
    const value = input.detail(id)
    if (!value) return undefined
    const project = projectPlace(value.directory)
    const model = input.model(id)
    const revert = restRevert({ store, sessionId: id })
    const summary = detailed ? restSessionSummary({ store, sessionId: id }) : undefined
    const permission = input.permissions?.own(id)
    return safe(id, {
      ...(permission ? { permission: [...permission] } : {}),
      id, slug: id.slice(4).toLowerCase(), projectID: `project_${createHash("sha256").update(project.id).digest("hex").slice(0, 24)}`,
      directory: value.directory, ...(project.path ? { path: project.path } : {}), title: value.title, version: DEV_VERSION, agent: value.agent ?? "build",
      ...(value.parentId ? { parentID: value.parentId } : {}),
      ...(model ? { model } : {}),
      ...(summary ? { summary } : {}),
      ...(revert ? { revert } : {}),
      time: { created: value.createdAt, updated: value.updatedAt, ...(archives[id] !== undefined ? { archived: archives[id] } : {}) },
    })
  }
  function messages(id: SessionId): RestMessage[] {
    const projected: RestMessage[] = []
    const byItem = new Map<string, { message: RestMessage; part: RestMessage["parts"][number] }>()
    const turnMessages = new Map<string, RestMessage[]>()
    const usage = new Map<string, Extract<SessionEvent, { type: "usage.recorded" }>>()
    let current: RestMessage | undefined
    let user: RestMessage | undefined
    const detail = input.detail(id)!
    const model = input.model(id)
    const root = usageProject(detail.directory).directory
    const agent = detail.agent ?? "build"
    const assistantInfo = (itemId: ItemId, at: number, parentID?: ItemId): RestMessage["info"] => ({
      id: itemId, sessionID: id, role: "assistant", time: { created: at }, ...(parentID ? { parentID } : {}), agent, mode: agent, path: { cwd: detail.directory, root },
      ...(model ? { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } : {}),
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    // One model call is one step, as in v1: `step-start` opens it and `step-finish` closes it after the step's tool calls with that
    // call's tokens and cost. A turn without a model call (a `!command`, a compaction) has none.
    type Usage = Extract<SessionEvent, { type: "usage.recorded" }>
    let step: { message: RestMessage; tools: boolean; usage?: Usage } | undefined
    let stepCount = 0
    const modelTurns = new Set<string>()
    const usageTurns = new Set<string>()
    const compactionTurns = new Set<string>()
    const lateUsage = new Map<string, Usage>()
    const stepPart = (message: RestMessage, kind: "start" | "finish", extra: Record<string, unknown> = {}): RestMessage["parts"][number] =>
      ({ id: `${message.info.id}:step-${kind}-${++stepCount}`, sessionID: id, messageID: message.info.id, type: `step-${kind}`, ...extra })
    const beginStep = (message: RestMessage, turnId: string) => {
      message.parts.push(stepPart(message, "start"))
      const late = lateUsage.get(turnId)
      lateUsage.delete(turnId)
      step = { message, tools: false, ...(late ? { usage: late } : {}) }
    }
    const closeStep = (reason?: string) => {
      if (!step) return
      const used = step.usage
      step.message.parts.push(stepPart(step.message, "finish", {
        reason: reason ?? (step.tools ? "tool-calls" : "stop"), cost: used?.costMicros !== undefined ? used.costMicros / 1_000_000 : 0,
        tokens: { input: used?.input ?? 0, output: used?.output ?? 0, reasoning: used?.reasoning ?? 0, cache: { read: used?.cacheRead ?? 0, write: used?.cacheWrite ?? 0 } },
      }))
      step = undefined
    }
    for (const event of events(id)) {
      if (event.type === "turn.started") { current = undefined; user = undefined; step = undefined; turnMessages.set(event.turnId, []) }
      if (event.type === "item.started") {
        if (event.kind === "compaction") compactionTurns.add(event.turnId)
        if (event.kind === "user_message") {
          closeStep()
          current = { info: { id: event.itemId, sessionID: id, role: "user", time: { created: event.at }, agent: detail.agent ?? "build", ...(model ? { model } : {}) }, parts: [] }
          projected.push(current)
          turnMessages.get(event.turnId)?.push(current)
          user = current
        } else if (!current || current.info.role === "user") {
          current = { info: assistantInfo(event.itemId, event.at, user?.info.id), parts: [] }
          projected.push(current)
          turnMessages.get(event.turnId)?.push(current)
        }
        if ((event.kind === "reasoning" || event.kind === "agent_message" || event.kind === "tool_call") && !compactionTurns.has(event.turnId)) {
          if (event.kind !== "tool_call") modelTurns.add(event.turnId)
          // A model answer after a finished call is the next step; tool calls belong to the step that asked for them.
          // Without usage reports (a provider that sends none) the round ends where tool calls give way to a new answer.
          if (step && event.kind !== "tool_call" && (step.usage || step.tools && !usageTurns.has(event.turnId))) closeStep()
          if (!step && modelTurns.has(event.turnId)) beginStep(current, event.turnId)
          if (step && event.kind === "tool_call") step.tools = true
        }
        const type = event.kind === "reasoning" ? "reasoning" : event.kind === "tool_call" ? "tool" : event.kind === "compaction" ? "compaction" : "text"
        const part: RestMessage["parts"][number] = { id: event.itemId, sessionID: id, messageID: current.info.id, type, ...(type === "compaction" ? { auto: event.meta?.auto === true } : { text: "" }), ...(type === "text" || type === "reasoning" ? { time: { start: event.at } } : {}), ...(type === "tool" ? { tool: event.meta?.tool ?? "tool", callID: event.itemId, state: { status: "running", input: {}, time: { start: event.at } } } : {}) }
        current.parts.push(part)
        byItem.set(event.itemId, { message: current, part })
      } else if (event.type === "item.delta" || event.type === "item.completed") {
        const item = byItem.get(event.itemId)
        if (!item) continue
        const text = event.type === "item.delta" ? String(item.part.text ?? "") + event.text : event.text ?? String(item.part.text ?? "")
        const limit = item.part.type === "tool" ? 6_000 : 40_000
        item.part.text = text.slice(0, limit)
        if (text.length > limit) item.part.truncated = true
        if (event.type === "item.completed") {
          if (item.part.type === "tool") {
            let args: unknown = {}
            try { args = event.toolInput ? JSON.parse(event.toolInput) : {} } catch {}
            const toolInput = args && typeof args === "object" && !Array.isArray(args) ? args : { value: args }
            const previous = item.part.state as { time?: { start?: number } }
            const time = { start: previous?.time?.start ?? event.at, end: event.at }
            item.part.state = event.status === "ok"
              ? { status: "completed", input: toolInput, output: item.part.text, title: String(item.part.tool), metadata: {}, time }
              : { status: "error", input: toolInput, error: String(item.part.text || event.status), metadata: {}, time }
            // The accepted `StructuredOutput` arguments are the message's structured answer (v1 `info.structured`).
            if (event.status === "ok" && event.meta?.structured === true && event.text !== undefined) {
              try { item.message.info.structured = JSON.parse(event.text) } catch { /* over the inline limit: only the tool part shows it */ }
            }
          } else if (item.part.time) item.part.time = { ...(item.part.time as { start: number }), end: event.at }
          if (event.attachments) for (const blob of event.attachments) item.message.parts.push({ id: `${event.itemId}:${blob.sha256.slice(0, 12)}`, sessionID: id, messageID: item.message.info.id, type: "file", mime: blob.mime, filename: blob.name, url: `mendcode:blob:${blob.sha256}`, blob })
        }
      } else if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.type) && "turnId" in event && event.turnId) {
        closeStep(event.type === "turn.completed" ? undefined : event.type.slice(5))
        lateUsage.delete(event.turnId)
        for (const message of turnMessages.get(event.turnId) ?? []) if (message.info.role === "assistant") {
          message.info.time.completed = event.at
          message.info.finish = event.type === "turn.completed" ? "stop" : event.type.slice(5)
          if (event.type === "turn.failed") message.info.error = nameOfError(event.error)
        }
      } else if (event.type === "usage.recorded") {
        if (!compactionTurns.has(event.turnId)) {
          modelTurns.add(event.turnId)
          usageTurns.add(event.turnId)
          // A second model call while the first step is still open: the first asked for tools.
          if (step?.usage) closeStep()
          if (!step && current?.info.role === "assistant") beginStep(current, event.turnId)
          if (step) step.usage = event
          else lateUsage.set(event.turnId, event)
        }
        const prior = usage.get(event.turnId)
        usage.set(event.turnId, { ...event, input: event.input + (prior?.input ?? 0), output: event.output + (prior?.output ?? 0), reasoning: event.reasoning + (prior?.reasoning ?? 0), cacheRead: event.cacheRead + (prior?.cacheRead ?? 0), cacheWrite: event.cacheWrite + (prior?.cacheWrite ?? 0), ...(prior?.costMicros !== undefined || event.costMicros !== undefined ? { costMicros: (prior?.costMicros ?? 0) + (event.costMicros ?? 0) } : {}) })
      }
    }
    for (const [turn, value] of usage) {
      const assistant = turnMessages.get(turn)?.findLast((message) => message.info.role === "assistant")
      if (!assistant) continue
      assistant.info.modelID = value.model
      assistant.info.providerID = value.provider
      if (value.costMicros !== undefined) assistant.info.cost = value.costMicros / 1_000_000
      assistant.info.tokens = { input: value.input, output: value.output, reasoning: value.reasoning, cache: { read: value.cacheRead, write: value.cacheWrite } }
    }
    for (const message of projected) {
      // The persisted per-message summary survives byte retention (turn snapshots), like v1's `info.summary.diffs`.
      const summary = message.info.role === "user" ? restMessageSummary({ store, sessionId: id, itemId: message.info.id }) : undefined
      if (summary) message.info.summary = summary
      while (message.parts.length > 1 && Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME_BYTES - 32_000) { message.parts.pop(); message.partsMore = true }
      if (message.partsMore && message.parts.at(-1)) message.partsCursor = message.parts.at(-1)!.id
    }
    return safe(id, projected)
  }
  /** tui/history views drop reasoning and cap tool output; the other views return the message untouched. */
  function preview(message: RestMessage, view: RestReadInput["view"]): RestMessage {
    if (view !== "tui" && view !== "history") return message
    const cap = (part: RestMessage["parts"][number]) => {
      if (part.type !== "tool") return part
      const state = part.state as { output?: string }
      return { ...part, text: String(part.text ?? "").slice(0, 2_000), ...(typeof state.output === "string" ? { state: { ...state, output: state.output.slice(0, 2_000) } } : {}) }
    }
    return { ...message, parts: message.parts.filter((part) => part.type !== "reasoning" && part.type !== "step-start" && part.type !== "step-finish").map(cap) }
  }
  function v2(message: RestMessage) {
    const common = { id: message.info.id, time: message.info.time }
    if (message.info.role === "user") return { ...common, type: "user", text: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"), files: message.parts.filter((part) => part.type === "file").map((part) => ({ uri: part.url, mime: part.mime, name: part.filename })), agents: [] }
    const summary = message.parts.find((part) => part.type === "compaction")
    if (summary) return { ...common, type: "compaction", reason: summary.auto === true ? "auto" : "manual", summary: String(summary.text ?? "") }
    const content = message.parts.filter((part) => part.type !== "step-start" && part.type !== "step-finish").map((part) => {
      if (part.type === "reasoning") return { type: "reasoning", id: part.id, text: part.text }
      if (part.type !== "tool") return { type: part.type, text: part.text }
      const state = part.state as { status: string; input: Record<string, unknown>; output?: string; error?: string; time: { start: number; end?: number } }
      const body = state.status === "completed" ? { status: "completed", input: state.input, content: [{ type: "text", text: state.output ?? "" }], structured: {} }
        : state.status === "error" ? { status: "error", input: state.input, content: [], structured: {}, error: { type: "unknown", message: state.error ?? "" } }
        : { status: "running", input: state.input, content: [], structured: {} }
      return { type: "tool", id: part.id, name: part.tool, state: body, time: { created: state.time.start, ran: state.time.start, ...(state.time.end !== undefined ? { completed: state.time.end } : {}) } }
    })
    const { providerID, modelID, variant } = message.info as { providerID?: string; modelID?: string; variant?: string }
    return { ...common, type: "assistant", agent: message.info.agent, ...(providerID && modelID ? { model: { id: modelID, providerID, modelID, variant: variant ?? "default" } } : {}), content, finish: message.info.finish, cost: message.info.cost, tokens: message.info.tokens, ...(message.info.error ? { error: { type: "unknown", message: (message.info.error as { data: { message: string } }).data.message } } : {}) }
  }
  /**
   * What the native engine will send next: its saved history (after any compaction and message revision), not a replay of the
   * transcript. Entries are numbered by their position in that history; tool results are folded into their call.
   * Undefined for sessions on an external engine or without a saved native history (the transcript projection answers then).
   */
  function engineContext(id: SessionId): { items: unknown[]; truncated?: boolean } | undefined {
    if (store.engineBindings.list(id).length) return undefined
    const raw = store.engineMessages.load(id, "native") as ModelMessage[]
    if (!raw.length) return undefined
    const time = { created: input.detail(id)?.updatedAt ?? input.now() }
    const results = new Map<string, Extract<ModelMessage, { role: "tool" }>>()
    for (const message of raw) if (message.role === "tool") results.set(message.callId, message)
    const clip = (text: string) => text.length > CONTEXT_TEXT_LIMIT ? text.slice(0, CONTEXT_TEXT_LIMIT) : text
    const entries: unknown[] = []
    raw.forEach((message, index) => {
      const entry = { id: `ctx_${String(index).padStart(6, "0")}`, time }
      if (message.role === "user") {
        if (message.compaction) entries.push({ ...entry, type: "compaction", summary: clip(message.content) })
        else entries.push({ ...entry, type: "user", text: clip(message.content), files: (message.attachments ?? []).map((blob) => ({ uri: `mendcode:blob:${blob.sha256}`, mime: blob.mime, name: blob.name })) })
      } else if (message.role === "assistant") {
        const content: unknown[] = message.content ? [{ type: "text", text: clip(message.content) }] : []
        for (const call of message.toolCalls) {
          const result = results.get(call.callId)
          content.push({ type: "tool", id: call.callId, name: call.name, state: result ? { status: result.isError ? "error" : "completed", input: call.args, output: clip(result.output) } : { status: "pending", input: call.args } })
        }
        entries.push({ ...entry, type: "assistant", content })
      }
    })
    const kept: unknown[] = []
    let bytes = 0
    for (const entry of entries.reverse()) {
      bytes += Buffer.byteLength(JSON.stringify(entry))
      if (bytes > MAX_FRAME_BYTES - 48_000) return { items: safe(id, kept.reverse()), truncated: true }
      kept.push(entry)
    }
    return { items: safe(id, kept.reverse()) }
  }
  function page(items: Array<{ id: string; value: unknown }>, query: RestReadInput, scope: string) {
    let order = query.order ?? (query.v2 ? "desc" : "asc")
    let anchor: string | undefined
    let previous = false
    let filters: Cursor["filters"] = { ...(query.roots !== undefined ? { roots: query.roots } : {}), ...(query.start !== undefined ? { start: query.start } : {}), ...(query.search !== undefined ? { search: query.search } : {}), ...(query.archived !== undefined ? { archived: query.archived } : {}), ...(query.global !== undefined ? { global: query.global } : {}), ...(query.scope !== undefined ? { scope: query.scope } : {}), ...(query.path !== undefined ? { path: query.path } : {}) }
    const token = query.cursor ?? query.before ?? query.after
    if (token) {
      const cursor = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Cursor
      if (cursor.scope !== scope || cursor.operation !== query.operation || !["asc", "desc"].includes(cursor.order) || typeof cursor.anchor !== "string" || !cursor.filters || typeof cursor.filters !== "object") throw new Error("invalid cursor")
      order = cursor.order
      anchor = cursor.anchor
      previous = query.cursor ? cursor.previous === true : !!query.before
      filters = cursor.filters
    }
    const sorted = order === "asc" ? items : [...items].reverse()
    const at = anchor ? sorted.findIndex((item) => item.id === anchor) : -1
    if (anchor && at < 0) throw new Error("cursor target missing")
    const limit = query.operation === "list" ? query.limit ?? (query.v2 ? 50 : 100) : query.limit || (query.v2 ? 50 : items.length || 1)
    const begin = anchor ? previous ? Math.max(0, at - limit) : at + 1 : query.v2 || query.operation === "list" ? 0 : Math.max(0, sorted.length - limit)
    const end = anchor && previous ? at : Math.min(sorted.length, begin + limit)
    let selected = sorted.slice(begin, end)
    let truncated = false
    while (selected.length && Buffer.byteLength(JSON.stringify(selected)) > MAX_FRAME_BYTES - 16_000) { selected.pop(); truncated = true }
    const cursor = (item: { id: string }, prev = false) => encode({ scope, operation: query.operation, anchor: item.id, order, ...(prev ? { previous: true } : {}), filters })
    return { items: selected.map((item) => item.value), cursor: { ...(begin > 0 && selected[0] ? { previous: cursor(selected[0], true) } : {}), ...(begin + selected.length < sorted.length && selected.at(-1) ? { next: cursor(selected.at(-1)!) } : {}) }, ...(truncated ? { truncated: true } : {}) }
  }
  /** Donor Agent View row: background record, derived state, writer lease and metadata overrides, plus the native session and idle/busy status. */
  function agentEntry(row: SessionDetail) {
    const id = row.sessionId
    const background = store.sessionBackground.get(id)
    const stored = background?.state
    const pending = store.pendingRequestsOf(id).length
    const state = stored === "failed" || stored === "stopped" ? stored : pending > 0 ? "needs_input" : !idle(row.state) ? "working" : stored === "working" ? "completed" : stored ?? "completed"
    const meta = store.agentCommands.getMetadata(id)
    const writer = background?.writer && background.writer.expiresAt > input.now() ? { clientID: background.writer.clientId, acquired: background.writer.acquiredAt, expires: background.writer.expiresAt } : undefined
    const rest = session(id)
    return safe(id, {
      sessionID: id, state, summary: background ? background.summary : rest?.path || row.directory,
      ...(background?.error !== undefined ? { error: background.error } : {}),
      pinned: background?.pinned ?? false,
      ...(background?.process ? { process: { pid: background.process.pid, started: background.process.startedAt } } : {}),
      ...(writer ? { writer } : {}),
      time: background ? { created: background.createdAt, updated: background.updatedAt } : { created: row.createdAt, updated: row.updatedAt },
      ...(rest ? { session: rest } : {}),
      ...(meta ? { metadata: { sessionID: id, ...(meta.title !== undefined ? { title: meta.title } : {}), tags: meta.tags, ...(meta.group !== undefined ? { group: meta.group } : {}), ...(meta.priority !== undefined ? { priority: meta.priority } : {}), ...(meta.notes !== undefined ? { notes: meta.notes } : {}), pinned: meta.pinned ?? false, archived: meta.archived ?? false, time: { created: meta.createdAt ?? row.createdAt, updated: meta.updatedAt ?? row.updatedAt } } } : {}),
      status: { type: idle(row.state) ? "idle" : "busy" },
    })
  }
  function read(directory: string, query: RestReadInput): Outcome<Record<string, unknown>> {
    try {
      const id = query.sessionId
      if (query.operation === "usage") return { ok: true, result: { value: restUsage({ store, messages, now: input.now(), start: query.start ?? 0, limit: query.limit || 1_000, messageLimit: query.messageLimit ?? 500 }) } }
      if (id && !store.hasSession(id)) return failure("unknown_session", "unknown session")
      if (id && store.sessionDirectory(id) !== directory) return failure("target_mismatch", "session outside selected workspace")
      if (["list", "status", "agent-view"].includes(query.operation)) {
        let filters = query
        if (query.cursor) {
          const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as Cursor
          filters = { ...query, ...cursor.filters }
        }
        // `scope=project` lists the selected workspace's whole project; `path` narrows it to a project-relative directory subtree ("" keeps the project).
        const projectWide = filters.scope === "project" || filters.path !== undefined
        const current = projectWide ? projectPlace(directory) : undefined
        const subtree = filters.path === undefined ? "" : normalizePath(filters.path)
        const places = new Map<string, ReturnType<typeof projectPlace>>()
        const inScope = (row: SessionDetail) => {
          if (!current) return true
          const place = places.get(row.directory) ?? projectPlace(row.directory)
          places.set(row.directory, place)
          return place.id === current.id && (!subtree || place.path === subtree || place.path.startsWith(`${subtree}/`))
        }
        const values: SessionDetail[] = []
        for (let offset = 0;; offset += 500) {
          const rows = store.listSessions({ ...(filters.global || projectWide ? {} : { directory }), roots: filters.roots ?? false, since: filters.start, search: filters.search, limit: 500, offset })
          values.push(...rows.map((row) => input.detail(row.sessionId)!).filter((row) => inScope(row) && (filters.updatedBefore === undefined || row.updatedAt < filters.updatedBefore) && (query.operation === "status" || filters.archived === true || archives[row.sessionId] === undefined)))
          if (rows.length < 500) break
        }
        if (query.operation === "status") return { ok: true, result: { value: Object.fromEntries(values.map((row) => [row.sessionId, { type: idle(row.state) ? "idle" : "busy", ...(row.since ? { startedAt: row.since } : {}) }])) } }
        if (query.operation === "agent-view") return { ok: true, result: { value: values.slice(0, query.limit ?? 100).map(agentEntry) } }
        const items = [...values].reverse().map((row) => ({ id: row.sessionId, value: { ...session(row.sessionId), ...(filters.global ? { project: { id: session(row.sessionId)!.projectID, worktree: usageProject(row.directory).directory } } : {}) } }))
        return { ok: true, result: page(items, { ...query, order: query.order ?? "desc" }, directory) }
      }
      if (query.operation === "get") return { ok: true, result: { value: session(id!, true) } }
      if (query.operation === "children") return { ok: true, result: { value: store.sessionChildren(id!).map((child) => session(child)) } }
      if (query.operation === "context") {
        const exact = engineContext(id!)
        if (exact) return { ok: true, result: { value: exact.items, source: "engine", ...(exact.truncated ? { truncated: true } : {}) } }
      }
      let all = messages(id!)
      if (query.queueId) {
        const started = events(id!).find((event) => event.type === "turn.started" && startedQueueIds(event).includes(query.queueId!))
        all = started && "turnId" in started ? all.filter((message) => store.itemStart(id!, message.info.id)?.turnId === started.turnId) : []
      }
      if (query.operation === "todo") {
        const last = all.flatMap((message) => message.parts).findLast((part) => part.type === "tool" && ["todo", "todowrite"].includes(String(part.tool)))
        const state = last?.state as { input?: { items?: Array<{ text: string; status: string; priority?: string }> } } | undefined
        return { ok: true, result: { value: (state?.input?.items ?? []).map((item) => ({ content: item.text, status: item.status === "done" ? "completed" : item.status, priority: item.priority ?? "medium" })) } }
      }
      if (query.operation === "diff") {
        // Net session diff (first before to last after of every file) or one message's persisted diff; a path whose bytes
        // were pruned falls back to the persisted per-turn patches (see history.changes).
        const report = input.changes(id!, query.messageId)
        return { ok: true, result: { value: safe(id!, report ? restFileDiffs(report) : []) } }
      }
      if (query.operation === "message") {
        const found = all.find((message) => message.info.id === query.messageId)
        if (!found) return failure("unknown_session", "unknown message")
        const message = preview(found, query.view)
        const parts = message.parts
        const start = query.partsAfter ? parts.findIndex((part) => part.id === query.partsAfter) + 1 : 0
        if (query.partsAfter && start === 0) return failure("invalid_command", "invalid parts cursor")
        message.parts = parts.slice(start, query.partsLimit ? start + query.partsLimit : undefined)
        if (start + message.parts.length < parts.length && message.parts.at(-1)) { message.partsMore = true; message.partsCursor = message.parts.at(-1)!.id }
        return { ok: true, result: { value: message } }
      }
      if (query.operation === "context") {
        const compacted = store.turns.list(id!).findLast((turn) => turn.compacted && !turn.reverted)
        return { ok: true, result: { value: all.filter((message) => !compacted || message.info.time.created >= compacted.at).map(v2) } }
      }
      let projected = all.map((message) => preview(message, query.view))
      if (query.partsLimit) projected = projected.map((message) => message.parts.length > query.partsLimit! ? { ...message, parts: message.parts.slice(0, query.partsLimit), partsMore: true, partsCursor: message.parts[query.partsLimit! - 1]!.id } : message)
      if (query.unit === "turn") {
        const groups = new Map<string, RestMessage[]>()
        for (const message of projected) {
          const turn = store.itemStart(id!, message.info.id)?.turnId ?? message.info.id
          const group = groups.get(turn) ?? []
          group.push(message)
          groups.set(turn, group)
        }
        const result = page([...groups].map(([id, value]) => ({ id, value: query.v2 ? value.map(v2) : value })), query, `${directory}:${id}`)
        return { ok: true, result: { ...result, items: result.items.flat() } }
      }
      return { ok: true, result: page(projected.map((message) => ({ id: message.info.id, value: query.v2 ? v2(message) : message })), query, `${directory}:${id}`) }
    } catch { return failure("invalid_command", "invalid REST cursor or projection") }
  }
  function update(command: Update): Outcome<Record<string, unknown>> {
    if (!store.hasSession(command.sessionId)) return failure("unknown_session", "unknown session")
    if (command.patch.title !== undefined && !command.patch.title.trim()) return failure("invalid_command", "empty title")
    const archived = command.patch.time?.archived
    if (archived !== undefined) {
      const next = { ...archives }
      if (archived === null) delete next[command.sessionId]
      else next[command.sessionId] = archived
      writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
      archives = next
    }
    if (command.patch.permission !== undefined) {
      if (!input.permissions) return failure("invalid_command", "session permission rules unavailable")
      try { input.permissions.set(command.sessionId, command.patch.permission) } catch { return failure("invalid_command", "invalid session permission rules") }
    }
    if (command.patch.title !== undefined) store.renameSession(command.sessionId, input.mask(command.sessionId, command.patch.title.trim()))
    return { ok: true, result: { value: session(command.sessionId) } }
  }
  async function control(command: Control, signal?: AbortSignal): Promise<Outcome<Record<string, unknown>>> {
    const actor = input.actor(command.sessionId)
    if (!actor) return failure("unknown_session", "unknown session")
    const snapshot = actor.snapshot()
    if (command.operation === "wait") return new Promise((resolve) => {
      let ended = false
      const finish = (result: Outcome<Record<string, unknown>>) => {
        if (ended) return
        ended = true
        observers.delete(check)
        cancellations.delete(abort)
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        resolve(result)
      }
      const check = () => {
        if (!store.hasSession(command.sessionId)) return finish(failure("unknown_session", "session removed"))
        if (command.queueId) {
          const started = events(command.sessionId).find((event) => event.type === "turn.started" && startedQueueIds(event).includes(command.queueId!))
          const turn = started && "turnId" in started && started.turnId ? store.turns.get(command.sessionId, started.turnId) : undefined
          if (turn && turn.status !== "running") return finish({ ok: true, result: { value: true, turnId: turn.turnId } })
        } else {
          const current = actor.snapshot()
          if (!current.turnId && current.queue.length === 0) return finish({ ok: true, result: { value: true } })
        }
      }
      const abort = () => finish(failure("busy", "wait cancelled"))
      const timer = setTimeout(() => finish(failure("busy", "wait deadline exceeded")), command.timeoutMs ?? 55_000)
      observers.add(check)
      cancellations.add(abort)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      else check()
    })
    if (command.operation === "interrupt") {
      const next = snapshot.queue[0]
      if (!next) return { ok: true, result: { value: false } }
      const result = await actor.handle({ ...command, type: "queue.promote", queueId: next })
      return result.ok ? { ok: true, result: { value: true } } : result
    }
    if (command.operation === "cancel-turn") {
      const target = store.turns.byItem(command.sessionId, command.targetMessageId!)
      const result = !snapshot.turnId ? target && target.status !== "running" ? "already_terminal" : "not_running" : !target || target.turnId !== snapshot.turnId ? "target_mismatch" : "cancelled"
      if (result !== "cancelled") return { ok: true, result: { value: result } }
    }
    if (!snapshot.turnId) return { ok: true, result: { value: true } }
    const result = await actor.handle({ ...command, type: "turn.cancel", turnId: snapshot.turnId })
    return result.ok ? { ok: true, result: { value: command.operation === "cancel-turn" ? "cancelled" : true } } : result
  }
  return { read, update, control, session, messages, observe() { queueMicrotask(() => { for (const check of observers) check() }) }, close() { for (const cancel of cancellations) cancel() } }
}
