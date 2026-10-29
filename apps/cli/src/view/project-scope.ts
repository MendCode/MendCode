/** True when `directory` is the project `root` or a folder inside it; with no root (or no directory known) nothing is filtered out. */
export function inProject(directory: string | undefined, root: string | undefined): boolean {
  if (!root || !directory) return true
  const base = root.length > 1 ? root.replace(/\/+$/, "") : root
  return directory === base || directory.startsWith(base === "/" ? "/" : `${base}/`)
}

/** The session states the home's Agent View lists as working or waiting. */
export const HOME_WORKING: ReadonlySet<string> = new Set(["generating", "tool", "compacting", "cancelling", "waiting_approval"])

/** How far back the home's Agent View lists finished sessions under Completed (v1 `agentViewSessionWindowMs`). */
export const HOME_RECENT_MS = 30 * 24 * 60 * 60 * 1000
