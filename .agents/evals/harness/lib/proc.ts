import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"

export type ProcessResult = { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; durationMs: number }

export type ProcessSpec = {
  command: readonly string[]
  cwd: string
  env: Record<string, string>
  stdin?: string
  /** Files that receive stdout and stderr; created or truncated. Omit to discard. */
  stdoutPath?: string
  stderrPath?: string
  timeoutMs: number
}

/** Runs one process in its own process group; on timeout the whole group gets SIGTERM, then SIGKILL after a grace period. */
export function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const out = spec.stdoutPath ? openSync(spec.stdoutPath, "w") : "ignore"
    const err = spec.stderrPath ? openSync(spec.stderrPath, "w") : "ignore"
    const [file, ...args] = spec.command
    const finish = (result: Omit<ProcessResult, "durationMs">) => {
      if (typeof out === "number") closeSync(out)
      if (typeof err === "number") closeSync(err)
      resolve({ ...result, durationMs: Date.now() - started })
    }
    const child = spawn(file!, args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: [spec.stdin === undefined ? "ignore" : "pipe", out, err] })
    let timedOut = false
    let settled = false
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, signal) } catch { /* already gone */ }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup("SIGTERM")
      setTimeout(() => killGroup("SIGKILL"), 5_000).unref()
    }, spec.timeoutMs)
    child.on("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish({ exitCode: null, signal: null, timedOut })
    })
    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Anything the harness left behind in its group (helpers, daemons it spawned) goes with it.
      killGroup("SIGKILL")
      finish({ exitCode: code, signal, timedOut })
    })
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {})
      child.stdin.end(spec.stdin)
    }
  })
}
