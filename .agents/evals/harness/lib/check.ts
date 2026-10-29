import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { cleanEnv } from "./env"
import { runProcess } from "./proc"
import type { CheckResult, Task } from "./types"
import { makeTempDir, removeKitTree } from "./workspace"

const LOG_TAIL_BYTES = 6_000

/**
 * Runs the task's `check.sh` from outside the agent's directory. The script, its assets and a pristine copy of the
 * starting repo are copied fresh into a private directory first, so nothing the agent did can change the checker.
 * Env contract: WORK (the agent's final tree), CHECK_DIR (task `check/`), PRISTINE (starting repo), SCRATCH (empty dir).
 */
export async function runCheck(task: Task, workDir: string, options: { logPath?: string; timeoutMs?: number } = {}): Promise<CheckResult> {
  const checkerRoot = makeTempDir("chk")
  const scratch = makeTempDir("scr")
  try {
    cpSync(task.checkScript, path.join(checkerRoot, "check.sh"))
    if (existsSync(task.checkDir)) cpSync(task.checkDir, path.join(checkerRoot, "check"), { recursive: true })
    else mkdirSync(path.join(checkerRoot, "check"))
    cpSync(task.repoDir, path.join(checkerRoot, "pristine"), { recursive: true })
    const logPath = options.logPath ?? path.join(checkerRoot, "check.log")
    const result = await runProcess({
      command: ["bash", path.join(checkerRoot, "check.sh")],
      cwd: scratch,
      env: cleanEnv({
        HOME: process.env.HOME ?? scratch,
        WORK: workDir,
        CHECK_DIR: path.join(checkerRoot, "check"),
        PRISTINE: path.join(checkerRoot, "pristine"),
        SCRATCH: scratch,
      }),
      stdoutPath: logPath,
      stderrPath: `${logPath}.err`,
      timeoutMs: options.timeoutMs ?? 180_000,
    })
    const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
    const logTail = `${read(logPath)}${read(`${logPath}.err`)}`.slice(-LOG_TAIL_BYTES)
    return { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, logTail }
  } finally {
    removeKitTree(checkerRoot)
    removeKitTree(scratch)
  }
}
