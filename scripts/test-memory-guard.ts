/**
 * Preloaded into every `bun test` run (bunfig.toml at the root and in each workspace): a test process that grows past a bound is
 * stopped with a message instead of pushing the machine into swap. A run of every file of a workspace in one process reached 30 GB
 * on 2026-10-25 and again on 2026-11-20; the split runner (`scripts/test-fast.ts`) keeps each process far below the bound.
 * `MENDCODE_TEST_RSS_GB` sets another bound; `0` turns the guard off.
 */
const DEFAULT_LIMIT_GB = 8
const CHECK_MS = 2_000

export function rssLimitBytes(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.MENDCODE_TEST_RSS_GB
  const gb = raw === undefined || raw.trim() === "" ? DEFAULT_LIMIT_GB : Number(raw)
  if (!Number.isFinite(gb) || gb <= 0) return undefined
  return gb * 1024 ** 3
}

const limit = rssLimitBytes()
if (limit !== undefined) {
  const timer = setInterval(() => {
    const rss = process.memoryUsage.rss()
    if (rss <= limit) return
    process.stderr.write(`[TEST]: this test process uses ${(rss / 1024 ** 3).toFixed(1)} GB, over the ${(limit / 1024 ** 3).toFixed(0)} GB bound: stopped before it fills the machine. Run fewer files per process (\`bun scripts/test-fast.ts\`), or set MENDCODE_TEST_RSS_GB.\n`)
    process.exit(3)
  }, CHECK_MS)
  timer.unref()
}
