/**
 * The `process` setting: how many processes one terminal uses (docs/performance.md, docs/design/memory-single-process.md).
 * `daemon`: always a separate detached daemon, the two-process shape. `auto` (default, in every tier): a terminal that finds no daemon
 * hosts one in its own process and keeps it only while something needs it (less RAM; slower first frame); once another client
 * attaches and nothing is running, the daemon moves to a separate process, so a killed terminal takes no other session's turn
 * with it. `solo`: hosts it and keeps it there whoever attaches (an installed user service still owns startup).
 * Set with `--process`, `MENDCODE_PROCESS` or `processMode` in `<dataDir>/tui/profile.json`; the first one present wins.
 */
export const PROCESS_MODES = ["auto", "solo", "daemon"] as const
export type ProcessMode = (typeof PROCESS_MODES)[number]

export function resolveProcessMode(input: { flag?: string | undefined; env?: string | undefined; profile?: string | undefined }): ProcessMode {
  for (const value of [input.flag, input.env, input.profile]) {
    const found = PROCESS_MODES.find((mode) => mode === value)
    if (found) return found
  }
  return "auto"
}

/** Only an interactive local terminal on its own data directory hosts a daemon; remote attaches, explicit sockets and `--print-logs` keep the separate daemon. */
export function startsSolo(input: { mode: ProcessMode; interactive: boolean; remote: boolean; explicitSocket: boolean; printLogs: boolean }) {
  return input.mode !== "daemon" && input.interactive && !input.remote && !input.explicitSocket && !input.printLogs
}
