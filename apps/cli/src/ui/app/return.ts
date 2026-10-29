import { isReturnDialog } from "../../view/return-card"
import type { AppContext } from "./context"

/** Away this long (focus lost, or nothing typed on a terminal that does not report focus) before a finished turn is worth a recap. */
export const AWAY_MS = 5 * 60_000
const IDLE_LIMITS = { "30m": 30 * 60_000, "1h": 60 * 60_000, "3h": 3 * 60 * 60_000 } as const
/**
 * A session with less context than this is not worth a question: re-reading it is cheap, and compacting it costs about what it
 * saves. The question is asked from half of the session's compaction threshold, and never below the floor.
 */
export const IDLE_MIN_TOKENS = 50_000
export const IDLE_SHARE = 0.5
/** A resumed session at this share of its compaction threshold is offered a compaction. */
export const HUGE_SHARE = 0.8
const TURN_ENDS = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"])

type ContextFacts = { tokens: number; limit: number }

/**
 * Coming back to a session (docs/return.md): a recap of what finished while this terminal was away, a question before
 * sending into a session that went cold with a large context, and on resume where to continue (a session that ran in
 * another directory) and whether to compact a very large one. Every prompt is a card (`returnPrompt`); the dialogs own
 * the keys until answered, so nothing is typed underneath them.
 */
