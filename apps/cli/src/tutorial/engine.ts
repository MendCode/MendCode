import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionEvent } from "@mendcode/protocol"

/**
 * The tutorial engine: a small scripted stand-in for the daemon that the practice chat talks to. It replays fixed turns
 * (a read, an edit with a diff, a command that asks, a question, a long walk) and answers the few queries the chat makes,
 * all in memory. It starts no process, opens no socket, reads no file and calls no model: the sessions, drafts, prompt
 * history and project files it holds are its own and vanish with it. Only types are imported from the protocol, so it
 * stays out of the zod graph.
 */
export type TutorialStats = {
  turnsStarted: number
  turnsCompleted: number
  cancelled: number
  /** `approve:once`, `approve:session`, `deny` or `answer`, in the order given. */
  resolved: string[]
  queued: number
  created: number
  undone: number
  model: string
  effort: string
}

export type TutorialEngineOptions = {
  now(): number
  /** Pause between streamed pieces; tests pass an instant one. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  directory: string
  /** The settings the practice chat starts with (the user's tier and view, so it looks like their terminal). */
  settings?: Record<string, unknown>
}

type Stored = { sessionId: string; title: string; createdAt: number; events: Array<Record<string, unknown>>; seq: number; permission: string }

const FILE = "src/cart.ts"
const BEFORE = ["export function total(items: Item[]) {", "  return items.length", "}"]
const AFTER = ["export function total(items: Item[]) {", "  return items.reduce((sum, item) => sum + item.price, 0)", "}"]
const DIFF = ["@@ -1,3 +1,3 @@", " export function total(items: Item[]) {", "-  return items.length", "+  return items.reduce((sum, item) => sum + item.price, 0)", " }"].join("\n")
const FILES = ["src/cart.ts", "src/checkout.ts", "src/prices.ts", "test/cart.test.ts", "README.md", "package.json"]
const MODELS = [
  { id: "tutorial-fast", name: "Tutorial Fast", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "tutorial-deep", name: "Tutorial Deep", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
]

export type TurnKind = "chat" | "edit" | "command" | "question" | "long"
/** Which fixed turn a message starts: the lessons suggest a sentence for each, and anything else gets a plain answer. */
export function turnKindOf(text: string): TurnKind {
  if (/\b(walk|every file|whole repo|list all)\b/i.test(text)) return "long"
  if (/\b(run|tests?)\b/i.test(text)) return "command"
  if (/\b(question|ask me|which one)\b/i.test(text)) return "question"
  if (/\b(fix|total|edit|change)\b/i.test(text)) return "edit"
  return "chat"
}

export function createTutorialEngine(options: TutorialEngineOptions) {
  const { directory } = options
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  }))
  let sink: ((event: SessionEvent) => void) | undefined
  let counter = 0
  const id = (prefix: string) => `${prefix}_tut${(++counter).toString(36)}`
  const sessions = new Map<string, Stored>()
  const queue: Array<{ queueId: string; text: string }> = []
  const history: Array<{ id: number; kind: string; text: string }> = [{ id: 1, kind: "sent", text: "What does the cart module do?" }]
  const drafts = new Map<string, string>()
  const pending = new Map<string, (decision: Record<string, unknown>) => void>()
  const askKinds = new Map<string, "approval" | "question">()
  let changed: () => void = () => undefined
  const settings: Record<string, unknown> = { onboarded: true, ...options.settings }
  let choice: { model: string; effort?: string } = { model: MODELS[0]!.id, effort: "medium" }
  let current = ""
  let running: { sessionId: string; turnId: string; abort: AbortController; done: Promise<void> } | undefined
  let fileText = BEFORE.join("\n")
  let edited = false
  /** While above zero the engine is being driven by the tour itself (resetting between lessons): nothing it receives counts or is remembered as the user's. */
  let muted = 0
  let lastTurn: string | undefined
  let stopped = false
  const sent: Array<Record<string, unknown>> = []
  const stats: TutorialStats = { turnsStarted: 0, turnsCompleted: 0, cancelled: 0, resolved: [], queued: 0, created: 0, undone: 0, model: choice.model, effort: choice.effort ?? "" }

  const ok = (result?: unknown): CommandReply => ({ ok: true, ...(result === undefined ? {} : { result }) }) as CommandReply
  const fail = (message: string): CommandReply => ({ ok: false, error: { code: "tutorial", message } }) as unknown as CommandReply

  function open(title: string, extra: Partial<Stored> = {}): Stored {
    const stored: Stored = { sessionId: id("session"), title, createdAt: options.now(), events: [], seq: 0, permission: "ask", ...extra }
    sessions.set(stored.sessionId, stored)
    return stored
  }
  function emit(session: Stored, event: Record<string, unknown>) {
    const full = { sessionId: session.sessionId, seq: ++session.seq, at: options.now(), ...event }
    session.events.push(full)
    if (session.sessionId === current && !stopped) sink?.(full as unknown as SessionEvent)
    if (!stopped) changed()
  }
  /** A finished earlier session, so the sessions list has something to open. */
  function seed(title: string, user: string, answer: string, ago: number) {
    const stored = open(title)
    stored.createdAt = options.now() - ago
    const turnId = id("turn")
    const queueId = id("queue")
    emit(stored, { type: "session.created", directory, title })
    emit(stored, { type: "turn.started", turnId, queueId })
    const userItem = id("item")
    emit(stored, { type: "item.started", turnId, itemId: userItem, kind: "user_message" })
    emit(stored, { type: "item.completed", itemId: userItem, status: "ok", text: user })
    const agentItem = id("item")
    emit(stored, { type: "item.started", turnId, itemId: agentItem, kind: "agent_message" })
    emit(stored, { type: "item.completed", itemId: agentItem, status: "ok", text: answer })
    emit(stored, { type: "turn.completed", turnId })
  }
  const first = open("Practice")
  current = first.sessionId
  seed("Refactor checkout", "Split checkout into steps", "Done: three steps, one file each.", 3_600_000)
  seed("Fix flaky cart test", "Why does the cart test fail on CI?", "It reads the clock; I froze it in the test.", 86_400_000)
  /** The seeded sessions are older than the practice one in the list. */
  first.createdAt = options.now()

  function summary(session: Stored) {
    const last = session.events.at(-1)
    return { sessionId: session.sessionId, title: session.title, directory, createdAt: session.createdAt, updatedAt: typeof last?.at === "number" ? last.at : session.createdAt, lastSeq: session.seq, state: running?.sessionId === session.sessionId ? "generating" : "idle", queued: session.sessionId === current ? queue.length : 0, permission: session.permission, model: choice }
  }
  const modelsReport = () => ({ engine: "tutorial", selectable: true, models: MODELS, defaults: { model: MODELS[0]!.id, effort: "medium" }, roles: {}, session: choice, effective: choice })
  const changes = () => ({
    root: directory, branch: "main", omittedFiles: 0, complete: true,
    files: edited ? [{ path: FILE, status: "modified", additions: 1, deletions: 1, binary: false, diff: DIFF, truncated: false, touchedAt: options.now() }] : [],
  })

  async function pause(ms: number, signal: AbortSignal) { if (!signal.aborted) await sleep(ms, signal) }

  async function stream(session: Stored, turnId: string, text: string, signal: AbortSignal) {
    const itemId = id("item")
    emit(session, { type: "item.started", turnId, itemId, kind: "agent_message" })
    for (let i = 0; i < text.length && !signal.aborted; i += 6) {
      emit(session, { type: "item.delta", itemId, text: text.slice(i, i + 6) })
      await pause(12, signal)
    }
    emit(session, { type: "item.completed", itemId, status: "ok", text })
  }
  function tool(session: Stored, turnId: string, name: string, body: string, extra: Record<string, unknown> = {}) {
    const itemId = id("item")
    emit(session, { type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: name } })
    emit(session, { type: "item.delta", itemId, text: body })
    emit(session, { type: "item.completed", itemId, status: "ok", text: body, ...extra })
    return itemId
  }
  async function ask(session: Stored, turnId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const requestId = id("request")
    // The request is registered before the chat is told about it, so whoever looks right after the event sees it asking.
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      pending.set(requestId, resolve)
      askKinds.set(requestId, request.kind as "approval" | "question")
      signal.addEventListener("abort", () => resolve({ kind: "deny" }), { once: true })
    })
    emit(session, { type: "foreground.state", state: "waiting_approval", turnId })
    emit(session, { type: "server.request", requestId, turnId, ...request })
    const decision = await answer
    pending.delete(requestId)
    askKinds.delete(requestId)
    emit(session, { type: "server.request.resolved", requestId })
    emit(session, { type: "foreground.state", state: "generating", turnId })
    return decision
  }
  const approved = (decision: Record<string, unknown>) => decision.kind === "approve"

  async function script(session: Stored, turnId: string, text: string, signal: AbortSignal) {
    const kind = turnKindOf(text)
    if (kind === "long") {
      const itemId = id("item")
      emit(session, { type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "list: ." } })
      for (let i = 1; i <= 80 && !signal.aborted; i++) {
        emit(session, { type: "item.delta", itemId, text: `src/module-${i}.ts\n` })
        await pause(350, signal)
      }
      emit(session, { type: "item.completed", itemId, status: "ok" })
      if (!signal.aborted) await stream(session, turnId, "That is every file I could find.", signal)
      return
    }
    if (kind === "command") {
      emit(session, { type: "foreground.state", state: "generating", turnId })
      await stream(session, turnId, "I will run the tests.", signal)
      const decision = session.permission === "full" ? { kind: "approve" } : await ask(session, turnId, { kind: "approval", title: "Run command", detail: "bun test", tool: "shell", permission: "execute", permissionContext: { name: "shell", patterns: ["bun test"], always: ["bun test"] } }, signal)
      if (signal.aborted) return
      if (approved(decision)) {
        tool(session, turnId, "shell: bun test", "cart.test.ts\n  ✓ totals the prices\n  ✓ empty cart is zero\n\n 2 pass  0 fail")
        await stream(session, turnId, "Both tests pass.", signal)
      } else await stream(session, turnId, "Understood, I did not run it.", signal)
      return
    }
    if (kind === "question") {
      await stream(session, turnId, "I need one detail first.", signal)
      const answer = await ask(session, turnId, { kind: "question", title: "Which test runner?", detail: "", options: [{ label: "bun test", description: "the project's script" }, { label: "vitest" }] }, signal)
      if (!signal.aborted) await stream(session, turnId, `Using ${typeof answer.text === "string" && answer.text ? answer.text : "bun test"}.`, signal)
      return
    }
    tool(session, turnId, `read: ${FILE}`, fileText)
    await pause(60, signal)
    if (kind === "edit" && !signal.aborted) {
      const decision = session.permission === "ask" ? await ask(session, turnId, { kind: "approval", title: "Edit file", detail: `${FILE}\n${DIFF}`, tool: "edit", permission: "write", permissionContext: { name: "edit", patterns: [FILE], always: [FILE] } }, signal) : { kind: "approve" }
      if (signal.aborted) return
      if (approved(decision)) {
        fileText = AFTER.join("\n")
        edited = true
        tool(session, turnId, `edit: ${FILE}`, DIFF)
        await stream(session, turnId, "The total now adds the prices.", signal)
      } else await stream(session, turnId, "Left the file as it was.", signal)
      return
    }
    await stream(session, turnId, "This is practice: I read the file and answered. Nothing here is real.", signal)
  }

  function start(session: Stored, text: string, queueId: string) {
    const turnId = id("turn")
    lastTurn = turnId
    const abort = new AbortController()
    stats.turnsStarted += 1
    emit(session, { type: "foreground.state", state: "generating", turnId })
    emit(session, { type: "turn.started", turnId, queueId })
    const userItem = id("item")
    emit(session, { type: "item.started", turnId, itemId: userItem, kind: "user_message" })
    emit(session, { type: "item.completed", itemId: userItem, status: "ok", text })
    const done = (async () => {
      try { await script(session, turnId, text, abort.signal) } catch { /* a torn-down tutorial ends its turn silently */ }
      if (stopped) return
      if (abort.signal.aborted) { stats.cancelled += 1; emit(session, { type: "turn.cancelled", turnId, by: "user" }) }
      else { stats.turnsCompleted += 1; emit(session, { type: "turn.completed", turnId }) }
      running = undefined
      emit(session, { type: "foreground.state", state: "idle" })
      const next = queue.shift()
      emit(session, { type: "queue.changed", queue: queue.map((entry) => ({ queueId: entry.queueId, preview: entry.text, attachments: 0 })) })
      if (next) start(session, next.text, next.queueId)
    })()
    running = { sessionId: session.sessionId, turnId, abort, done }
  }

  function submit(command: Record<string, unknown>): CommandReply {
    const session = sessions.get(String(command.sessionId)) ?? sessions.get(current)!
    const text = String(command.text ?? "")
    const queueId = id("queue")
    history.unshift({ id: history.length + 1, kind: "sent", text })
    emit(session, { type: "queue.added", queueId, text, attachments: [] })
    if (running) {
      stats.queued += 1
      queue.push({ queueId, text })
      emit(session, { type: "queue.changed", queue: queue.map((entry) => ({ queueId: entry.queueId, preview: entry.text, attachments: 0 })) })
    } else start(session, text, queueId)
    return ok({ queueId })
  }

  async function send(command: CommandInput): Promise<CommandReply> {
    const c = command as unknown as Record<string, unknown>
    if (muted === 0) sent.push(c)
    queueMicrotask(() => { if (!stopped) changed() })
    switch (c.type) {
      case "user.submit": return submit(c)
      case "turn.cancel": running?.abort.abort(); return ok()
      case "queue.steer":
      case "queue.promote": {
        const index = queue.findIndex((entry) => entry.queueId === c.queueId)
        if (index >= 0 && running) { queue.splice(index, 1); running.abort.abort() }
        return ok()
      }
      case "queue.remove": { const index = queue.findIndex((entry) => entry.queueId === c.queueId); if (index >= 0) queue.splice(index, 1); return ok() }
      case "queue.list": return ok({ queue: queue.map((entry) => ({ queueId: entry.queueId, text: entry.text, attachments: [] })) })
      case "request.resolve": {
        const decision = c.decision as Record<string, unknown>
        stats.resolved.push(decision.kind === "approve" ? `approve:${decision.scope}` : String(decision.kind))
        if (decision.kind === "approve" && decision.scope === "session") sessions.get(current)!.permission = "edits"
        pending.get(String(c.requestId))?.(decision)
        return ok()
      }
      case "models.list": return ok(modelsReport())
      case "session.model.set": {
        const next = c.choice as { model: string; effort?: string } | null
        choice = next ?? { model: MODELS[0]!.id, effort: "medium" }
        stats.model = choice.model
        stats.effort = choice.effort ?? ""
        return ok(modelsReport())
      }
      case "session.permission.set": { const session = sessions.get(String(c.sessionId)); if (session) session.permission = String(c.mode); return ok() }
      case "session.list": return ok({ sessions: [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map(summary) })
      case "session.create": {
        const reused = [...sessions.values()].find((session) => c.reuseEmpty === true && session.events.length === 0)
        if (reused) return ok({ sessionId: reused.sessionId })
        const created = open("")
        stats.created += 1
        return ok({ sessionId: created.sessionId })
      }
      case "session.get": { const session = sessions.get(String(c.sessionId)); return session ? ok({ session: summary(session) }) : fail("no such practice session") }
      case "session.undo": {
        if (!edited || !lastTurn) return fail("nothing to undo in practice yet")
        edited = false
        fileText = BEFORE.join("\n")
        stats.undone += 1
        emit(sessions.get(current)!, { type: "turn.reverted", turnId: lastTurn })
        return ok({ turnIds: [lastTurn], files: { restored: [FILE], removed: [], skipped: [] }, history: { messages: 2, tracked: true }, shellUntracked: false, notes: [], canRedo: false, changes: [{ path: FILE, additions: 1, deletions: 1 }] })
      }
      case "changes.query": return ok(changes())
      case "files.search": {
        const query = String(c.query ?? "").toLowerCase()
        return ok({ files: FILES.filter((file) => file.toLowerCase().includes(query)).map((path) => ({ path, kind: "file" })) })
      }
      case "prompt.history": return ok({ entries: history })
      case "prompt.record": {
        if (muted > 0) return ok({ kept: false })
        history.unshift({ id: history.length + 1, kind: String(c.kind ?? "draft"), text: String(c.text ?? "") })
        return ok({ kept: true })
      }
      case "draft.set": { drafts.set(String(c.sessionId), String(c.text ?? "")); return ok() }
      case "draft.get": return ok({ draft: { text: drafts.get(String(c.sessionId)) ?? "", attachments: [] } })
      case "draft.list": return ok({ drafts: [] })
      case "settings.get": return ok({ settings })
      case "settings.set": {
        for (const [key, value] of Object.entries((c.patch ?? {}) as Record<string, unknown>)) { if (value === null) delete settings[key]; else settings[key] = value }
        return ok({ settings })
      }
      case "commands.list":
      case "commands.discover": return ok({ commands: [] })
      case "mcp.catalog": return ok({ resources: [] })
      case "mcp.status": return ok({ servers: [], issues: [] })
      case "git.branch": return ok({ branch: "main" })
      case "agents.list": return ok({ agents: [], default: "build" })
      default: return ok()
    }
  }

  async function subscribe(sessionId: string, afterSeq: number): Promise<CommandReply> {
    const session = sessions.get(sessionId)
    if (!session) return fail("no such practice session")
    current = sessionId
    queueMicrotask(() => { for (const event of session.events) if ((event.seq as number) > afterSeq && !stopped) sink?.(event as unknown as SessionEvent) })
    return ok()
  }

  return {
    /** The practice chat's own session, opened with the app. */
    sessionId: first.sessionId,
    send,
    subscribe,
    /** Where the engine delivers a session's events: the practice chat's `onEvent`. */
    attach(next: (event: SessionEvent) => void) { sink = next },
    /** Every command the practice chat sent, in order: what lessons read as "the user did it". */
    sent,
    stats,
    /** True while a turn runs. */
    get busy() { return running !== undefined },
    get pending() { return pending.size },
    /** The kind of request waiting for an answer, if any. */
    get asking(): "approval" | "question" | undefined { return [...askKinds.values()][0] },
    /** Called after every event the engine produces and every command it handles, so the tour can look again. */
    onChange(next: () => void) { changed = next },
    get edited() { return edited },
    /** Runs `work` with the engine muted: the commands it sends do not show up in `sent` or in the prompt history. */
    async quiet<T>(work: () => Promise<T>): Promise<T> {
      muted += 1
      try { return await work() } finally { muted -= 1 }
    },
    /** The practice project's file back as it was before any edit. */
    resetWorkspace() { fileText = BEFORE.join("\n"); edited = false },
    /** Ends the running turn and empties the queue without tearing the engine down (a new lesson starts clean). */
    interrupt() { queue.length = 0; running?.abort.abort() },
    /** Resolves when the running turn has ended (tests). */
    async settled() { while (running) await running.done },
    stop() {
      stopped = true
      running?.abort.abort()
      for (const resolve of pending.values()) resolve({ kind: "deny" })
      pending.clear()
      queue.length = 0
    },
  }
}
export type TutorialEngine = ReturnType<typeof createTutorialEngine>
