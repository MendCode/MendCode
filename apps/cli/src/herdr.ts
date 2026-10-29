import { connect } from "node:net"

/**
 * herdr's agent reporting (docs/herdr.md): inside a herdr pane, or a tuios pane (tuios answers herdr's socket in every pane),
 * MendCode tells the multiplexer what its session is doing, so its sidebar shows it working, blocked on an approval or idle,
 * and can resume it. One short request per change, newline-delimited JSON over the pane's socket; nothing when not in a pane.
 * In a tuios pane the rail also gets the session's model, context and cost (`createTuiosMeta`).
 */

export type HerdrState = "idle" | "working" | "blocked"
export type PaneReport = { state: HerdrState; message?: string; sessionId?: string }

const SOURCE = "mendcode"
/** A report that gets no answer by then is given up: the multiplexer may be gone, and MendCode never waits on it. */
const REPLY_MS = 2_000
const MESSAGE_CHARS = 160

/** The pane to report to, when MendCode runs in one: `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`, unless `MENDCODE_HERDR=0`. */
export function herdrPane(env: Record<string, string | undefined>): { socket: string; pane: string } | undefined {
  if (env.MENDCODE_HERDR === "0" || (env.HERDR_ENV !== undefined && env.HERDR_ENV !== "1")) return undefined
  const socket = env.HERDR_SOCKET_PATH?.trim()
  const pane = env.HERDR_PANE_ID?.trim()
  return socket && pane ? { socket, pane } : undefined
}

/** What the multiplexer shows for a foreground state: a turn at work, one waiting on the person, or nothing running. */
export function paneState(foreground: string): HerdrState {
  if (foreground === "waiting_approval") return "blocked"
  return foreground === "idle" || foreground === "queued" || foreground === "error" ? "idle" : "working"
}

export function createHerdrReporter(input: { socket: string; pane: string; program: string; now(): number; send?(socket: string, line: string): Promise<void> }) {
  const send = input.send ?? sendLine
  let last = ""
  let seq = 0
  let held = false
  /** Reports go one after another, so the multiplexer sees them in order. */
  let chain: Promise<void> = Promise.resolve()
  // Every report from this source carries a larger number than the last, across restarts too: a clock that never goes back.
  const nextSeq = () => (seq = Math.max(seq + 1, input.now()))
  const request = (method: string, params: Record<string, unknown>) => {
    const line = `${JSON.stringify({ id: `${SOURCE}-${seq}`, method, params: { pane_id: input.pane, source: SOURCE, agent: input.program, seq, ...params } })}\n`
    chain = chain.then(() => send(input.socket, line)).catch(() => undefined)
    return chain
  }
  return {
    /** Sends the report when it differs from the last one; the same state again sends nothing. */
    report(next: PaneReport) {
      const message = next.message?.replace(/\s+/g, " ").trim().slice(0, MESSAGE_CHARS)
      const key = JSON.stringify([next.state, message ?? "", next.sessionId ?? ""])
      if (key === last) return chain
      last = key
      held = true
      nextSeq()
      return request("pane.report_agent", {
        state: next.state,
        ...(message ? { message } : {}),
        // The session it shows can be resumed from the multiplexer after a restart.
        ...(next.sessionId ? { agent_session_id: next.sessionId, resume_argv: [input.program, "--session", next.sessionId] } : {}),
      })
    },
    /** The person quit: the pane is no longer MendCode's. */
    release() {
      if (!held) return chain
      held = false
      last = ""
      nextSeq()
      return request("pane.release_agent", {})
    },
  }
}
export type HerdrReporter = ReturnType<typeof createHerdrReporter>

/** What tuios's rail shows under the agent's row: the session's model, how full its context is and what it has cost. */
export type PaneFacts = { model?: string; contextPercent?: number; costMicros?: number }

/** tuios's own socket and this pane, when MendCode runs in a tuios pane (`TUIOS_ENV=1`), unless `MENDCODE_HERDR=0`. */
export function tuiosPane(env: Record<string, string | undefined>): { socket: string; window: string; session?: string } | undefined {
  if (env.MENDCODE_HERDR === "0" || env.TUIOS_ENV !== "1") return undefined
  const socket = env.TUIOS_SOCKET?.trim()
  const window = env.TUIOS_PANE_ID?.trim()
  const session = env.TUIOS_SESSION?.trim()
  return socket && window ? { socket, window, ...(session ? { session } : {}) } : undefined
}

const money = (micros: number) => (micros > 0 && micros < 10_000 ? "<$0.01" : `$${(micros / 1e6).toFixed(2)}`)

/**
 * tuios's agent metadata (`tuios set-agent-meta`): display-only facts under the agent's row, sent when they change. Each
 * request is tuios's control protocol on its own connection: `hello`, then `set-agent-meta` for this pane. A fact that
 * goes away is sent empty, which removes its key; tuios drops them all when the agent leaves the pane.
 */
export function createTuiosMeta(input: { socket: string; window: string; session?: string; send?(socket: string, text: string, replies: number): Promise<void> }) {
  const send = input.send ?? sendLines
  let last = ""
  let chain: Promise<void> = Promise.resolve()
  return {
    set(facts: PaneFacts) {
      const tokens = {
        model: facts.model ?? "",
        context: facts.contextPercent !== undefined ? `${facts.contextPercent}%` : "",
        cost: facts.costMicros ? money(facts.costMicros) : "",
      }
      const key = JSON.stringify(tokens)
      if (key === last) return chain
      last = key
      const hello = { id: 1, verb: "hello", params: { client: SOURCE, protocol: 1 } }
      const meta = { id: 2, verb: "set-agent-meta", params: { clear: false, source: SOURCE, tokens, window: input.window, ...(input.session ? { session: input.session } : {}) } }
      chain = chain.then(() => send(input.socket, `${JSON.stringify(hello)}\n${JSON.stringify(meta)}\n`, 2)).catch(() => undefined)
      return chain
    },
  }
}
export type TuiosMeta = ReturnType<typeof createTuiosMeta>

