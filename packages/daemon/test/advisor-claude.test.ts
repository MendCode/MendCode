import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CLAUDE_ADVISOR_ACCOUNT, claudeAdvisorArgs, claudeAdvisorEnvironment, runClaudeAdvisor } from "../src/advisor-claude"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A `claude` stand-in: records its arguments, environment and stdin next to itself, then prints `output` (or runs `body`). */
function fakeClaude(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-advisor-claude-"))
  dirs.push(dir)
  const bin = path.join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nenv > "${dir}/env"\ncat > "${dir}/stdin"\n${body}\n`)
  chmodSync(bin, 0o755)
  return { dir, bin, read: (name: string) => readFileSync(path.join(dir, name), "utf8") }
}

const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"verdict":"proceed","summary":"fine"}', usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 500, cache_creation_input_tokens: 7 }, modelUsage: { "claude-opus-5-5": {} } })
const request = (bin: string, extra: Partial<Parameters<typeof runClaudeAdvisor>[0]> = {}) => ({ bin, cwd: tmpdir(), system: "SYSTEM", prompt: "the brief\nwith lines", model: { model: "claude-opus", effort: "high" as const }, signal: new AbortController().signal, ...extra })

test("the brief goes on stdin, the call has no tools, no session and no hooks, and the tokens come from the result", async () => {
  const claude = fakeClaude(`printf '%s' '${RESULT}'`)
  const answer = await runClaudeAdvisor(request(claude.bin, { environment: { PATH: process.env.PATH ?? "" } }))
  expect(answer).toEqual({ text: '{"verdict":"proceed","summary":"fine"}', account: CLAUDE_ADVISOR_ACCOUNT, usage: { provider: "claude", model: "claude-opus-5-5", input: 120, output: 30, cacheRead: 500, cacheWrite: 7 } })
  expect(claude.read("stdin")).toBe("the brief\nwith lines")
  const args = claude.read("args").split("\n")
  expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--model", "opus", "--effort", "high", "--tools", "", "--no-session-persistence", "--disable-slash-commands", "--system-prompt", "SYSTEM"]))
  expect(args.join("\n")).not.toContain("the brief")
  expect(args).toContain(JSON.stringify({ disableAllHooks: true }))
})

test("the environment drops a Claude Code shell's session variables and the credentials that would leave the Claude login, and keeps the rest", () => {
  const environment = claudeAdvisorEnvironment({ PATH: "/bin", HOME: "/home/u", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://x", CLAUDE_CONFIG_DIR: "/cfg" })
  expect(environment).toEqual({ PATH: "/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })
})

test("the default environment reaches the process clean", async () => {
  const claude = fakeClaude(`printf '%s' '${RESULT}'`)
  const before = { ...process.env }
  process.env.CLAUDECODE = "1"
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real"
  try { await runClaudeAdvisor(request(claude.bin)) } finally { for (const name of ["CLAUDECODE", "ANTHROPIC_API_KEY"]) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name] } }
  const env = claude.read("env")
  expect(env).not.toContain("CLAUDECODE=")
  expect(env).not.toContain("ANTHROPIC_API_KEY=")
  expect(env).toContain("CLAUDE_CODE_DISABLE_CLAUDE_MDS=1")
})

test("an effort Claude Code names differently and a model without one still make valid arguments", () => {
  expect(claudeAdvisorArgs({ model: { model: "claude-sonnet", effort: "minimal" }, system: "s" })).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "low"]))
  expect(claudeAdvisorArgs({ model: { model: "claude-opus" }, system: "s" })).not.toContain("--effort")
})

test("a list of messages (newer claude) is read for its result; an error result, a bad exit and unreadable output reject", async () => {
  const listed = fakeClaude(`printf '%s' '[{"type":"system"},${RESULT}]'`)
  expect((await runClaudeAdvisor(request(listed.bin))).text).toContain("proceed")
  const errored = fakeClaude(`printf '%s' '{"type":"result","is_error":true,"result":"Not logged in"}'`)
  await expect(runClaudeAdvisor(request(errored.bin))).rejects.toThrow("answered an error: Not logged in")
  const crashed = fakeClaude("echo 'boom' >&2; exit 3")
  await expect(runClaudeAdvisor(request(crashed.bin))).rejects.toThrow("exited with 3: boom")
  const noise = fakeClaude("echo not json")
  await expect(runClaudeAdvisor(request(noise.bin))).rejects.toThrow("printed no result")
})

test("a missing claude is a clear error, and a hung one is killed at the timeout and by cancellation", async () => {
  await expect(runClaudeAdvisor(request("/nonexistent/claude"))).rejects.toThrow("could not start")
  const hung = fakeClaude("exec sleep 30")
  const started = Date.now()
  await expect(runClaudeAdvisor(request(hung.bin, { timeoutMs: 200 }))).rejects.toThrow("did not answer within")
  expect(Date.now() - started).toBeLessThan(5_000)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  await expect(runClaudeAdvisor(request(hung.bin, { signal: controller.signal }))).rejects.toThrow("cancelled")
  await expect(runClaudeAdvisor(request(hung.bin, { signal: controller.signal }))).rejects.toThrow("cancelled")
})
