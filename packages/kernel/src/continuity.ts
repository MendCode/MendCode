import type { ContinuityRecord, QuestionInfo, SessionId, TurnId } from "@mendcode/protocol"

/** Session-scoped ports. Permissions are resolved by the engine before admission. */
export type ContinuityPort = {
  start(input: { id: string; turnId: TurnId; tool: "read" | "grep" | "glob" | "webfetch" }, signal: AbortSignal, run: (signal: AbortSignal) => Promise<{ output: string; isError: boolean; attachments?: unknown[]; images?: unknown[] }>): ContinuityRecord
  get(id: string, offset?: number, limit?: number): ContinuityRecord & { nextOffset?: number }
  cancel(id: string): ContinuityRecord
  wait(ids: string[], timeoutMs: number, signal: AbortSignal): Promise<ContinuityRecord[]>
  question(input: { id: string; turnId: TurnId; questions: QuestionInfo[] }): ContinuityRecord
}
export type ContinuityForSession = (sessionId: SessionId) => ContinuityPort
