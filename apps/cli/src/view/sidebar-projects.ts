import type { SessionSummary } from "@mendcode/protocol"
import { sessionOrderAt } from "./session-label"

/**
 * Which folders the all-projects sidebar groups, and in what order (docs/sidebar.md). A project is a git work tree root (or the
 * opened folder), never the home folder, a hidden folder or a temp folder; ranked by the last time a person wrote in one of their sessions
 * (never by which one is open or by an agent at work), the opened and busy ones always showing, the rest up to `sidebarProjectCount` or, when that is 0, as many as fit. Pure functions plus one small cache: the disk is asked once
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

type Ranked = Pick<SessionSummary, "sessionId" | "directory" | "updatedAt"> & Partial<Pick<SessionSummary, "lifecycle" | "lastSeq" | "state" | "queued" | "origin" | "lastHumanAt" | "createdAt">>

/** Whose projects the all-projects list shows: `you`, the ones where a person typed; `all`, every one. */
export type SidebarProjectsFrom = "you" | "all"

/**
 * Whether a session counts as a person's work. A message typed in the terminal UI left `lastHumanAt`; a session with no
 * recorded origin was made before origins were kept, and is taken as a person's so nothing disappears on the day this lands
 * (the folder can still be hidden by hand). One made by a script, an agent or the daemon without a typed message is not.
 */
export const humanSession = (session: Pick<Ranked, "origin" | "lastHumanAt">) => session.lastHumanAt !== undefined || session.origin === undefined

/** A project already ranked keeps its place while its latest activity moves less than this: a streaming turn does not shuffle the list. */
export const SETTLE_MS = 60_000

/**
 * The projects to draw, the one a person wrote in last first. The opened folder, the ones with a session working or waiting and the ones
 * used today always show; the others fill up to `count` in the same order. Which folder is open never moves a group: the rank is
 * the latest `sessionOrderAt` of its sessions (a message a person typed, else a session made; not a reply, a read, an open or a draft). `rest` keeps the ranking for the "more
 * projects" row. `stamps` remembers each folder's rank time between frames, so a folder takes a new place only when its latest
 * activity moved by `SETTLE_MS` or more. `sessions` are the listed, non-archived ones; `directory` is the canonical folder.
 */
export function rankProjects({ sessions, opened, now, count, busy, isProject, eligible, stamps, from = "all", hidden }: { /** `you`: a project with no session a person typed in (see `humanSession`) waits in `rest` unless it is opened or has a session working or waiting. Default `all`. */ from?: SidebarProjectsFrom; /** Folders the user hid by hand: never listed, `rest` included, except the opened one. */ hidden?: ReadonlySet<string>; sessions: readonly Ranked[]; opened: string; now: number; count: number; busy: (session: Ranked) => boolean; isProject: (directory: string) => boolean; /** Whether a folder may be a project by its path alone (see `eligibleDirectory`); with it, a folder used in the last day counts even when it is not a git root. */ eligible?: (directory: string) => boolean; stamps?: Map<string, number> }): { shown: string[]; rest: string[]; /** Every project in rank order, shown or not: the list opened by the more-projects row. */ all: string[]; /** The opened, busy and used-today folders, which show past any cap. */ always: ReadonlySet<string> } {
  const facts = new Map<string, { latest: number; recent: number; busy: boolean; fresh: boolean; human: boolean }>()
  for (const session of sessions) {
    const directory = session.directory
    if (hidden?.has(directory) && directory !== opened) continue
    const at = session.updatedAt
    // A folder used in the last day is a project whether or not it is a git root, and stays listed after the opened folder moves on.
    const fresh = directory !== opened && !isProject(directory) && eligible?.(directory) === true && now - at <= FRESH_MS
    if (directory !== opened && !isProject(directory) && !fresh) continue
    const fact = facts.get(directory) ?? { latest: 0, recent: 0, busy: false, fresh: false, human: false }
    // The rank is the last time a person wrote in the project (else when its newest session was made): an agent at work never lifts a group.
    fact.latest = Math.max(fact.latest, sessionOrderAt(session))
    if (now - at <= RECENT_MS) fact.recent++
    if (busy(session)) fact.busy = true
    const human = humanSession(session)
    if (human) fact.human = true
    // A folder used today only by tools is not forced onto the list of the projects you typed in.
    if (fresh && (from === "all" || human)) fact.fresh = true
    facts.set(directory, fact)
  }
  if (stamps) for (const [directory, fact] of facts) {
    const held = stamps.get(directory)
    if (held !== undefined && fact.latest >= held && fact.latest - held < SETTLE_MS) fact.latest = held
    else stamps.set(directory, fact.latest)
  }
  if (!facts.has(opened)) facts.set(opened, { latest: 0, recent: 0, busy: false, fresh: false, human: true })
  const byRank = (a: string, b: string) => facts.get(b)!.latest - facts.get(a)!.latest || facts.get(b)!.recent - facts.get(a)!.recent || a.localeCompare(b)
  const ranked = [...facts.keys()].sort(byRank)
  // The opened and busy folders, and the ones listed only because they were used today, show past the cap; the others fill it in rank order.
  const always = new Set(ranked.filter((directory) => directory === opened || facts.get(directory)!.busy || facts.get(directory)!.fresh))
  const shown = new Set(always)
  for (const directory of ranked) {
    if (shown.size >= count) break
    if (from === "you" && !facts.get(directory)!.human) continue
    shown.add(directory)
  }
  return { shown: ranked.filter((directory) => shown.has(directory)), rest: ranked.filter((directory) => !shown.has(directory)), all: ranked, always }
}
