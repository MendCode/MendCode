import { claudeProfileDir } from "./harness-status"

/**
 * `mendcode claude login|status` (docs/setup.md#own-logins): Claude Code's official sign-in, run with MendCode's own profile
 * (`CLAUDE_CONFIG_DIR=<data dir>/claude-code`), so the setup can name one short command instead of a long path. The user's
 * `~/.claude` and its login are not touched; MendCode reads nothing of the sign-in, Claude Code keeps it.
 */
export function parseClaudeProfile(argv: readonly string[]): { action: "login" | "status"; dir?: string } | undefined {
  const action = argv[1]
  if (argv[0] !== "claude" || (action !== "login" && action !== "status")) return undefined
  const at = argv.indexOf("--dir")
  return { action, ...(at >= 0 && argv[at + 1] ? { dir: argv[at + 1]! } : {}) }
}

export async function runClaudeProfile(input: { action: "login" | "status"; dataDir: string; bin: string; err: { write(text: string): void } }): Promise<number> {
  const profile = claudeProfileDir(input.dataDir)
  if (input.action === "login") input.err.write(`Signing Claude Code in for MendCode (profile ${profile}); your own ~/.claude login is not touched.\n`)
  try {
    const child = Bun.spawn([input.bin, "auth", input.action, ...(input.action === "status" ? ["--text"] : [])], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, CLAUDE_CONFIG_DIR: profile } })
    return await child.exited
  } catch {
    input.err.write("error: Claude Code is not installed (claude.com/claude-code)\n")
    return 127
  }
}
