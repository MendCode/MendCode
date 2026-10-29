import type { EngineEnvironment } from "@mendcode/kernel"

/**
 * What an engine that runs its own tools (Claude Code, Codex, pi, ACP) gets of the session's `/env` credentials: every value in its
 * process environment and their names for its model. `engineEnvironment: false` keeps them to the native engine. MendCode masks a
 * value only in what its own tools print; these engines' output does not pass through it.
 */
export function engineEnvironment(input: { enabled: boolean; values(): Record<string, string> }): EngineEnvironment | undefined {
  if (!input.enabled) return undefined
  let values: Record<string, string>
  try {
    values = input.values()
  } catch {
    // An unreadable vault (lost key file) gives nothing, the same as for the native engine.
    return undefined
  }
  const names = Object.keys(values).sort()
  if (!names.length) return undefined
  return {
    values,
    note: `MendCode credentials (set by the user in /env) are in your shell's environment: ${names.join(", ")}. Use them directly when a task needs them (for example "$${names[0]}" in a command); do not ask the user for them, and never print, echo or write their values.`,
  }
}
