const LIVE_SHELL_OUTPUT_PREVIEW_LIMIT = 30_000

function clampLiveShellOutput(output: string) {
  if (output.length <= LIVE_SHELL_OUTPUT_PREVIEW_LIMIT) return output
  return "...\n\n" + output.slice(-LIVE_SHELL_OUTPUT_PREVIEW_LIMIT)
}

function replayCandidate(text: string) {
  return text.length >= 4
}

function overlapLength(current: string, delta: string) {
  const max = Math.min(current.length, delta.length)
  for (let size = max; size > 0; size--) {
    if (!replayCandidate(delta.slice(0, size))) continue
    if (current.endsWith(delta.slice(0, size))) return size
  }
  return 0
}

export function appendLiveShellOutput(current: unknown, delta: string) {
  const existing = String(current ?? "")
  if (!delta) return clampLiveShellOutput(existing)
  if (!existing) return clampLiveShellOutput(delta)

  if (replayCandidate(delta) && existing.endsWith(delta)) return clampLiveShellOutput(existing)
  if (replayCandidate(existing) && delta.startsWith(existing)) return clampLiveShellOutput(delta)

  const overlap = overlapLength(existing, delta)
  if (overlap > 0) return clampLiveShellOutput(existing + delta.slice(overlap))

  return clampLiveShellOutput(existing + delta)
}
