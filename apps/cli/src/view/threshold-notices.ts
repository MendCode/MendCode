import type { GlobalEvent } from "@mendcode/protocol"

type Quota = Extract<GlobalEvent, { type: "quota.snapshot" }>

export type ThresholdNotice = { text: string; tone: "info" | "warning" | "error" }

/** Share of a usage window at which each notice fires, lowest first. The last is the limit itself. */
export const QUOTA_LEVELS = [75, 90, 100] as const

const levelOf = (percent: number, levels: readonly number[]) => levels.reduce((level, at, index) => (percent >= at ? index + 1 : level), 0)

function resetText(resetsAt: number | undefined, now: number) {
  if (!resetsAt || resetsAt <= now) return ""
  const minutes = Math.max(1, Math.round((resetsAt - now) / 60_000))
  if (minutes >= 2_880) return ` · resets in ${Math.round(minutes / 1_440)}d`
  if (minutes >= 60) return ` · resets in ${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
  return ` · resets in ${minutes}m`
}

/**
 * Threshold notices for the quota windows, each announced once per crossing: a window that drops back (it reset) is armed
 * again. The text carries what the user can do about it; nothing here acts. The context has its own line in the transcript
 * (the notice before a compaction, usage-notes.ts).
 */
export function createThresholds() {
  const quotaLevel = new Map<string, number>()

  return {
    /** Notices for a quota snapshot: 75 %, 90 % and the limit being reached (a `rejected` status counts as reached). */
    quota(event: Quota, now: number): ThresholdNotice[] {
      const notices: ThresholdNotice[] = []
      const seen = new Set<string>()
      for (const window of event.windows) {
        const key = `${event.provider}:${window.id}`
        seen.add(key)
        const reached = window.usedPercent >= 100 || (event.status === "rejected" && window.usedPercent >= QUOTA_LEVELS[1])
        const level = reached ? QUOTA_LEVELS.length : levelOf(window.usedPercent, QUOTA_LEVELS)
        const known = quotaLevel.get(key) ?? 0
        quotaLevel.set(key, level)
        if (level <= known) continue
        const name = `${event.provider} ${window.label}`
        if (level === QUOTA_LEVELS.length) notices.push({ tone: "error", text: `${name} limit reached${resetText(window.resetsAt, now)} · /model to switch · /usage for details` })
        else notices.push({ tone: level === 2 ? "warning" : "info", text: `${name} ${Math.round(window.usedPercent)}% used${resetText(window.resetsAt, now)}` })
      }
      // A provider's window that no longer appears is forgotten, so it announces again if it comes back.
      for (const key of quotaLevel.keys()) if (key.startsWith(`${event.provider}:`) && !seen.has(key)) quotaLevel.delete(key)
      return notices
    },
  }
}
export type Thresholds = ReturnType<typeof createThresholds>
