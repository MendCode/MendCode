import path from "node:path"

const PASSTHROUGH = ["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME", "TZ"] as const

/**
 * The environment a harness child gets: a short allow-list (no API keys, no proxies, no CODEX_HOME, no HOME of the
 * operator) plus explicit overrides. The directory of the running Bun is put on PATH so tasks that call `bun` find it.
 */
export function cleanEnv(overrides: Record<string, string>, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSTHROUGH) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  const bunDir = path.dirname(process.execPath)
  const pathParts = (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)
  if (!pathParts.includes(bunDir)) pathParts.unshift(bunDir)
  env.PATH = pathParts.join(path.delimiter)
  env.TERM = "dumb"
  env.NO_COLOR = "1"
  env.CI = "1"
  return { ...env, ...overrides }
}
