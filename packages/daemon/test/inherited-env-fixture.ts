import { expect } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"

/** What Claude Code 2.1.314 puts in the shell of one of its tool calls, with values that would be recognised if they leaked. */
export const CLAUDE_SHELL_ENV = {
  CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "leaked-session-id", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: "4242",
  CLAUDE_EFFORT: "high", CLAUDE_CODE_ENTRYPOINT: "sdk-cli", CLAUDE_CODE_EXECPATH: "/opt/claude/leaked", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/leaked.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "leaked-token", CLAUDE_CODE_SSE_PORT: "54321", AI_AGENT: "claude-code_2-1-314_agent", GIT_EDITOR: "true",
}
/** What a user exports on purpose for the engines: never dropped. */
export const USER_ENV = { ANTHROPIC_API_KEY: "sk-ant-test-kept", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/kept", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/tmp/kept-claude-config" }

/** A `claude` that records the names in its environment (and the two user values it must still get) when the daemon asks its status. */
export function fakeClaude(dir: string) {
  const bin = path.join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\nenv | sed 's/=.*//' > "${dir}/claude-env-names"\nprintf '%s\\n%s\\n' "$ANTHROPIC_API_KEY" "$ANTHROPIC_BASE_URL" > "${dir}/claude-env-kept"\necho '{"loggedIn":false}'\n`)
  chmodSync(bin, 0o755)
  return {
    bin,
    /** The daemon's environment for it: this `claude`, and a Codex that is not there (its status is asked too). */
    env: { MENDCODE_CLAUDE_BIN: bin, MENDCODE_CODEX_BIN: path.join(dir, "no-codex") },
    names: () => existsSync(path.join(dir, "claude-env-names")) ? readFileSync(path.join(dir, "claude-env-names"), "utf8").split("\n").filter(Boolean) : undefined,
    kept: () => readFileSync(path.join(dir, "claude-env-kept"), "utf8").split("\n").filter(Boolean),
  }
}

/** Asks the daemon for `daemon.info`, which runs `claude auth status --json` (a child started without an explicit environment), then stops it. */
export async function askHarnessesAndStop(target: { socketPath: string }) {
  const client = createClient({ socketPath: target.socketPath, name: "inherited-env-test", reconnect: false, timeoutMs: 10_000 })
  await client.connect()
  try {
    expect((await client.send({ type: "daemon.info" })).ok).toBe(true)
    await client.send({ type: "daemon.shutdown", force: true }).catch(() => undefined)
  } finally { client.close() }
}

/** The child saw none of the markers and every user setting, with the user's values. */
export function expectCleanChild(claude: ReturnType<typeof fakeClaude>) {
  const names = claude.names()!
  for (const name of Object.keys(CLAUDE_SHELL_ENV)) expect(names).not.toContain(name)
  expect(names).toEqual(expect.arrayContaining(Object.keys(USER_ENV)))
  expect(claude.kept()).toEqual([USER_ENV.ANTHROPIC_API_KEY, USER_ENV.ANTHROPIC_BASE_URL])
}
