/**
 * Variables Claude Code sets in the shells of its own tool calls. A daemon started from such a shell (an agent ran
 * `mendcode daemon restart`) would hand them to every command and program its sessions start, and a Claude Code opened
 * anywhere below would take itself for that session's child: `CLAUDE_CODE_CHILD_SESSION` turns its transcript saving off.
 * Settings a user exports on purpose (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, cache lifetimes…) are not in the list.
 */
export const HOST_SESSION_ENV = [
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
] as const

/** Removes them from `environment` in place; returns the names that were set. */
export function dropHostSessionEnv(environment: NodeJS.ProcessEnv): string[] {
  const dropped: string[] = []
  for (const name of HOST_SESSION_ENV) {
    if (environment[name] === undefined) continue
    delete environment[name]
    dropped.push(name)
  }
  return dropped
}
