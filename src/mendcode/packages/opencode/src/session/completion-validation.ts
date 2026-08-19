import { Effect } from "effect"

import { errorMessage } from "@/util/error"

const validationCommandPatterns = [
  /^git\s+diff\s+--check(?:\s|$)/i,
  /^bun\s+(?:test|typecheck|run\s+(?:test|typecheck|lint|check|build))(?:\s|$)/i,
  /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|check|build))(?:\s|$)/i,
  /^deno\s+(?:test|lint|check)(?:\s|$)/i,
  /^(?:pytest|python(?:3)?\s+-m\s+pytest)(?:\s|$)/i,
  /^go\s+test(?:\s|$)/i,
  /^cargo\s+(?:test|check|clippy)(?:\s|$)/i,
  /^make\s+(?:test|check|lint|build)(?:\s|$)/i,
]

const maxValidationOutputBytes = 128 * 1024

const validationCommandArgs = (command: string) => {
  const value = command.trim()
  if (!value || /[;&|><`$\\\r\n\0]/.test(value)) return
  if (!validationCommandPatterns.some((pattern) => pattern.test(value))) return
  const args = value.split(/\s+/)
  if (
    args[0] === "git" &&
    args[1] === "diff" &&
    args[2] === "--check" &&
    args.slice(3).some((argument) => argument.startsWith("-") && argument !== "--" && argument !== "--cached" && argument !== "--staged")
  ) return
  return args
}

export const completionValidationCommandAllowed = (command: string) => Boolean(validationCommandArgs(command))

export type CompletionValidationResult = {
  readonly status: "pass" | "fail" | "blocked"
  readonly summary: string
  readonly output: string
  readonly exitCode?: number
  readonly durationMs: number
  readonly timedOut: boolean
  readonly failureClass: "none" | "quality" | "policy" | "environment"
}

const readValidationOutput = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  let kept = new Uint8Array(0)
  let truncated = false
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (!chunk.value.byteLength) continue
    if (chunk.value.byteLength >= maxValidationOutputBytes) {
      kept = chunk.value.slice(-maxValidationOutputBytes)
      truncated = true
      continue
    }
    const overflow = kept.byteLength + chunk.value.byteLength - maxValidationOutputBytes
    if (overflow > 0) {
      kept = kept.slice(overflow)
      truncated = true
    }
    const combined = new Uint8Array(kept.byteLength + chunk.value.byteLength)
    combined.set(kept)
    combined.set(chunk.value, kept.byteLength)
    kept = combined
  }
  const output = new TextDecoder().decode(kept)
  return truncated ? `[validation output truncated to last ${maxValidationOutputBytes} bytes]\n${output}` : output
}

const validationEnvironment = () => {
  const inherited = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "COMSPEC",
  ]
  return {
    ...Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    CI: process.env.CI ?? "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }
}

export const runCompletionValidationCommand = (
  command: string,
  cwd: string,
  timeoutMs: number,
  executionAllowed: boolean,
): Effect.Effect<CompletionValidationResult> => {
  const args = validationCommandArgs(command)
  if (!args) {
    return Effect.succeed({
      status: "blocked" as const,
      summary: "Validation command is outside the read-only validation allowlist.",
      output: `Blocked command: ${command}`,
      durationMs: 0,
      timedOut: false,
      failureClass: "policy" as const,
    })
  }
  if (!executionAllowed) {
    return Effect.succeed({
      status: "blocked" as const,
      summary: "Executable validation is disabled by the workflow's report-only/read-only contract.",
      output: `Blocked in report-only mode: ${command}`,
      durationMs: 0,
      timedOut: false,
      failureClass: "policy" as const,
    })
  }
  return Effect.tryPromise({
    try: async () => {
      const started = Date.now()
      const child = Bun.spawn(args, {
        cwd,
        env: validationEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          readValidationOutput(child.stdout),
          readValidationOutput(child.stderr),
        ])
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
        if (timedOut) {
          return {
            status: "blocked" as const,
            summary: `Validation timed out after ${timeoutMs}ms: ${command}`,
            output,
            exitCode,
            durationMs: Date.now() - started,
            timedOut: true,
            failureClass: "environment" as const,
          }
        }
        return {
          status: exitCode === 0 ? "pass" as const : "fail" as const,
          summary: exitCode === 0 ? `Validation passed: ${command}` : `Validation failed with exit ${exitCode}: ${command}`,
          output,
          exitCode,
          durationMs: Date.now() - started,
          timedOut: false,
          failureClass: exitCode === 0 ? "none" as const : "quality" as const,
        }
      } finally {
        clearTimeout(timer)
      }
    },
    catch: (error) => errorMessage(error),
  }).pipe(
    Effect.catch((error) => Effect.succeed({
      status: "blocked" as const,
      summary: `Validation could not run: ${command}`,
      output: error,
      durationMs: 0,
      timedOut: false,
      failureClass: "environment" as const,
    })),
  )
}
