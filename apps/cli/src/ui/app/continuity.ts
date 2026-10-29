import type { ContinuityRecord, ContinuitySummary, SessionEvent } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { preload } from "../lazy-pages"

/** Restore jobs and questions that predate the loaded transcript window. */
export function createContinuity(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  return {
    async load() {
      const sessionId = state.sessionId, transcript = state.transcript, turnState = state.turnState
      const reply = await input.send({ type: "continuity.list", sessionId })
      if (!reply.ok || state.transcript !== transcript) return
      const records = (reply.result?.records ?? []) as ContinuitySummary[]
      transcript.restoreContinuity(records)
      const pending = records.filter((record) => record.kind === "question" && record.status === "pending")
      const requests = await Promise.all(pending.map(async (record): Promise<Extract<SessionEvent, { type: "server.request" }> | undefined> => {
        const reply = await input.send({ type: "continuity.get", sessionId, recordId: record.id })
        const question = reply.ok ? reply.result?.record as ContinuityRecord | undefined : undefined
        if (!question?.requestId || !question.questions || question.status !== "pending") return
        return { type: "server.request", sessionId, seq: 0, at: question.createdAt, turnId: question.turnId, requestId: question.requestId, kind: "question", async: true, title: `Asked ${question.questions.length} question${question.questions.length === 1 ? "" : "s"}`, detail: "", questions: question.questions }
      }))
      if (state.transcript !== transcript) return
      const restored = requests.filter((request) => request !== undefined)
      transcript.restoreAsyncRequests(restored)
      turnState.restoreAsyncRequests(restored)
      if (restored.length) await preload("approval")
      requestFrame()
    },
  }
}