export function createReturn(ctx: AppContext, actions: { submit(): Promise<void> }) {
  const { input, state, now, say, fail, requestFrame } = ctx
  let lastActivityAt = now()
  let lastInputAt = now()
  let lastTurnEndAt = 0
  let awaySince: number | undefined
  let bypassIdle = false
  let recapToken = 0
  let resumeToken = 0

  /** Session events keep the idle clock and remember when a turn last ended. */
  function noteEvent(event: { type: string }) {
    lastActivityAt = now()
    if (TURN_ENDS.has(event.type)) lastTurnEndAt = now()
  }

  async function contextFacts(sessionId: typeof state.sessionId): Promise<ContextFacts | undefined> {
    const reply = await input.send({ type: "context.query", sessionId })
    if (!reply.ok) return undefined
    const report = reply.result as { estimatedTokens?: number; measuredTokens?: number; compactAtTokens?: number } | undefined
    if (!report) return undefined
    return { tokens: report.measuredTokens ?? report.estimatedTokens ?? 0, limit: report.compactAtTokens ?? 0 }
  }

  async function compact() {
    const reply = await input.send({ type: "session.compact", sessionId: state.sessionId })
    if (!reply.ok) {
      fail(reply.error.message)
      return false
    }
    say("compacting the session", "info")
    return true
  }

  /** Back in the window after `since`: when a turn ended meanwhile, the session's recap shows as a card. */
  async function comeBack(since: number) {
    const away = now() - since
    if (!state.tuiProfile.autoRecap || away < AWAY_MS || lastTurnEndAt <= since) return
    if (input.remote?.readOnly || state.page !== "chat" || state.returnPrompt || state.transcript.activeTurn !== undefined) return
    const sessionId = state.sessionId
    const token = ++recapToken
    const reply = await input.send({ type: "session.recap", sessionId })
    if (token !== recapToken || sessionId !== state.sessionId || !reply.ok) return
    const text = String(reply.result?.text ?? "").trim()
    if (!text || state.returnPrompt || state.page !== "chat") return
    state.returnPrompt = { kind: "recap", text, awayMs: away }
    requestFrame()
  }

  const focus = input.screen.focus
  focus?.subscribe((next) => {
    if (next === "unfocused") awaySince = now()
    else if (next === "focused") {
      const since = awaySince
      awaySince = undefined
      if (since !== undefined) void comeBack(since)
    }
  })

  /** A terminal read that was not a focus report. Without focus reports a long pause in typing stands in for the absence. */
  function noteInput() {
    const at = now()
    const reports = focus !== undefined && focus.state !== "unknown"
    if (!reports && at - lastInputAt >= AWAY_MS) void comeBack(lastInputAt)
    lastInputAt = at
  }

  /** Before a message is sent: true when the session sat idle with a large context and the question is now open (the prompt keeps its text). */
  async function idleGate(): Promise<boolean> {
    if (bypassIdle) {
      bypassIdle = false
      return false
    }
    const limit = IDLE_LIMITS[state.tuiProfile.idleReturn as keyof typeof IDLE_LIMITS]
    if (!limit || state.returnPrompt || input.startup?.prompt !== undefined) return false
    const idle = now() - lastActivityAt
    if (idle < limit || state.transcript.activeTurn !== undefined || state.transcript.pendingRequests.length > 0) return false
    const sessionId = state.sessionId
    const facts = await contextFacts(sessionId)
    if (sessionId !== state.sessionId || !facts || facts.tokens < Math.max(IDLE_MIN_TOKENS, facts.limit * IDLE_SHARE)) return false
    state.returnPrompt = { kind: "idle", idleMs: idle, tokens: facts.tokens }
    requestFrame()
    return true
  }

  async function checkHuge(token: number) {
    const sessionId = state.sessionId
    if (state.transcript.blocks().length === 0 || state.transcript.activeTurn !== undefined) return
    const facts = await contextFacts(sessionId)
    if (token !== resumeToken || sessionId !== state.sessionId || !facts || facts.limit <= 0 || state.returnPrompt || state.page !== "chat") return
    if (facts.tokens < facts.limit * HUGE_SHARE) return
    state.returnPrompt = { kind: "huge", tokens: facts.tokens, limit: facts.limit }
    requestFrame()
  }

  /** A session was opened (at start with `launch`, or switched to): its age feeds the idle clock, then the resume questions run. */
  async function checkResume({ launch = false }: { launch?: boolean } = {}) {
    const token = ++resumeToken
    const sessionId = state.sessionId
    lastTurnEndAt = 0
    const reply = await input.send({ type: "session.get", sessionId })
    if (token !== resumeToken || sessionId !== state.sessionId) return
    const detail = reply.ok ? (reply.result?.session as { directory?: string; updatedAt?: number } | undefined) : undefined
    if (detail?.updatedAt) lastActivityAt = detail.updatedAt
    if (!state.tuiProfile.resumePrompts || input.remote || input.startup?.prompt !== undefined || input.startup?.initialMessage !== undefined) return
    if (launch && input.launchDirectory && detail?.directory && detail.directory !== input.launchDirectory && state.page === "chat" && !state.returnPrompt) {
      state.returnPrompt = { kind: "cwd", sessionDirectory: detail.directory, launchDirectory: input.launchDirectory }
      requestFrame()
      return
    }
    await checkHuge(token)
  }

  async function moveHere(target: string) {
    const reply = await input.send({ type: "session.cd", sessionId: state.sessionId, path: target })
    if (!reply.ok) return fail(reply.error.message.replace(/^\[DAEMON\]:\s*/, ""))
    say(`now in ${String(reply.result?.directory ?? target)}`, "success")
  }

  /** Keys while a prompt is open. True when the key was taken: a dialog takes every key (the wheel excepted), the recap only esc. */
  async function returnKey(key: string): Promise<boolean> {
    const prompt = state.returnPrompt
    if (!prompt) return false
    if (!isReturnDialog(prompt)) {
      if (key !== "\x1b") return false
      state.returnPrompt = undefined
      return true
    }
    if (key.startsWith("\x1b[<")) return false
    const cancel = key === "\x1b" || key === "\x03" || key === "n"
    if (prompt.kind === "cwd") {
      if (key === "m") {
        state.returnPrompt = undefined
        await moveHere(prompt.launchDirectory)
      } else if (cancel || key === "y" || key === "\r") state.returnPrompt = undefined
      else return true
      void checkHuge(++resumeToken)
      return true
    }
    if (prompt.kind === "huge") {
      if (key === "y" || key === "c") {
        state.returnPrompt = undefined
        await compact()
      } else if (cancel || key === "\r") state.returnPrompt = undefined
      return true
    }
    if (cancel) state.returnPrompt = undefined
    else if (key === "\r" || key === "y" || key === "c") {
      state.returnPrompt = undefined
      if (key === "c" && !(await compact())) return true
      bypassIdle = true
      await actions.submit()
    }
    return true
  }

  return { noteEvent, noteInput, idleGate, checkResume, returnKey }
}
