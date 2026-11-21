import type { SessionSummary } from "@mendcode/protocol"
import type { ColorName } from "../ui/theme"

/**
 * Small pure helpers of the session rows (docs/sidebar.md): the live time of a running row, the PR state word, a merged or closed
 * PR settling its session, and the worktree name. Both left lists use them, and none of them reads the disk or sets a timer.
 */

/** Settled sessions shown when the shelf opens, and how many each `+ N more` row adds. */
export const SETTLED_FIRST = 10
export const SETTLED_PAGE = 25

/** How long a turn has run: `42s`, `2m14s`, `12m`, `1h05m`, `3h`. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 10 ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${hours}h`
}

type Live = Pick<SessionSummary, "state"> & Partial<Pick<SessionSummary, "agents" | "compacting">>

/** Whether the session compacts its conversation right now: the native engine's own state, or an engine's compaction in a turn. */
export const isCompacting = (session: Live) => session.compacting === true || session.state === "compacting"

/** The sub-agents working for the session right now: `↳2` in the working colour (ASCII `^2`); nothing when none works. */
export function agentsSpans(session: Live, ascii: boolean | undefined): Array<{ text: string; fg: ColorName }> {
  return session.agents ? [{ text: ` ${ascii ? "^" : "↳"}${session.agents}`, fg: "primary" }] : []
}

/** The selected row's words for its sub-agents: `2 sub-agents working` (compacting is already said on the row itself). */
export function liveDetail(session: Live): string[] {
  return session.agents ? [`${session.agents} sub-agent${session.agents === 1 ? "" : "s"} working`] : []
}

type Pr = NonNullable<NonNullable<SessionSummary["lifecycle"]>["pr"]>

const PR_WORD: Record<string, string> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" }
const PR_FG: Record<string, ColorName> = { OPEN: "success", MERGED: "accent", CLOSED: "error" }

/** The PR on a row's right side: `#812 merged` (number and state word, the state coloured), or just the word when the title needs the room. */
export function prSpans(pr: Pr, withNumber = true): Array<{ text: string; fg: ColorName }> {
  const fg = PR_FG[pr.state] ?? "muted"
  const word = PR_WORD[pr.state] ?? ""
  return [...(withNumber ? [{ text: ` #${pr.number}`, fg }] : []), ...(word ? [{ text: ` ${word}`, fg }] : [])]
}

type Settleable = Pick<SessionSummary, "sessionId" | "state" | "queued" | "updatedAt"> & Partial<Pick<SessionSummary, "archivedAt" | "lifecycle" | "paused">>

/**
 * A session whose PR is merged or closed counts as settled, as long as nothing happened in it since the PR was last checked: it is not
 * the open session, not pinned, and nothing runs, waits or is queued in it. A new message moves its activity past the check, which
 * brings it back. The settled time is the check's, so the sort and the shelf treat it like one the user settled.
 */
export function autoSettled<T extends Settleable>(sessions: readonly T[], current: string): T[] {
  return sessions.map((session) => {
    const pr = session.lifecycle?.pr
    if (session.archivedAt !== undefined || !pr || (pr.state !== "MERGED" && pr.state !== "CLOSED")) return session
    if (session.sessionId === current || session.lifecycle?.pinnedAt !== undefined) return session
    if ((session.state !== "idle" && session.state !== "error") || session.queued > 0 || session.paused) return session
    if (session.updatedAt > pr.checkedAt) return session
    return { ...session, archivedAt: pr.checkedAt }
  })
}

/** The name a linked worktree folder shows under a selected row: its folder's name. */
export const worktreeName = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory
