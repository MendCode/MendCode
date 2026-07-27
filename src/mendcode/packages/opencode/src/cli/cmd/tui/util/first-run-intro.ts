export const FIRST_RUN_INTRO_SEEN_KEY = "mendcode_intro_seen"
export const FIRST_RUN_INTRO_TOTAL_MS = 2140
export const FIRST_RUN_INTRO_STATIC_MS = 80

export type FirstRunIntroPhase = "signal" | "mascot" | "mend" | "identity" | "handoff"
export type FirstRunIntroLayout = "full" | "compact" | "plain"

export function shouldShowFirstRunIntro(input: {
  interactive: boolean
  setupComplete: boolean
  dismissed: boolean
  seen: boolean
  force?: boolean
}) {
  if (!input.interactive) return false
  if (input.force) return true
  return !input.setupComplete && !input.dismissed && !input.seen
}

export function firstRunIntroPhaseAt(elapsedMs: number): FirstRunIntroPhase {
  const elapsed = Math.max(0, elapsedMs)
  if (elapsed >= 1780) return "handoff"
  if (elapsed >= 1450) return "identity"
  if (elapsed >= 650) return "mend"
  if (elapsed >= 220) return "mascot"
  return "signal"
}

export function firstRunIntroWordmarkProgress(elapsedMs: number) {
  const start = 640
  const end = 1450
  if (elapsedMs <= start) return 0
  if (elapsedMs >= end) return 1
  const progress = (elapsedMs - start) / (end - start)
  return progress * progress * (3 - 2 * progress)
}

export function firstRunIntroLayout(input: { width: number; height: number }): FirstRunIntroLayout {
  const width = Math.max(0, Math.floor(input.width))
  const height = Math.max(0, Math.floor(input.height))
  if (width < 36 || height < 10) return "plain"
  if (width < 64 || height < 18) return "compact"
  return "full"
}
