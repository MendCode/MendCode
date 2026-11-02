import { accessSync, constants, statSync } from "node:fs"
import { fileSignature } from "@mendcode/protocol/wire"

/** How often an open terminal looks at its own binary: one `stat`, nothing else. */
export const RELAUNCH_CHECK_MS = 20_000
/** The terminal is left alone for this long after the last key before it restarts into a new build. */
export const RELAUNCH_QUIET_MS = 10_000
/** Set for the process a terminal restarted into, so it can say once that it is the new build. */
export const RELAUNCHED_ENV = "MENDCODE_RELAUNCHED"

/** Launch options that describe the terminal or the daemon it uses and still hold for the same session reopened. The rest chose or started a session and are not repeated. */
const KEEP_VALUES = new Set(["--dir", "--data-dir", "--engine", "--config", "--add-dir", "--permission", "--tools", "--exclude-tools", "--system-prompt", "--append-system-prompt", "--process", "--log-level"])
const KEEP_FLAGS = new Set(["--dangerously-skip-permissions", "--offline", "--no-context-files", "--alt-screen", "--no-alt-screen", "--accessible", "--pure", "--safe-mode", "--print-logs", "--no-print-logs", "--strict-config", "--trace", "--no-trace", "--no-approve", "--no-tools", "--tui-control", "--diagnostics"])

/** What identifies the file at a path now. An install replaces the file, so one of these changes; undefined while it is missing or not runnable. */
export function binaryStamp(file: string): string | undefined {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size === 0) return undefined
    accessSync(file, constants.X_OK)
    return fileSignature(stat)
  } catch {
    return undefined
  }
}

/** The arguments that reopen the same session in the same terminal: the kept launch options, the project and the session. */
export function relaunchArgs(argv: readonly string[], target: { project: string; sessionId: string }): string[] {
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") break
    const name = token.split("=", 1)[0]!
    if (KEEP_FLAGS.has(name)) kept.push(token)
    else if (KEEP_VALUES.has(name)) {
      kept.push(token)
      if (!token.includes("=") && i + 1 < argv.length) kept.push(argv[++i]!)
    }
  }
  return [...kept, target.project, "--session", target.sessionId]
}

/** The daemon restarts itself in place with it too (packages/daemon/src/main.ts), so it lives beside the daemon. */
export { selfExec } from "@mendcode/client/self-exec"
