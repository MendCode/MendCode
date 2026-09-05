export const updatePhases = ["checking", "downloading", "verifying", "activating", "activated"] as const
export type UpdatePhase = (typeof updatePhases)[number]
export type DownloadProgress = { bytes: number; total?: number }
export type UpdateObserver = (phase: UpdatePhase, progress?: DownloadProgress) => void

export function updateLabel(phase: UpdatePhase, progress?: DownloadProgress) {
  if (progress && phase === "downloading") {
    const received = `${(progress.bytes / 1024 / 1024).toFixed(1)} MiB`
    return progress.total ? `Downloading · ${received} / ${(progress.total / 1024 / 1024).toFixed(1)} MiB (${Math.floor(progress.bytes * 100 / progress.total)}%)`
      : `Downloading · ${received}`
  }
  return phase === "activated" ? "Checking installed version" : `${phase[0].toUpperCase()}${phase.slice(1)}`
}

export function updateProgress(observer?: UpdateObserver) {
  let pending = ""
  let previous: UpdatePhase | undefined
  let previousBytes = -1
  return (chunk: string) => {
    const lines = (pending + chunk).split("\n")
    pending = (lines.pop() ?? "").slice(-1024)
    for (const line of lines) {
      const download = /^MENDCODE_UPDATE_BYTES=(\d+)\/(\d*)$/.exec(line.trim())
      if (download && previous === "downloading") {
        const bytes = Number(download[1])
        const total = download[2] ? Number(download[2]) : undefined
        if (!Number.isSafeInteger(bytes) || bytes < previousBytes || bytes === previousBytes ||
          (total !== undefined && (!Number.isSafeInteger(total) || total < bytes || total <= 0))) continue
        previousBytes = bytes
        try { observer?.("downloading", { bytes, total }) } catch {}
        continue
      }
      if (!line.startsWith("MENDCODE_UPDATE_PHASE=")) continue
      const phase = line.slice("MENDCODE_UPDATE_PHASE=".length).trim()
      if (!updatePhases.includes(phase as UpdatePhase) || phase === previous) continue
      previous = phase as UpdatePhase
      // An observer cannot interrupt installation halfway through activation.
      try { observer?.(previous) } catch {}
    }
  }
}
