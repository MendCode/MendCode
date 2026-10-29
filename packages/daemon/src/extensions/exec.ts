import { execFile } from "node:child_process"
import type { ExecResult } from "@mendcode/extension-api"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1024 * 1024

/** `api.exec`: one program, no shell, bounded in time and output; every failure is an answer, never a rejection. */
export function extensionExec(command: string, args: string[] = [], options: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  if (typeof command !== "string" || !command.trim()) return Promise.resolve({ stdout: "", stderr: "", code: null, error: "exec needs a program name" })
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return Promise.resolve({ stdout: "", stderr: "", code: null, error: "exec arguments are strings" })
  if (options.input !== undefined && typeof options.input !== "string") return Promise.resolve({ stdout: "", stderr: "", code: null, error: "exec input is a string" })
  const timeout = Math.min(Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)), MAX_TIMEOUT_MS)
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: options.cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, code: 0 })
      const exitCode = (error as NodeJS.ErrnoException & { code?: unknown }).code
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: typeof exitCode === "number" ? exitCode : null, ...(typeof exitCode === "number" ? {} : { error: error.message.slice(0, 500) }) })
    })
    // A program that exits before reading its input closes the pipe: that is its answer, not a failure of exec.
    child.stdin?.on("error", () => {})
    child.stdin?.end(options.input ?? "")
  })
}
