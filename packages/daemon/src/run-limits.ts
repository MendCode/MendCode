import type { SessionId } from "@mendcode/protocol"

/** Scripted-run limits of one session (`session.run.configure`); every field only narrows what the session may do. */
export type RunLimits = {
  maxSteps?: number
  tools?: readonly string[]
  excludeTools?: readonly string[]
  offline?: boolean
  /** `--no-context-files`: AGENTS.md, CLAUDE.md and the other instruction files stay out of this session's system prompt. */
  noContextFiles?: boolean
  /** Extra workspace directories for this session (`--add-dir`); the only field that widens access. */
  addDirs?: readonly string[]
  systemPrompt?: string
  appendSystemPrompt?: string
  /** An extension's `setActiveTools`: only these names (or patterns) stay offered, on top of every other limit. */
  activeTools?: readonly string[]
}

type Patch = { [K in keyof RunLimits]?: RunLimits[K] | null | undefined }

/** In-memory store shared by the command handler and the engine: nothing here survives the daemon or the session. */
export function createRunLimitsStore() {
  const limits = new Map<SessionId, RunLimits>()
  return {
    get: (sessionId: SessionId): RunLimits | undefined => limits.get(sessionId),
    configure(sessionId: SessionId, patch: Patch): RunLimits {
      const next: Record<string, unknown> = { ...limits.get(sessionId) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (value === null) delete next[key]
        else next[key] = value
      }
      if (Object.keys(next).length) limits.set(sessionId, next as RunLimits)
      else limits.delete(sessionId)
      return next as RunLimits
    },
    delete: (sessionId: SessionId) => void limits.delete(sessionId),
  }
}

export type RunLimitsStore = ReturnType<typeof createRunLimitsStore>

/** The project prompt with the run's replacement or addition applied; unchanged without limits. */
export function systemWithLimits(system: string, limits: RunLimits | undefined) {
  if (!limits) return system
  const base = limits.systemPrompt ?? system
  return limits.appendSystemPrompt ? `${base}\n\n${limits.appendSystemPrompt}` : base
}
