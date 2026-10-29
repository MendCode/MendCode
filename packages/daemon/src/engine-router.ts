import type { ModelChoice, SessionId } from "@mendcode/protocol"
import type { EnginePort } from "@mendcode/kernel"

/**
 * One engine port that sends each session to the engine of its model: the daemon's own engine, or Claude Code for a
 * session whose model is a Claude Code model. The choice is read at every turn, so switching models in /model
 * moves the next turn, and a per-turn model override (`session send --model`) routes that turn alone. Claude Code is
 * created on its first turn (P5). Shell commands always run on the primary.
 */
export function createEngineRouter(input: { primary: EnginePort; claude: () => Promise<EnginePort>; usesClaude(sessionId: SessionId, override?: ModelChoice): boolean }): EnginePort {
  const { primary } = input
  let claude: Promise<EnginePort> | undefined
  const claudeEngine = () => (claude ??= input.claude().catch((error: unknown) => {
    claude = undefined
    throw error
  }))
  return {
    async runTurn(turn) {
      if (!input.usesClaude(turn.sessionId, turn.selection?.model)) return primary.runTurn(turn)
      const engine = await claudeEngine().catch((error: unknown) => error as Error)
      if (engine instanceof Error) return { status: "error", code: "claude_unavailable", message: `[CLAUDE]: ${engine.message}` }
      return engine.runTurn(turn)
    },
    ...(primary.runShell ? { runShell: primary.runShell.bind(primary) } : {}),
    needsCompaction: (sessionId) => !input.usesClaude(sessionId) && primary.needsCompaction(sessionId),
    ...(primary.contextReport
      ? {
          contextReport: async (sessionId: SessionId) => {
            if (input.usesClaude(sessionId)) throw new Error("[CLAUDE]: Claude Code manages this session's context; /context in Claude Code shows it")
            return primary.contextReport!(sessionId)
          },
        }
      : {}),
    compact: async (compaction) => {
      if (!input.usesClaude(compaction.sessionId, compaction.selection?.model)) return primary.compact(compaction)
      const engine = await claudeEngine().catch((error: unknown) => error as Error)
      if (engine instanceof Error) return { status: "error", code: "claude_unavailable", message: `[CLAUDE]: ${engine.message}` }
      return engine.compact(compaction)
    },
    // A conversation Claude Code keeps is cut there; the native engine's history is MendCode's own (the undo already cut it).
    rewind: async (rewind) => {
      if (!claude && !input.usesClaude(rewind.sessionId)) return false
      const engine = await claudeEngine().catch(() => undefined)
      return (await engine?.rewind?.(rewind)) ?? false
    },
    ...(primary.release ? { release: primary.release.bind(primary) } : {}),
    ...(primary.forget ? { forget: primary.forget.bind(primary) } : {}),
    ...(primary.debugAgent ? { debugAgent: primary.debugAgent.bind(primary) } : {}),
    ...(primary.catalogTools ? { catalogTools: primary.catalogTools.bind(primary) } : {}),
    ...(primary.hostTools ? { hostTools: primary.hostTools.bind(primary) } : {}),
    ...(primary.hostCall ? { hostCall: primary.hostCall.bind(primary) } : {}),
  }
}
