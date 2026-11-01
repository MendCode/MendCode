import { claudeEffort } from "@mendcode/engine-claude"
import type { AdvisorUsage } from "@mendcode/engine-native"
import { withoutHostSessionEnv } from "@mendcode/client/inherited-env"
import type { ModelChoice } from "@mendcode/protocol"
import { claudeAlias } from "./claude-models"

/**
 * A Claude Code model as the advisor of a native session (docs/advisor.md, "Claude as advisor"). Each consultation is one headless
 * `claude -p` run on the user's own Claude login: the bounded brief on stdin, no tools, no saved session, no hooks, no CLAUDE.md,
 * and the answer read from the JSON result. It never uses a credential of MendCode's.
 */

/** What the quota of these consultations is called, in the tool row and in `/advisor`. */
export const CLAUDE_ADVISOR_ACCOUNT = "Claude subscription"
export const CLAUDE_ADVISOR_TIMEOUT_MS = 90_000
const STDERR_TAIL = 400

/**
 * The child's environment: the daemon's own without a Claude Code shell's session variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`…,
 * the same list the launcher drops), without the three variables that would move the run off the Claude login onto an API key or
 * another endpoint, and with Claude Code's own switches for "no CLAUDE.md, no auto memory" (as a run-limited Claude session gets).
 */
export function claudeAdvisorEnvironment(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment = withoutHostSessionEnv(base)
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete environment[name]
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) if (value !== undefined) clean[name] = value
  return { ...clean, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
}

/** The arguments of one consultation; the brief goes on stdin, never in the arguments. */
export function claudeAdvisorArgs(input: { model: ModelChoice; system: string }): string[] {
  const alias = claudeAlias(input.model)
  const effort = claudeEffort(alias.effort)
  return [
    "-p", "--output-format", "json",
    "--model", alias.model,
    ...(effort ? ["--effort", effort] : []),
    // Nothing to call, nothing saved, and the user's own hooks (a notification when a run ends) are for their sessions, not for this.
    "--tools", "", "--no-session-persistence", "--disable-slash-commands",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--system-prompt", input.system,
  ]
}

type ClaudeResult = { type?: string; is_error?: boolean; result?: unknown; usage?: Record<string, unknown>; modelUsage?: Record<string, unknown> }

/** The `result` message of `--output-format json`: one object, or (newer versions) the list of the run's messages. */
function resultOf(stdout: string): ClaudeResult | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(stdout) } catch { return undefined }
  const candidates = Array.isArray(parsed) ? parsed : [parsed]
  return candidates.findLast((entry): entry is ClaudeResult => !!entry && typeof entry === "object" && (entry as ClaudeResult).type === "result")
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/**
 * One consultation. Resolves with the answer text and the tokens Claude Code reported; rejects when `claude` is missing, exits with
 * an error, answers an error, does not answer within `timeoutMs` or is cancelled. The caller (`createAdvisor`) turns a rejection into
 * a neutral verdict, so the turn goes on without the advice.
 */
export async function runClaudeAdvisor(input: { bin: string; cwd: string; system: string; prompt: string; model: ModelChoice; signal: AbortSignal; timeoutMs?: number; environment?: Record<string, string> }): Promise<{ text: string; usage?: AdvisorUsage; account: string }> {
  if (input.signal.aborted) throw new Error("[ADVISOR]: cancelled")
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([input.bin, ...claudeAdvisorArgs({ model: input.model, system: input.system })], { cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: input.environment ?? claudeAdvisorEnvironment() })
  } catch (error) {
    throw new Error(`[ADVISOR]: \`claude\` could not start (${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}); Claude Code must be installed and signed in`)
  }
  let stopped: "timeout" | "cancelled" | undefined
  const stop = (reason: "timeout" | "cancelled") => { stopped ??= reason; proc.kill() }
  const timer = setTimeout(() => stop("timeout"), Math.max(1, input.timeoutMs ?? CLAUDE_ADVISOR_TIMEOUT_MS))
  const cancel = () => stop("cancelled")
  input.signal.addEventListener("abort", cancel, { once: true })
  try {
    const stdin = proc.stdin as { write(data: string): unknown; end(): unknown }
    // A process that exits before it reads its input closes the pipe; the exit code then says why.
    try { stdin.write(input.prompt); stdin.end() } catch { /* reported through the exit */ }
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited])
    if (stopped === "timeout") throw new Error(`[ADVISOR]: Claude Code did not answer within ${Math.round((input.timeoutMs ?? CLAUDE_ADVISOR_TIMEOUT_MS) / 1000)} s`)
    if (stopped === "cancelled") throw new Error("[ADVISOR]: cancelled")
    const message = resultOf(stdout)
    if (code !== 0 && !message) throw new Error(`[ADVISOR]: Claude Code exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(-STDERR_TAIL)}` : ""}`)
    if (!message) throw new Error("[ADVISOR]: Claude Code printed no result")
    const text = typeof message.result === "string" ? message.result : ""
    if (message.is_error === true) throw new Error(`[ADVISOR]: Claude Code answered an error: ${text.slice(0, 200) || "no detail"}`)
    const raw = message.usage
    const model = Object.keys(message.modelUsage ?? {})[0] ?? claudeAlias(input.model).model
    return {
      text,
      account: CLAUDE_ADVISOR_ACCOUNT,
      ...(raw ? { usage: { provider: "claude", model, input: count(raw.input_tokens), output: count(raw.output_tokens), cacheRead: count(raw.cache_read_input_tokens), cacheWrite: count(raw.cache_creation_input_tokens) } } : {}),
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener("abort", cancel)
    proc.kill()
  }
}
