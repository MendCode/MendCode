import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { ModelChoice, SessionId } from "@mendcode/protocol"

/** Codex catalog entries are explicitly opted in. Each turn owns its process; bindings preserve the conversation. */
export function withCodexEngine(input: {
  base: EnginePort
  usesCodex(sessionId: SessionId, override?: ModelChoice): boolean
  create(turn: TurnInput): Promise<EnginePort & { stop(): void }>
}): EnginePort {
  return {
    ...input.base,
    async runTurn(turn) {
      if (!input.usesCodex(turn.sessionId, turn.selection?.model)) return input.base.runTurn(turn)
      const engine = await input.create(turn)
      try { return await engine.runTurn(turn) }
      finally { engine.stop() }
    },
    needsCompaction: (id) => !input.usesCodex(id) && input.base.needsCompaction(id),
    compact: (turn) => input.usesCodex(turn.sessionId, turn.selection?.model) ? Promise.resolve({ status: "ok" }) : input.base.compact(turn),
    ...(input.base.contextReport ? { contextReport: async (id: SessionId) => {
      if (input.usesCodex(id)) throw new Error("[CODEX]: Codex manages this session's context")
      return input.base.contextReport!(id)
    } } : {}),
  }
}
