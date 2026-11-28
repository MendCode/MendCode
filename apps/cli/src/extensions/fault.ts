/**
 * Errors nobody caught that come from extension code: a rejected promise an extension started and never awaited,
 * or a throw inside one of its timers. The app's process-level handler asks here first; a live runtime that owns the
 * error's first stack frame disables that extension and the error never reaches the crash screen.
 */
export type ExtensionFaultSink = (error: unknown) => boolean

const sinks = new Set<ExtensionFaultSink>()

export function registerFaultSink(sink: ExtensionFaultSink) {
  sinks.add(sink)
  return () => void sinks.delete(sink)
}

/** True when an extension owned the error and it was handled. MendCode's own errors fall through (false). */
export function claimExtensionFault(error: unknown) {
  if (!sinks.size) return false
  for (const sink of sinks) if (sink(error)) return true
  return false
}

/** The file the error was thrown in: the first stack frame that names a path, without `file://`, line, column or `?query`. */
export function originFile(error: unknown) {
  const stack = error instanceof Error ? error.stack : undefined
  if (!stack) return undefined
  for (const row of stack.split("\n")) {
    const match = /^\s*at (?:.*? \()?(.*?)(?::\d+){0,2}\)?$/.exec(row)
    if (!match) continue
    const raw = match[1]!.replace(/^async /, "").replace(/^file:\/\//, "").replace(/\?[^:)]*$/, "")
    if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
      try { return decodeURIComponent(raw) } catch { return raw }
    }
  }
  return undefined
}
