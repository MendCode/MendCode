/**
 * How `./main` runs when another program hosts the daemon in its own process (the terminal's solo mode, docs/design/memory-single-process.md).
 * Set before importing `./main`; a daemon started as the `__daemon` process leaves it untouched and behaves as before: it reads
 * `process.argv`, prints its ready line, owns SIGINT/SIGTERM and exits when it is asked to shut down.
 */
export type Hosting = {
  active: boolean
  /** The daemon's flags (`--dir`, `--cwd`, `--engine`, ...) in place of `process.argv`. */
  argv?: string[]
  /** Where the daemon's own log lines go: a hosted process owns the terminal, so they must not reach stderr. */
  log?: (level: "info" | "warn" | "error", message: string) => void
  /** The daemon accepted `daemon.shutdown` and released everything it owned; the host decides what the process does next. */
  onStopped?: () => void
}

export const hosting: Hosting = { active: false }
