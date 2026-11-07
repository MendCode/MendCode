import type { LoopGate } from "@mendcode/protocol"

/** Shell features a check may not use: the host runs checks as one plain program with arguments, never through a shell. */
const FORBIDDEN = /[;&|<>`$\n\r\\]/

/**
 * A check command as argv, or why it is refused. Quotes group words ("a b" or 'a b'); anything that
 * would need a shell (chaining, pipes, redirection, substitution, escapes) is refused.
 */
export function parseCheck(command: string): { argv: string[] } | { error: string } {
  const text = command.trim()
  if (!text) return { error: "empty check" }
  if (FORBIDDEN.test(text)) return { error: `check "${text.slice(0, 80)}" uses shell syntax (; & | < > \` $ \\); use one plain command` }
  const argv: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ""
    } else if (/\s/.test(char)) {
      if (word !== undefined) argv.push(word)
      word = undefined
    } else word = (word ?? "") + char
  }
  if (quote) return { error: `check "${text.slice(0, 80)}" has an unclosed quote` }
  if (word !== undefined) argv.push(word)
  return { argv }
}

/** Every problem in a list of checks (empty when all can run). */
export function checkProblems(checks: readonly string[]): string[] {
  return checks.flatMap((check) => {
    const parsed = parseCheck(check)
    return "error" in parsed ? [parsed.error] : []
  })
}

/**
 * `timeoutSeconds` bounds the run (the runner picks its own default when absent); a runner that times a check out kills it and says so in `output`.
 * `stdin` is written to the command's stdin, which is then closed; without it stdin is ignored.
 * `fullOutput: true` (only a workflow script's `check()` asks for it) keeps the start of the output too, up to
 * FULL_OUTPUT_BYTES: `full` holds it, past that size by at most one chunk when there was more (the caller cuts it).
 * `fullTruncated` is true only when the runner discarded decoded output from `full`.
 * Without it the runner keeps only its usual tail in `output`.
 */
export type CheckRunner = (input: { argv: string[]; cwd: string; signal: AbortSignal; timeoutSeconds?: number; stdin?: string; fullOutput?: boolean }) => Promise<{ exitCode: number; output: string; full?: string; fullTruncated?: boolean }>

/** How much of a check's output (UTF-8 bytes, from its start) `fullOutput` keeps. */
export const FULL_OUTPUT_BYTES = 1_048_576

const DETAIL_CHARS = 1_500

/**
 * Runs checks in order; every check runs even after a failure, so the next run sees all of them.
 * `timeouts[i]` is the timeout in seconds of `checks[i]` (none = the runner's default).
 */
export async function runChecks(input: { checks: readonly string[]; cwd: string; signal: AbortSignal; run: CheckRunner; timeouts?: readonly (number | undefined)[]; keepOutput?: boolean; stdin?: string }): Promise<LoopGate[]> {
  const gates: LoopGate[] = []
  for (const [index, check] of input.checks.entries()) {
    if (input.signal.aborted) break
    const timeoutSeconds = input.timeouts?.[index]
    const parsed = parseCheck(check)
    if ("error" in parsed) {
      gates.push({ id: check, status: "fail", detail: parsed.error })
      continue
    }
    const result = await input.run({ argv: parsed.argv, cwd: input.cwd, signal: input.signal, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }), ...(input.stdin === undefined ? {} : { stdin: input.stdin }) }).catch((error: unknown) => ({ exitCode: -1, output: error instanceof Error ? error.message : String(error) }))
    const tail = result.output.replace(/\s+$/, "").slice(-DETAIL_CHARS)
    gates.push({ id: check, status: result.exitCode === 0 ? "pass" : "fail", ...(result.exitCode === 0 && !input.keepOutput ? {} : { detail: `exit ${result.exitCode}${tail ? `\n${tail}` : ""}` }) })
  }
  return gates
}
