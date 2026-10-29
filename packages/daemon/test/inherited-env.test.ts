import { expect, test } from "bun:test"
import { dropHostSessionEnv } from "../src/inherited-env"

test("a daemon started from a Claude Code shell drops that session's markers and keeps the user's own settings", () => {
  const environment: NodeJS.ProcessEnv = { CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "abc", CLAUDE_PID: "42", CLAUDECODE: "1", ANTHROPIC_API_KEY: "kept", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", PATH: "/bin" }
  expect(dropHostSessionEnv(environment).sort()).toEqual(["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID"])
  expect(environment).toEqual({ ANTHROPIC_API_KEY: "kept", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", PATH: "/bin" })
})

test("an ordinary environment is left as it is", () => {
  const environment: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/u" }
  expect(dropHostSessionEnv(environment)).toEqual([])
  expect(environment).toEqual({ PATH: "/bin", HOME: "/home/u" })
})
