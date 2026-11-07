import type { RestartHeld, SessionEvent, SessionId } from "@mendcode/protocol"

/** How often a drain looks at the sessions it holds. */
export const DRAIN_TICK_MS = 250
const MAX_SESSIONS = 20
const MAX_ITEMS = 8
const ITEM_CHARS = 300
/** `meta` keeps at most 500 characters per value: the index of sessions and each session's list are cut to fit. */
const META_CHARS = 500
const LOST_INDEX = "restart.lost"
const lostKey = (sessionId: string) => `restart.lost:${sessionId}`

const HELD_KEY = "restart.held"
/** Chunks of `restart.held` (each within meta's 500 characters): the sessions whose queue a restart's wait held. */
const HELD_CHUNKS = 16
const heldChunkKey = (index: number) => (index === 0 ? HELD_KEY : `${HELD_KEY}.${index}`)

/**
 * The tool calls a turn started and has not finished (its events from `turn.started` on), split by what a stop now would do:
 * `running` ones are cut; `asking` ones wait for the user (an approval or a question card) and run nothing yet. A request names its
 * tool call by `itemId`; one without it (Claude Code, Codex) is matched to an open call with the same title. A request matched to no
 * open call is listed by its title. Requests mirrored from another session (`async`) are that session's.
 */
export function turnWork(events: readonly SessionEvent[]): { running: string[]; asking: string[] } {
  const open = new Map<string, string>()
  const requests = new Map<string, { itemId?: string | undefined; title: string }>()
  for (const event of events) {
    if (event.type === "item.started" && event.kind === "tool_call") open.set(event.itemId, String(event.meta?.tool ?? "tool").slice(0, ITEM_CHARS))
    else if (event.type === "item.completed") open.delete(event.itemId)
    else if (event.type === "server.request" && !event.async) requests.set(event.requestId, { itemId: event.itemId, title: event.title.slice(0, ITEM_CHARS) })
    else if (event.type === "server.request.resolved") requests.delete(event.requestId)
  }
  const waiting = new Set<string>()
  const asking: string[] = []
  for (const request of requests.values()) {
    const itemId = request.itemId
      ? (open.has(request.itemId) ? request.itemId : undefined)
      : [...open].reverse().find(([id, tool]) => !waiting.has(id) && tool === request.title)?.[0]
    if (itemId) waiting.add(itemId)
    asking.push(itemId ? open.get(itemId)! : request.title)
  }
  return { running: [...open].filter(([id]) => !waiting.has(id)).map(([, tool]) => tool), asking }
}

/** The tool calls a stop now would cut: started, not finished, and not waiting for the user. */
export function openToolCalls(events: readonly SessionEvent[]): string[] {
  return turnWork(events).running
}

/** The sessions whose queue the restart's wait held, kept for the next start (`takeHeld`), which lets their messages go on. */
export function recordHeld(meta: Meta, sessionIds: Iterable<string>) {
  const chunks: string[][] = [[]]
  for (const id of sessionIds) {
    const chunk = chunks.at(-1)!
    if (JSON.stringify([...chunk, id]).length <= META_CHARS) { chunk.push(id); continue }
    if (chunks.length >= HELD_CHUNKS) break
    chunks.push([id])
  }
  for (let index = 0; index < HELD_CHUNKS; index++) meta.set(heldChunkKey(index), index < chunks.length && chunks[index]!.length ? JSON.stringify(chunks[index]) : "")
}

/** The sessions the previous restart's wait held; read once and cleared. */
export function takeHeld(meta: Meta): string[] {
  const found: string[] = []
  for (let index = 0; index < HELD_CHUNKS; index++) {
    const value = meta.get(heldChunkKey(index))
    if (!value) break
    meta.set(heldChunkKey(index), "")
    try {
      const ids: unknown = JSON.parse(value)
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") found.push(id)
    } catch { /* a cut value is skipped */ }
  }
  return found
}

