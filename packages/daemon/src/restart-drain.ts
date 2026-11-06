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

/** The tool calls a turn started and has not finished (its events from `turn.started` on): what a stop now would cut. */
export function openToolCalls(events: readonly SessionEvent[]): string[] {
  const open = new Map<string, string>()
  for (const event of events) {
    if (event.type === "item.started" && event.kind === "tool_call") open.set(event.itemId, String(event.meta?.tool ?? "tool").slice(0, ITEM_CHARS))
    else if (event.type === "item.completed") open.delete(event.itemId)
  }
  return [...open.values()]
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
 * or the grace runs out. Then the daemon itself stops (`stop`), which interrupts the turns still open (they resume after the restart)
 * and kills only what still runs. When every client that asked goes away first, the drain is let go: the sessions it paused go on,
 * and no turn was cut. Nothing runs outside a drain: its timer exists only between `begin` and the stop or the release.
 */
export function createRestartDrain(deps: {
  sessions(): Iterable<SessionId>
  /** What runs in a session that a stop would kill; empty when nothing does. */
  running(sessionId: SessionId): string[]
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
  let state: { until: number; except?: string | undefined; done: boolean; waiting: RestartHeld; seen: Set<SessionId>; held: Set<SessionId>; askers: number } | undefined
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
      else state = { until, except: input.except, done: false, waiting: [], seen: new Set(), held: new Set(), askers: 0 }
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
      return state ? { waiting: state.waiting, until: state.until, done: state.done } : undefined
    },
    /** The session that asked for the restart: what it runs is the restart itself. */
    except() { return state?.except },
    dispose,
  }
}
export type RestartDrain = ReturnType<typeof createRestartDrain>
