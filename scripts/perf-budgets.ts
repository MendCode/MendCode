export type FrameStats = { samples: number; p50: number; p95: number; max: number }
export type PerfResult = {
  messages: number
  daemon: { rssIdleMB: number; rssWithClientMB: number; readyMs: number }
  startupMs: { import: number; firstFrame: number }
  rssMB: { boot: number; imported: number; idle: number; scrolledUp: number; afterStream: number }
  heapMB: { idle: number; scrolledUp: number; afterStream: number }
  frameMs: { idle: FrameStats; scrollUp: FrameStats; scrollDown: FrameStats; stream: FrameStats }
  screenBytes: number
}

/** The same scenario with the terminal hosting its own daemon (solo mode): one process, so one RSS series, and the time the in-process daemon took to be ready. */
export type SoloPerfResult = Omit<PerfResult, "daemon" | "startupMs" | "rssMB"> & {
  startupMs: { import: number; firstFrame: number; hosted: number }
  rssMB: { boot: number; imported: number; hosted: number; idle: number; scrolledUp: number; afterStream: number }
}

/**
 * Regression budgets for the compiled binary on the faux engine (docs/performance.md). Each is the measured value
 * (Apple silicon, Bun 1.3, several runs, 2026-10, after RAM round 2) plus headroom for a busy machine: RSS about 1.25x,
 * frame times 4x (the real limit is one 60 fps frame, 16.7 ms; a frame that runs the client's periodic collection takes
 * about 2 ms, so the idle and scroll p95 now sit near that), start-up 4x. A budget that fails is a regression to fix or,
 * when the cost is deliberate, a number to raise in the same change with the reason in the commit.
 */
export const PERF_BUDGETS = {
  /** Terminal client resident memory (MB): a freshly started client, and after scrolling a whole history and streaming an answer. */
  clientRssMB: { idle: 90, afterUse: 170 },
  /** Daemon resident memory (MB): with no client, and with one client attached and reading the session. */
  daemonRssMB: { idle: 120, withClient: 160 },
  /** What 10,000 messages may add over an empty session: the client lays out a window and the daemon pages the log, so both stay flat. */
  growthWith10kMessagesMB: { client: 15, daemon: 35 },
  /** Start-up (ms): the app's module graph, the first drawn frame, `help` end to end, and the daemon printing its socket (cold: first launch of a new binary is slower). */
  startupMs: { import: 150, firstFrame: 600, cliHelp: 700, daemonReady: 4000 },
  /** p95 of one frame (ms): nothing changed, a page up or down through the history, one streamed delta. */
  frameP95Ms: { idle: 8, scrollUp: 12, scrollDown: 12, stream: 10 },
} as const

/**
 * The budgets above are measured on macOS. The same binary on Linux x64 (glibc) starts about 22 MB higher in every process and grows
 * the same: CI run 40765681428 measured a client idle at 84.5 / 92.5 / 92.1 MB for 0 / 1,000 / 10,000 messages where macOS measures
 * 63 / 70.8 / 69.8. Absolute RSS budgets get this offset on Linux; growth budgets stay the same on every platform.
 */
export const PLATFORM_RSS_MB = process.platform === "linux" ? 25 : 0
const rss = (limit: number) => limit + PLATFORM_RSS_MB

/**
 * Solo mode (one process hosting the daemon): measured values plus the same headroom as above (docs/performance.md). The
 * numbers come from `bun scripts/perf.ts --mode daemon,solo` (2026-10-05, load average 5.5 on a shared machine, 0 / 1,000 /
 * 10,000 messages): worst measured idle 133 MB and 216 MB after use, hosting 98 ms, first frame 210 ms, scroll p95 8.4 ms,
 * stream p95 9.1 ms. RSS gets 1.25x, times 3 to 4x (frames 3x: the solo budget keeps a frame under the 16.7 ms of 60 fps).
 */
export const PERF_BUDGETS_SOLO = {
  /** Resident memory (MB) of the one process: idle after the first frame, and after scrolling a whole history and streaming an answer. */
  rssMB: { idle: 170, afterUse: 270 },
  /** Start-up (ms): the in-process daemon ready, and the first drawn frame counted from the probe's start. */
  startupMs: { hosted: 400, firstFrame: 840 },
  /** p95 of one frame (ms) while the daemon lives in the same process. */
  frameP95Ms: { idle: 15, scrollUp: 25, scrollDown: 25, stream: 27 },
}

