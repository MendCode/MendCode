import type { AppContext } from "./context"

export const DAEMON_LEGACY_NOTICE = "daemon is an older build · restart it with --restart-daemon"
export const DAEMON_PENDING_NOTICE = "daemon restarts on the new build when its running work ends"
const USAGE = "usage: /daemon [status | restart]"

export type SessionAction = "reload" | "restart"

/** The line over the prompt while `/reload` or `/restart` waits for this session's response. */
export const waitingNotice = (action: SessionAction) => `/${action} waits for the current response · esc cancels`

/** `/daemon`: the connected daemon's build and work, and a restart that never interrupts anything running; `/reload` and `/restart` of this session. */
export function createDaemon(ctx: AppContext, deps: { reloadTerminal: () => Promise<void> }) {
  const { input, state, say, fail, requestFrame } = ctx

  // An older daemon that is in use still works and stops by itself when idle: nothing to do, so nothing is said. `/daemon` tells.
  let older = input.daemon?.older === true

  /** After every reconnect: an idle older daemon is restarted (the next reconnect confirms it); a busy one is left alone, silently. */
  async function reconcile() {
    if (!input.daemon) return
    const was = state.daemonRestart
    const skew = await input.daemon.check().catch(() => "fresh" as const)
    older = skew === "busy"
    if (skew === "restarting") state.daemonRestart = "older"
    else if (skew === "fresh") {
      state.daemonNotice = undefined
      state.daemonRestart = undefined
      // A restart the user asked for is confirmed; one this terminal did on its own to an idle older daemon is not announced.
      if (was && was !== "older") say("daemon restarted")
    } else {
      // A restart that waits for running work (`/restart`, `/daemon restart` while busy) stays in view until it happens.
      const pending = skew === "busy" && await input.send({ type: "daemon.status" }).then((reply) => reply.ok && (reply.result as { restartPending?: boolean } | undefined)?.restartPending === true, () => false)
      state.daemonNotice = skew === "legacy" ? DAEMON_LEGACY_NOTICE : pending ? DAEMON_PENDING_NOTICE : undefined
      // The daemon came back and the builds still differ: it is this terminal that is behind, and waiting changes nothing.
      if (was === "manual") {
        state.daemonRestart = undefined
        say("daemon restarted · this terminal is an older build, reopen it to update")
      }
    }
    requestFrame()
  }

  async function status() {
    const reply = await input.send({ type: "daemon.status" })
    if (!reply.ok) return fail(reply.error.message)
    const report = (reply.result ?? {}) as { buildId?: string; activeTurns?: number; backgroundJobs?: number; clients?: number }
    state.notice = [`daemon ${report.buildId ?? "unknown build"}${older ? " (older than this terminal)" : ""}`, `${report.activeTurns ?? 0} turns`, `${report.backgroundJobs ?? 0} jobs`, ...(report.clients !== undefined ? [`${report.clients} client${report.clients === 1 ? "" : "s"}`] : [])].join(" · ")
    requestFrame()
  }

  async function restart() {
    if (!input.daemon) return say("daemon restart is for a local daemon", "warning")
    const result = await input.daemon.restart()
    if (!result.ok) return say(result.message, "warning")
    state.daemonRestart = "manual"
    if (result.pending) {
      state.daemonNotice = DAEMON_PENDING_NOTICE
      return say("the daemon restarts when its running work ends")
    }
    say("restarting daemon…")
  }

  /** `/restart`: this terminal starts again on the same session; the daemon and the other terminals keep running. Only a refusal comes back here. */
  async function restartTerminal() {
    if (!input.daemon?.restartTerminal) return say("restart is for a local daemon", "warning")
    say("restarting…")
    const result = await input.daemon.restartTerminal()
    say(result.message, "warning")
  }

  /**
   * `/reload`: this session's resources read again with no restart: the daemon's extensions and MCP servers for this
   * project, then this terminal's keys, extensions and theme files. Skills, prompts and context files are read at each turn.
   */
  async function reload() {
    const reply = await input.send({ type: "extensions.reload", directory: input.directory ?? "" })
    if (!reply.ok) return fail(reply.error.message)
    await deps.reloadTerminal()
    say("Reloaded extensions, packages, keys and themes")
  }

  const RUN = { reload, restart: restartTerminal } as const

  /** Run now when this session is idle; while its response runs, wait for it to end (one standing line, esc cancels). */
  async function whenIdle(action: SessionAction) {
    if (!state.transcript.activeTurn) return RUN[action]()
    state.waitingFor = action
    requestFrame()
  }

  /** The session's turn ended: a waiting `/reload` or `/restart` runs now. */
  function noteTurnEnded() {
    const action = state.waitingFor
    if (!action || state.transcript.activeTurn) return
    state.waitingFor = undefined
    void RUN[action]()
  }

  /** Esc while waiting drops the wait first; a second Esc interrupts the response as usual. */
  function cancelWait() {
    if (!state.waitingFor) return false
    say(`/${state.waitingFor} cancelled`)
    state.waitingFor = undefined
    requestFrame()
    return true
  }

  async function daemonCommand(args: string) {
    const word = args.trim().toLowerCase()
    if (word === "" || word === "status") return status()
    if (word === "restart") return restart()
    state.notice = USAGE
    requestFrame()
  }

  return { daemonCommand, whenIdle, noteTurnEnded, cancelWait, reconcile }
}
