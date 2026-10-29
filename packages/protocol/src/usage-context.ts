/** The counts of one `usage.recorded` event that say how full the context is. Zod-free: thin clients import it from the wire entry. */
export type UsageContextInput = { provider: string; input: number; output: number; cacheRead: number; cacheWrite: number; context?: number | undefined }

/**
 * Tokens the conversation occupies after a model call, or undefined when the event cannot say. An engine that knows
 * sets `context`. Otherwise one event is one model call, whose prompt (`input` + cache read and write) and answer are
 * the context. The Claude Code engine reports one event per turn that sums every call and sub-agent, so without
 * `context` (sessions recorded before it was reported) its counts say nothing about the context.
 */
export function usageContext(event: UsageContextInput): number | undefined {
  if (event.context !== undefined) return event.context
  if (event.provider === "claude") return undefined
  return event.input + event.cacheRead + event.cacheWrite + event.output
}
