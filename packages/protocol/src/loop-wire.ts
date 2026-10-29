/** Shared adaptive bounds without loading protocol schemas in the CLI. */
export function adaptiveBounds(trigger: { everyMs: number; minMs?: number | undefined; maxMs?: number | undefined }): { minMs: number; maxMs: number } {
  return { minMs: trigger.minMs ?? Math.max(60_000, Math.floor(trigger.everyMs / 4)), maxMs: trigger.maxMs ?? Math.min(30 * 86_400_000, trigger.everyMs * 8) }
}
