/** No dependencies: the upgrader and the thin client entries load it, and their module graphs stay free of zod and the protocol schemas. */

/** The version a checkout reports when no release stamped one; it has no release to compare with. */
export const DEV_VERSION = "0.0.1-dev"

/** What help, usage lines and hints call the command; `mendcode` unless the process was started under another allowed name. */
export const DEFAULT_PROGRAM_NAME = "mendcode"

/** `mendcode` or a lowercase suffix of it (`mendcode-next` for a developer's wrapper); a versioned asset name never matches. */
const PROGRAM_NAME_PATTERN = /^mendcode(?:-[a-z]+)?$/

/**
 * The name the user typed. `MENDCODE_PROGRAM` wins (a wrapper that runs `bun entry.ts` sets it, because the runtime
 * hides the wrapper's name); otherwise a compiled binary is named by its own file; everything else is `mendcode`.
 */
export function resolveProgramName({ env, execPath }: { env: Record<string, string | undefined>; execPath: string }) {
  const requested = env.MENDCODE_PROGRAM
  if (requested && PROGRAM_NAME_PATTERN.test(requested)) return requested
  const file = (execPath.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "")
  return PROGRAM_NAME_PATTERN.test(file) ? file : DEFAULT_PROGRAM_NAME
}

export const PROGRAM_NAME = typeof process === "undefined" ? DEFAULT_PROGRAM_NAME : resolveProgramName({ env: process.env, execPath: process.execPath })
