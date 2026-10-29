import type { SessionEvent } from "@mendcode/protocol"
import type { AppContext } from "./context"

export function createActivityAudio(ctx: AppContext) {
  const { input, state, fail } = ctx
  let sessionId = state.sessionId
  let lastSeq = 0
  let busy = false
  let active = false
  let disposed = false
  let warned = false
  let revision = 0
  let mode = state.tuiProfile.activitySound
  let attentionPlayed = false

  function send(action: "start" | "stop" | "pulse", scale?: number) {
    if (input.remote) return
    const current = ++revision
    void input.send({ type: "audio.play", action, ...(scale === undefined ? {} : { scale }) }).then((reply) => {
      if (current !== revision || action === "stop" || disposed || state.tuiProfile.activitySound === "off" || warned) return
      if (!reply.ok || reply.result?.played === false) {
        warned = true
        fail(reply.ok ? "Activity sound unavailable: install a local audio player" : reply.error.message)
      }
    }).catch(() => {})
  }

  function stop() {
    if (active) send("stop")
    active = false
    busy = false
  }

  function sync() {
    const next = state.tuiProfile.activitySound
    if (next === mode) return
    if (next === "off" || mode === "hum" && next === "pulse") stop()
    mode = next
    warned = false
  }

  function note(event: SessionEvent) {
    if (sessionId !== state.sessionId) { stop(); sessionId = state.sessionId; lastSeq = 0 }
    if (disposed || input.remote || event.sessionId !== sessionId || event.seq <= lastSeq) return
    lastSeq = event.seq
    if (event.at < state.openedAt || state.tuiProfile.activitySound === "off") return
    const start = event.type === "turn.started" || event.type === "foreground.state" && ["generating", "tool", "compacting"].includes(event.state)
    const attention = event.type === "server.request" || event.type === "foreground.state" && event.state === "waiting_approval"
    const done = event.type === "turn.completed" || event.type === "turn.failed"
    const end = event.type === "turn.cancelled" || event.type === "turn.interrupted" || event.type === "foreground.state" && ["idle", "error", "cancelling"].includes(event.state)
    if (start && !busy) {
      busy = true
      attentionPlayed = false
      if (state.tuiProfile.activitySound === "hum") { active = true; send("start") }
    } else if (done || attention && !attentionPlayed) {
      busy = false
      attentionPlayed = attention
      active = true
      send("pulse", event.type === "turn.failed" || attention ? 0.8 : 1)
    } else if (end && (busy || event.type === "turn.cancelled" || event.type === "turn.interrupted" || event.type === "foreground.state" && event.state === "cancelling")) stop()
  }

  function reset() { stop(); sessionId = state.sessionId; lastSeq = 0; attentionPlayed = false }
  function dispose() { stop(); disposed = true }
  return { note, sync, reset, dispose }
}