/**
 * What a solo run exceeds; a budget of 0 is not set yet and is skipped. `timeScale` multiplies the time budgets only (a slow
 * shared CI runner, see scripts/test-budget.ts); memory budgets are never scaled.
 */
export function soloViolations(results: readonly SoloPerfResult[], timeScale = 1): string[] {
  const out: string[] = []
  const over = (label: string, value: number, limit: number) => void (limit > 0 && value > limit && out.push(`${label}: ${value} > ${limit}`))
  const overTime = (label: string, value: number, limit: number) => over(label, value, limit * timeScale)
  for (const result of results) {
    const at = `solo ${result.messages} messages`
    over(`${at} RSS MB idle`, result.rssMB.idle, rss(PERF_BUDGETS_SOLO.rssMB.idle))
    over(`${at} RSS MB after scrolling and streaming`, Math.max(result.rssMB.scrolledUp, result.rssMB.afterStream), rss(PERF_BUDGETS_SOLO.rssMB.afterUse))
    overTime(`${at} daemon hosted ms`, result.startupMs.hosted, PERF_BUDGETS_SOLO.startupMs.hosted)
    overTime(`${at} first frame ms`, result.startupMs.firstFrame, PERF_BUDGETS_SOLO.startupMs.firstFrame)
    for (const [name, limit] of Object.entries(PERF_BUDGETS_SOLO.frameP95Ms)) overTime(`${at} ${name} frame p95 ms`, result.frameMs[name as keyof typeof PERF_BUDGETS_SOLO.frameP95Ms].p95, limit)
  }
  return out
}

/** What a run exceeds, one readable line per budget; empty when every budget holds. `timeScale` multiplies the time budgets only (see `soloViolations`). */
export function violations(results: readonly PerfResult[], cliHelpMs?: number, timeScale = 1): string[] {
  const out: string[] = []
  const over = (label: string, value: number, limit: number) => void (value > limit && out.push(`${label}: ${value} > ${limit}`))
  const overTime = (label: string, value: number, limit: number) => over(label, value, limit * timeScale)
  for (const result of results) {
    const at = `${result.messages} messages`
    over(`${at} client idle RSS MB`, result.rssMB.idle, rss(PERF_BUDGETS.clientRssMB.idle))
    over(`${at} client RSS MB after scrolling and streaming`, Math.max(result.rssMB.scrolledUp, result.rssMB.afterStream), rss(PERF_BUDGETS.clientRssMB.afterUse))
    over(`${at} daemon idle RSS MB`, result.daemon.rssIdleMB, rss(PERF_BUDGETS.daemonRssMB.idle))
    over(`${at} daemon RSS MB with a client`, result.daemon.rssWithClientMB, rss(PERF_BUDGETS.daemonRssMB.withClient))
    overTime(`${at} app import ms`, result.startupMs.import, PERF_BUDGETS.startupMs.import)
    overTime(`${at} first frame ms`, result.startupMs.firstFrame, PERF_BUDGETS.startupMs.firstFrame)
    overTime(`${at} daemon ready ms`, result.daemon.readyMs, PERF_BUDGETS.startupMs.daemonReady)
    for (const [name, limit] of Object.entries(PERF_BUDGETS.frameP95Ms)) overTime(`${at} ${name} frame p95 ms`, result.frameMs[name as keyof typeof PERF_BUDGETS.frameP95Ms].p95, limit)
  }
  const empty = results.find((result) => result.messages === 0)
  const large = results.find((result) => result.messages >= 10_000)
  if (empty && large) {
    over("10,000 messages client idle RSS growth MB", +(large.rssMB.idle - empty.rssMB.idle).toFixed(1), PERF_BUDGETS.growthWith10kMessagesMB.client)
    over("10,000 messages daemon RSS growth MB", +(large.daemon.rssWithClientMB - empty.daemon.rssWithClientMB).toFixed(1), PERF_BUDGETS.growthWith10kMessagesMB.daemon)
  }
  if (cliHelpMs !== undefined) overTime("cli help ms", cliHelpMs, PERF_BUDGETS.startupMs.cliHelp)
  return out
}