/** A sub-agent of the session, as the pane reports it: `type` names its agent, model and engine (`explore · Sonnet 5.5 · claude`). */
export type PaneChild = { id: string; type: string; description: string; state: "running" | "waiting" | "done" | "failed" | "stopped"; tool?: string; pending?: string; result?: string }

const live = (child: PaneChild) => child.state === "running" || child.state === "waiting"
const firstLine = (text: string | undefined, chars: number) => (text ?? "").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, chars) ?? ""
/** tuios takes 1 to 128 letters, digits and `_.:@-` as a subagent's id. */
const agentId = (id: string) => id.replace(/[^A-Za-z0-9_.:@-]/g, "-").slice(0, 128) || "child"

/**
 * The session's sub-agents in tuios's rail (`report-agent-activity`), under the pane's own MendCode row: each one starts, says
 * what it was asked and the tool it runs, and stops with how it ended (done with its answer, failed with the error, or stopped).
 * Only changes are sent. Another session in the pane, and the first report of a process, start with `session_start`, which
 * makes tuios forget the children it had: none is left behind from a session switch, a crash or a restart. A child that leaves
 * the list while running is stopped. The reports name the pane's harness and session, so tuios never puts them on another agent.
 * herdr has no sub-agent rows: there the pane only shows blocked while a child waits on the person (main.ts).
 */
export function createTuiosChildren(input: { socket: string; window: string; session?: string; send?(socket: string, text: string, replies: number): Promise<void> }) {
  const send = input.send ?? sendLines
  let owner: string | undefined
  const open = new Map<string, string>()
  let chain: Promise<void> = Promise.resolve()
  const flush = (sessionId: string, events: Array<Record<string, unknown>>) => {
    if (!events.length) return chain
    const hello = { id: 1, verb: "hello", params: { client: SOURCE, protocol: 1 } }
    const lines = [hello, ...events.map((activity, at) => ({ id: at + 2, verb: "report-agent-activity", params: { harness: SOURCE, agent_session_id: sessionId, activity, window: input.window, ...(input.session ? { session: input.session } : {}) } }))]
    chain = chain.then(() => send(input.socket, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), lines.length)).catch(() => undefined)
    return chain
  }
  return {
    sync(sessionId: string, children: readonly PaneChild[]) {
      const events: Array<Record<string, unknown>> = []
      if (sessionId !== owner) {
        events.push({ event: "session_start" })
        open.clear()
        owner = sessionId
      }
      const seen = new Set<string>()
      for (const child of children) {
        const id = agentId(child.id)
        seen.add(id)
        const shown = JSON.stringify([firstLine(child.description, 200), child.tool ?? ""])
        const before = open.get(id)
        if (live(child)) {
          if (before === undefined) events.push({ event: "subagent_start", agent_id: id, agent_type: child.type.slice(0, 80) })
          if (before !== shown) events.push({ event: "subagent_update", agent_id: id, text: firstLine(child.description, 200), ...(child.tool ? { tool: child.tool.slice(0, 120) } : {}) })
          open.set(id, shown)
        } else if (before !== undefined) {
          // A child seen ending: failed carries its error, done its answer, and a stop with no text reads as stopped.
          events.push(child.state === "failed"
            ? { event: "subagent_update", agent_id: id, outcome: "failed", text: firstLine(child.result, 200) || firstLine(child.description, 200) }
            : { event: "subagent_stop", agent_id: id, ...(child.state === "done" && firstLine(child.result, 200) ? { text: firstLine(child.result, 200) } : {}) })
          open.delete(id)
        }
      }
      for (const id of [...open.keys()].filter((id) => !seen.has(id))) {
        events.push({ event: "subagent_stop", agent_id: id })
        open.delete(id)
      }
      return flush(sessionId, events)
    },
    /** MendCode leaves the pane: its children leave tuios's rail with it. */
    clear() {
      if (owner === undefined || !open.size) return chain
      open.clear()
      return flush(owner, [{ event: "session_start" }])
    },
  }
}
export type TuiosChildren = ReturnType<typeof createTuiosChildren>

/** The child a pane shows as waiting on the person, for the pane's blocked state: the first one, by what it waits on. */
export function waitingChild(children: readonly PaneChild[]): string | undefined {
  const child = children.find((entry) => entry.state === "waiting")
  return child ? `${firstLine(child.description, 60)}: ${child.pending ?? "needs you"}` : undefined
}

/** One request on its own connection; the answer is read and dropped (a refusal changes nothing for MendCode). */
const sendLine = (socket: string, line: string) => sendLines(socket, line, 1)

/** `text` on its own connection, closed once `replies` answer lines came back or after `REPLY_MS`. */
function sendLines(socket: string, text: string, replies: number): Promise<void> {
  return new Promise((resolve) => {
    const connection = connect(socket)
    let answered = 0
    const done = () => { clearTimeout(timer); connection.destroy(); resolve() }
    const timer = setTimeout(done, REPLY_MS)
    connection.on("connect", () => connection.write(text))
    connection.on("data", (data) => { answered += String(data).split("\n").length - 1; if (answered >= replies) done() })
    connection.on("error", done)
    connection.on("close", done)
  })
}
