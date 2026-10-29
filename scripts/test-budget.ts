import { test } from "bun:test"

/**
 * Time budgets in tests are numbers measured on a developer machine. A shared CI runner (two slow vCPUs, noisy neighbours)
 * runs the same code 1.2 to 2.5 times slower (release run 0.0.1-beta.1: a 50 ms markdown render took 53 ms, a 4 ms orbit
 * frame 4.6 ms, a 10 ms stream frame 15 ms), so the workflow sets `MENDCODE_TEST_TIME_SCALE` and every wall-clock budget goes
 * through `budgetMs` / `timeScale`. Nothing sets it locally, so a developer machine keeps the original numbers.
 *
 * Only time is scaled. Memory, byte, count and ordering assertions stay exact whatever the variable says.
 */
export const TIME_SCALE_ENV = "MENDCODE_TEST_TIME_SCALE"
/** Comma separated tool names a CI workflow guarantees to have installed; a test that needs one fails (not skips) when it is missing. */
export const REQUIRE_TOOLS_ENV = "MENDCODE_REQUIRE_TOOLS"

type Env = Record<string, string | undefined>

/** The factor from the environment: 1 when unset; a value that is not a finite number of at least 1 is an error, never a silent 1. */
export function timeScale(env: Env = process.env): number {
  const raw = env[TIME_SCALE_ENV]
  if (raw === undefined || raw === "") return 1
  const scale = Number(raw)
  if (!Number.isFinite(scale) || scale < 1) throw new RangeError(`[TEST]: ${TIME_SCALE_ENV} must be a number of at least 1, got "${raw}"`)
  return scale
}

/** A time budget in milliseconds for this machine: the developer-machine number times `timeScale()`. */
export function budgetMs(milliseconds: number, env: Env = process.env): number {
  return milliseconds * timeScale(env)
}

/** Why `name` cannot run here, or undefined when it is on PATH (`path` replaces PATH for the lookup). */
export function missingTool(name: string, path?: string): string | undefined {
  return Bun.which(name, path === undefined ? {} : { PATH: path }) ? undefined : `${name} is not on PATH`
}

/**
 * The `test` function for a case that really needs an external program, and the suffix its title carries. Without the tool the
 * case is skipped and the title says why; when the workflow lists the tool in `MENDCODE_REQUIRE_TOOLS` the case runs anyway and
 * fails on the missing program, so the release gate cannot go green by skipping.
 *
 *     const rg = toolGate("rg")
 *     rg.test(`finds text${rg.suffix}`, async () => { ... })
 */
export function toolGate(name: string, env: Env = process.env): { test: typeof test; suffix: string } {
  const reason = missingTool(name)
  const required = (env[REQUIRE_TOOLS_ENV] ?? "").split(",").map((entry) => entry.trim()).includes(name)
  if (!reason || required) return { test, suffix: "" }
  return { test: test.skip, suffix: ` (skipped: ${reason})` }
}
