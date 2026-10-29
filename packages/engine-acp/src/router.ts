import type { EnginePort } from "@mendcode/kernel"
import type { ModelChoice, SessionId } from "@mendcode/protocol"

/**
 * Sends each session whose model is an ACP agent (`acp:<name>`) to the ACP engine and every other session to `base`
 * (the daemon's own engine, or its Claude Code router). The choice is read at every turn, so switching models in
 * /model moves the next turn; a per-turn model override routes that turn alone. The ACP engine is created on its
 * first turn. Shell commands always run on `base`.
 */
export function withAcpEngine(input: { base: EnginePort; acp: () => Promise<EnginePort>; usesAcp(sessionId: SessionId, override?: ModelChoice): boolean }): EnginePort {
  const { base } = input
  let acp: Promise<EnginePort> | undefined
  const acpEngine = () => (acp ??= input.acp().catch((error: unknown) => {
    acp = undefined
    throw error
  }))
  return {
    async runTurn(turn) {
      if (!input.usesAcp(turn.sessionId, turn.selection?.model)) return base.runTurn(turn)
      const engine = await acpEngine().catch((error: unknown) => error as Error)
      if (engine instanceof Error) return { status: "error", code: "acp_unavailable", message: `[ACP]: ${engine.message}` }
      return engine.runTurn(turn)
    },
    ...(base.runShell ? { runShell: base.runShell.bind(base) } : {}),
    needsCompaction: (sessionId) => !input.usesAcp(sessionId) && base.needsCompaction(sessionId),
    ...(base.contextReport
      ? {
          contextReport: async (sessionId: SessionId) => {
            if (input.usesAcp(sessionId)) throw new Error("[ACP]: the agent manages this session's context")
            return base.contextReport!(sessionId)
          },
        }
      : {}),
    compact: async (compaction) => (input.usesAcp(compaction.sessionId) ? { status: "ok" } : base.compact(compaction)),
    ...(base.rewind ? { rewind: base.rewind.bind(base) } : {}),
    // Never starts the ACP engine: only one that already runs has processes to free.
    release(sessionId) {
      base.release?.(sessionId)
      void acp?.then((engine) => engine.release?.(sessionId), () => {})
    },
    ...(base.forget ? { forget: base.forget.bind(base) } : {}),
    ...(base.debugAgent ? { debugAgent: base.debugAgent.bind(base) } : {}),
    ...(base.catalogTools ? { catalogTools: base.catalogTools.bind(base) } : {}),
    // MendCode's tools lent to a Claude Code session (the host MCP bridge) come from the engine underneath.
    ...(base.hostTools ? { hostTools: base.hostTools.bind(base) } : {}),
    ...(base.hostCall ? { hostCall: base.hostCall.bind(base) } : {}),
  }
}
