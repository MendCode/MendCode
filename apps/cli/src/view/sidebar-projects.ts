import type { SessionSummary } from "@mendcode/protocol"
import { sessionActivityAt } from "./session-label"

/**
 * Which folders the all-projects sidebar groups, and in what order (docs/sidebar.md). A project is a git work tree root (or the
 * opened folder), never the home folder, a hidden folder or a temp folder; the opened one comes first, then the ones with work in
 * progress, then the most recently used up to `sidebarProjectCount`. Pure functions plus one small cache: the disk is asked once
 * per folder, asynchronously, and never while a frame draws.
 */

/** What the disk says about a folder: whether it is a git work tree root, and for a linked worktree the main repo's folder. */
export type ProjectInspection = { git: boolean; main?: string }

/** The window "recent use" counts sessions over. */
export const RECENT_DAYS = 14
const RECENT_MS = RECENT_DAYS * 24 * 60 * 60 * 1000
/** A folder with a session used within this long is listed as a project even when it is not a git root. */
export const FRESH_MS = 24 * 60 * 60 * 1000

const trimmed = (directory: string) => directory.length > 1 ? directory.replace(/\/+$/, "") : directory
const within = (directory: string, root: string) => directory === root || directory.startsWith(`${root}/`)

/** Whether a folder may be a project by its path alone: not the home folder, not hidden, not under a temp root. */
export function eligibleDirectory({ directory, home, tmpRoots }: { directory: string; home: string; tmpRoots: readonly string[] }): boolean {
  const path = trimmed(directory)
  if (path === trimmed(home)) return false
  if (path.split("/").some((segment) => segment.startsWith("."))) return false
  return !tmpRoots.some((root) => within(path, trimmed(root)))
}

export type ProjectProbe = {
  /** Whether the folder is a project; false until the first answer for it is in. */
  isProject(directory: string): boolean
  /** Whether the path alone allows a project: not home, hidden or under a temp root. No disk question. */
  eligible(directory: string): boolean
  /** The folder a linked worktree belongs to (its main repo), else the folder itself. */
  canonical(directory: string): string
}

/**
 * The cached answers. A folder that its path rules out is never asked; every other one is asked once (`inspect`, asynchronous),
 * and `onChange` runs after answers arrive so the next frame draws them. A failed question counts as "not a project".
 */
export function createProjectProbe({ home, tmpRoots, inspect, onChange }: { home: string; tmpRoots: readonly string[]; inspect: (directory: string) => Promise<ProjectInspection>; onChange: () => void }): ProjectProbe {
  const answers = new Map<string, ProjectInspection | null>()
  const asked = new Set<string>()
  let notify = false
  const ask = (directory: string) => {
    if (asked.has(directory)) return
    asked.add(directory)
    void inspect(directory).then((found) => found, () => null).then((found) => {
      answers.set(directory, found)
      if (!notify) {
        notify = true
        queueMicrotask(() => { notify = false; onChange() })
      }
    })
  }
  const known = (directory: string): ProjectInspection | undefined => {
    const path = trimmed(directory)
    if (!eligibleDirectory({ directory: path, home, tmpRoots })) return undefined
    ask(path)
    return answers.get(path) ?? undefined
  }
  return {
    eligible: (directory) => eligibleDirectory({ directory: trimmed(directory), home, tmpRoots }),
    isProject(directory) {
      const found = known(directory)
      if (!found?.git) return false
      return found.main === undefined || eligibleDirectory({ directory: found.main, home, tmpRoots })
    },
    canonical(directory) {
      const found = known(directory)
      return found?.git && found.main !== undefined && eligibleDirectory({ directory: found.main, home, tmpRoots }) ? trimmed(found.main) : directory
    },
  }
}

type Ranked = Pick<SessionSummary, "sessionId" | "directory" | "updatedAt"> & Partial<Pick<SessionSummary, "lifecycle" | "lastSeq" | "state" | "queued">>

/**
 * The projects to draw: the opened one, then those with a session working or waiting, then the most recently used until `count`
 * (the opened and busy ones count toward it and always show). `rest` keeps the ranking for the "more projects" row.
 * `sessions` are the listed, non-archived ones; `directory` is the canonical folder.
 */
export function rankProjects({ sessions, opened, now, count, busy, isProject, eligible }: { sessions: readonly Ranked[]; opened: string; now: number; count: number; busy: (session: Ranked) => boolean; isProject: (directory: string) => boolean; /** Whether a folder may be a project by its path alone (see `eligibleDirectory`); with it, a folder used in the last day counts even when it is not a git root. */ eligible?: (directory: string) => boolean }): { shown: string[]; rest: string[] } {
  const facts = new Map<string, { latest: number; recent: number; busy: boolean; fresh: boolean }>()
  for (const session of sessions) {
    const directory = session.directory
    const at = sessionActivityAt(session as never)
    // A folder used in the last day is a project whether or not it is a git root, and stays listed after the opened folder moves on.
    const fresh = directory !== opened && !isProject(directory) && eligible?.(directory) === true && now - at <= FRESH_MS
    if (directory !== opened && !isProject(directory) && !fresh) continue
    const fact = facts.get(directory) ?? { latest: 0, recent: 0, busy: false, fresh: false }
    fact.latest = Math.max(fact.latest, at)
    if (now - at <= RECENT_MS) fact.recent++
    if (busy(session)) fact.busy = true
    if (fresh) fact.fresh = true
    facts.set(directory, fact)
  }
  const others = [...facts.keys()].filter((directory) => directory !== opened).sort((a, b) => facts.get(b)!.latest - facts.get(a)!.latest || facts.get(b)!.recent - facts.get(a)!.recent || a.localeCompare(b))
  // Busy folders, and folders listed only because they were used today, show past the cap: recent use beats it as work in progress does.
  const working = others.filter((directory) => facts.get(directory)!.busy || facts.get(directory)!.fresh)
  const shown = [opened, ...working]
  for (const directory of others) {
    if (shown.length >= count) break
    if (!shown.includes(directory)) shown.push(directory)
  }
  return { shown, rest: others.filter((directory) => !shown.includes(directory)) }
}
