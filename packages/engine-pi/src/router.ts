import type { EnginePort } from "@mendcode/kernel"
import type { ModelChoice, SessionId } from "@mendcode/protocol"

/**
 * Sends each session whose model is a pi model (`pi`, `pi:<pattern>`) to the pi engine and every other session to
 * `base`. The choice is read at every turn, so /model moves the next turn and a per-turn model override routes that
 * turn alone. The pi engine is created on its first turn, so a daemon that never uses pi never loads it or starts it.
 * Shell commands always run on `base`; a session on pi compacts through pi itself.
 */
export function withPiEngine(input: { base: EnginePort; pi: (sessionId: SessionId) => Promise<EnginePort>; usesPi(sessionId: SessionId, override?: ModelChoice): boolean }): EnginePort {
  const { base } = input
  let pi: Promise<EnginePort> | undefined
  const piEngine = (sessionId: SessionId) => (pi ??= input.pi(sessionId).catch((error: unknown) => {
    pi = undefined
    throw error
  }))
  return {
    async runTurn(turn) {
      if (!input.usesPi(turn.sessionId, turn.selection?.model)) return base.runTurn(turn)
      const engine = await piEngine(turn.sessionId).catch((error: unknown) => error as Error)
      if (engine instanceof Error) return { status: "error", code: "pi_unavailable", message: `[PI]: ${engine.message}` }
      return engine.runTurn(turn)
    },
    ...(base.runShell ? { runShell: base.runShell.bind(base) } : {}),
    needsCompaction: (sessionId) => !input.usesPi(sessionId) && base.needsCompaction(sessionId),
    ...(base.contextReport
      ? {
          contextReport: async (sessionId: SessionId) => {
            if (input.usesPi(sessionId)) throw new Error("[PI]: pi manages this session's context")
            return base.contextReport!(sessionId)
          },
        }
      : {}),
    compact: async (compaction) => {
      if (!input.usesPi(compaction.sessionId)) return base.compact(compaction)
      const engine = await piEngine(compaction.sessionId).catch((error: unknown) => error as Error)
      if (engine instanceof Error) return { status: "error", code: "pi_unavailable", message: `[PI]: ${engine.message}` }
      return engine.compact(compaction)
    },
    ...(base.rewind ? { rewind: base.rewind.bind(base) } : {}),
    ...(base.release ? { release: base.release.bind(base) } : {}),
    ...(base.forget ? { forget: base.forget.bind(base) } : {}),
    ...(base.debugAgent ? { debugAgent: base.debugAgent.bind(base) } : {}),
    ...(base.catalogTools ? { catalogTools: base.catalogTools.bind(base) } : {}),
    // MendCode's tools lent to a Claude Code session (the host MCP bridge) come from the engine underneath.
    ...(base.hostTools ? { hostTools: base.hostTools.bind(base) } : {}),
    ...(base.hostCall ? { hostCall: base.hostCall.bind(base) } : {}),
  }
}