/** Every session with something running that a stop would kill, with what runs: the bounded list a restart shows and records. */
export function collectHeld(input: { sessions: Iterable<SessionId>; running(sessionId: SessionId): string[]; title(sessionId: SessionId): string; except?: string | undefined }): RestartHeld {
  const held: RestartHeld = []
  for (const sessionId of input.sessions) {
    if (sessionId === input.except) continue
    const items = input.running(sessionId)
    if (!items.length) continue
    held.push({ sessionId, title: input.title(sessionId).slice(0, 100), items: items.slice(0, MAX_ITEMS).map((item) => item.slice(0, ITEM_CHARS)) })
    if (held.length >= MAX_SESSIONS) break
  }
  return held
}

/** One line per session, for whoever restarts: `<session> "<title>": <what runs>; <what runs>`. */
export function heldText(held: RestartHeld): string {
  return held.map((entry) => `${entry.sessionId} ${JSON.stringify(entry.title)}: ${entry.items.join("; ")}`).join("\n")
}

/** What the resumed session reads: what the stop killed, by command line, so it can start again what it still needs. */
export function lostText(items: readonly string[]): string {
  return `The daemon restart stopped work that was still running in this session; it did not finish: ${items.map((item) => `\`${item}\``).join(", ")}. Check what each one left (a half-applied change, a partial run) and start again the ones still needed; their completion notices will not come.`
}

type Meta = { get(key: string): string | undefined; set(key: string, value: string): void }

/** Keeps what a stop killed for the next start (`takeLost`). Each list is cut to what `meta` holds. */
export function recordLost(meta: Meta, held: RestartHeld) {
  if (!held.length) return
  const ids: string[] = []
  for (const entry of held) {
    const items = [...entry.items]
    while (items.length > 1 && JSON.stringify(items).length > META_CHARS) items.pop()
    const value = JSON.stringify(items.length === 1 && JSON.stringify(items).length > META_CHARS ? [items[0]!.slice(0, META_CHARS - 10)] : items)
    if (JSON.stringify([...ids, entry.sessionId]).length > META_CHARS) break
    meta.set(lostKey(entry.sessionId), value)
    ids.push(entry.sessionId)
  }
  meta.set(LOST_INDEX, JSON.stringify(ids))
}

/** What the previous stop killed, by session; read once and cleared. */
export function takeLost(meta: Meta): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const index = meta.get(LOST_INDEX)
  if (!index) return found
  meta.set(LOST_INDEX, "")
  let ids: unknown
  try { ids = JSON.parse(index) } catch { return found }
  if (!Array.isArray(ids)) return found
  for (const id of ids) {
    if (typeof id !== "string") continue
    const value = meta.get(lostKey(id))
    meta.set(lostKey(id), "")
    try {
      const items = value ? JSON.parse(value) : undefined
      if (Array.isArray(items) && items.length) found.set(id, items.map(String))
    } catch { /* a cut value is skipped */ }
  }
  return found
}

/**
 * The wait of a forced restart (`daemon.shutdown` with `drainMs`). Every session is held (paused: it starts no new turn) and nothing
 * is interrupted while it waits: a session with a command, a background task or a sub-agent running is waited for, until that ends
 * or the grace runs out. A session that only waits for the user (an approval or a question) is not waited for: its turn is
 * interrupted by the stop and resumes after the restart, which asks again. The next start lets go of every queue this wait held
 * (`recordHeld`, `takeHeld`): a paused session's queue is restored held, and only the user's own pause or cancel should keep it. Then the daemon itself stops (`stop`), which interrupts the turns still open (they resume after the restart)
 * and kills only what still runs. When every client that asked goes away first, the drain is let go: the sessions it paused go on,
 * and no turn was cut. Nothing runs outside a drain: its timer exists only between `begin` and the stop or the release.
 */
export function createRestartDrain(deps: {
  sessions(): Iterable<SessionId>
  /** What runs in a session that a stop would kill; empty when nothing does. */
  running(sessionId: SessionId): string[]
  /** What in a session waits for the user (an approval or question card): shown, never waited for; the turn resumes after the restart. */
  asking?(sessionId: SessionId): string[]
  title(sessionId: SessionId): string
  /** Paused already (by the user): the drain neither pauses it nor releases it. */
  paused(sessionId: SessionId): boolean
  hold(sessionId: SessionId, on: boolean): Promise<unknown>
  /** The wait is over: stop the daemon for the restart. Called once. */
  stop(): void
  now(): number
  log(level: "info" | "warn", message: string): void
  tickMs?: number
}) {
  let state: { until: number; except?: string | undefined; done: boolean; waiting: RestartHeld; asking: RestartHeld; seen: Set<SessionId>; held: Set<SessionId>; askers: number } | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false

  async function tick() {
    if (!state || ticking) return
    ticking = true
    try {
      const current = state
      for (const sessionId of deps.sessions()) {
        if (sessionId === current.except || current.seen.has(sessionId)) continue
        current.seen.add(sessionId)
        if (deps.paused(sessionId)) continue
        current.held.add(sessionId)
        await deps.hold(sessionId, true)
        if (state !== current) return
      }
      if (state !== current || current.done) return
      current.waiting = collectHeld({ sessions: deps.sessions(), running: deps.running, title: deps.title, except: current.except })
      current.asking = deps.asking ? collectHeld({ sessions: deps.sessions(), running: deps.asking, title: deps.title, except: current.except }) : []
      if (current.waiting.length && deps.now() < current.until) return
      current.done = true
      if (timer) clearInterval(timer)
      timer = undefined
      deps.log(current.waiting.length ? "warn" : "info", current.waiting.length ? `[DAEMON]: the restart's grace ended with work still running; stopping kills it:\n${heldText(current.waiting)}` : "[DAEMON]: the work a restart waited for ended; stopping for the restart")
      deps.stop()
    } catch (error) {
      deps.log("warn", `[DAEMON]: restart wait failed: ${error instanceof Error ? error.message : String(error)}`)
      release("it failed")
    } finally { ticking = false }
  }

  /** Lets the drain go without a stop: every session it paused goes on. */
  function release(why: string) {
    const current = state
    if (!current || current.done) return
    dispose()
    deps.log("warn", `[DAEMON]: the restart's wait was let go (${why}); the sessions it held go on`)
    for (const sessionId of current.held) void deps.hold(sessionId, false)
  }

  function dispose() {
    if (timer) clearInterval(timer)
    timer = undefined
    state = undefined
  }

  return {
    /**
     * Starts holding (or extends a drain already running); what runs now, for the caller to show. `except`: the session that asked.
     * `gone`: aborted when the client that asked leaves; once every one that asked has left, the drain is let go.
     */
    async begin(graceMs: number, input: { except?: string | undefined; gone?: AbortSignal | undefined } = {}): Promise<RestartHeld> {
      const until = deps.now() + graceMs
      if (state) state.until = Math.max(state.until, until)
      else state = { until, except: input.except, done: false, waiting: [], asking: [], seen: new Set(), held: new Set(), askers: 0 }
      const current = state
      if (input.gone) {
        current.askers++
        const left = () => { if (state === current && --current.askers === 0) release("the client that asked for the restart left") }
        if (input.gone.aborted) left()
        else input.gone.addEventListener("abort", left, { once: true })
      }
      await tick()
      if (state && !state.done && !timer) {
        timer = setInterval(() => void tick(), deps.tickMs ?? DRAIN_TICK_MS)
        timer.unref?.()
      }
      return current.waiting
    },
    status() {
      return state ? { waiting: state.waiting, ...(state.asking.length ? { asking: state.asking } : {}), until: state.until, done: state.done } : undefined
    },
    /** The sessions this drain holds (paused for it, not by the user); empty outside a drain. */
    held(): SessionId[] { return state ? [...state.held] : [] },
    /** The session that asked for the restart: what it runs is the restart itself. */
    except() { return state?.except },
    dispose,
  }
}
export type RestartDrain = ReturnType<typeof createRestartDrain>
