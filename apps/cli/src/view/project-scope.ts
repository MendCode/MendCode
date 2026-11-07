/**
 * True when `directory` is the folder `root` itself (a trailing slash aside); with no root (or no directory known) nothing is
 * filtered out. A folder inside it is another project, and the user's home is a folder like any other, not every project.
 */
export function inProject(directory: string | undefined, root: string | undefined): boolean {
  if (!root || !directory) return true
  const trim = (value: string) => value.length > 1 ? value.replace(/\/+$/, "") : value
  return trim(directory) === trim(root)
}

/** The session states the home's Agent View lists as working or waiting. */
export const HOME_WORKING: ReadonlySet<string> = new Set(["generating", "tool", "compacting", "cancelling", "waiting_approval"])

/** How far back the home's Agent View lists finished sessions under Completed (v1 `agentViewSessionWindowMs`). */
export const HOME_RECENT_MS = 30 * 24 * 60 * 60 * 1000
