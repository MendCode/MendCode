import type { GitInitPlan } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { clampLine } from "./changes-page"
import { fit, panelGrid, spread } from "./deck"
import { actionChip, chipAt, muted, mutedWrapped, outputRows, quoted, text, wrapped } from "./git-card"
import type { GitCommitNotice } from "./git-commit-page"
import { fitHints } from "./git-page"
import { wrap } from "./wrap"

/**
 * What the Git page shows in a folder that is not a Git repository (docs/git.md): one state in place of the tabs' content, what it is and
 * one action, Initialize repository, behind a card that shows the exact command. The keys and rows here are pure; the page controller
 * (`ui/app/git.ts`) talks to the daemon. Local only: nothing here reaches the network.
 */

export type GitInitBody =
  | { kind: "loading" }
  | { kind: "ready"; plan: GitInitPlan }
  /** The daemon would not initialize this folder (the home folder, a `.git` it cannot read...): its reason, as one line. */
  | { kind: "refused"; text: string }
export type GitInitStage = "view" | "card" | "running"
export type GitInitState = { directory: string; body: GitInitBody; stage: GitInitStage; notice: GitCommitNotice | undefined }
export type GitInitAction = { type: "none" } | { type: "close" } | { type: "refresh" } | { type: "card" } | { type: "confirm" }

const NONE: GitInitAction = { type: "none" }
const LABEL = "Initialize repository"

export const createGitInitState = (directory: string): GitInitState => ({ directory, body: { kind: "loading" }, stage: "view", notice: undefined })

function hintsOf(state: GitInitState): { hints: string; escape: string } {
  if (state.stage === "running") return { hints: "initializing…", escape: "esc back" }
  if (state.stage === "card") return { hints: "enter initialize · esc cancel", escape: "esc cancel" }
  if (state.body.kind === "ready") return { hints: "i initialize · r refresh · esc back", escape: "esc back" }
  return { hints: state.body.kind === "loading" ? "esc back" : "r refresh · esc back", escape: "esc back" }
}

/**
 * Handles one raw key. View: `i` or `enter` asks for the card, `r` looks again (the folder may have become a repository), `esc` goes back.
 * Card: `enter` initializes, `esc` cancels.
 */
export function gitInitKey(state: GitInitState, key: string): { state: GitInitState; action: GitInitAction } {
  const move = (patch: Partial<GitInitState>, action: GitInitAction = NONE) => ({ state: { ...state, notice: undefined, ...patch }, action })
  if (state.stage === "running") return { state, action: NONE }
  if (state.stage === "card") {
    if (key === "\r") return move({}, { type: "confirm" })
    if (key === "\x1b" || key === "q") return move({ stage: "view" })
    return { state, action: NONE }
  }
  if (key === "\x1b" || key === "q") return move({}, { type: "close" })
  if (key === "r") return move({}, { type: "refresh" })
  if ((key === "i" || key === "\r") && state.body.kind === "ready") return move({ stage: "card" }, { type: "card" })
  return { state, action: NONE }
}

const TONE: Record<GitCommitNotice["tone"], ColorName> = { warning: "warning", error: "error", success: "success" }

/** The card: the exact command, where it runs, and what is not done. After a failure it keeps the command and gives way to what git printed. */
function cardRows(plan: GitInitPlan, width: number, failure: readonly string[] | undefined, room: number): Line[] {
  const out: Line[] = [...wrapped(quoted(plan.argv), width, { bold: true }), ...wrapped(`in ${plan.directory}`, width)]
  out.push(...mutedWrapped(`first branch ${plan.branch}${plan.branchFrom === "config" ? " · your init.defaultBranch" : ""}`, width))
  if (failure) return [...out, [], ...outputRows(failure.slice(-Math.max(3, room - out.length - 1)), width)]
  out.push([])
  out.push(...mutedWrapped("not done: no commit, no .gitignore, no remote, no network", width))
  out.push(...mutedWrapped("your files are not touched · the Commit tab lists them next", width))
  return out
}

/** The page's rows: exactly `height` lines of `width` cells. The caller puts the Git tabs row above it and gives it one row less. */
export function renderGitInitPage(input: { state: GitInitState; width: number; height: number }): Line[] {
  const { state, width, height } = input
  if (height <= 0) return []
  const inner = Math.max(1, width - 2)
  const pad = (rows: Line[]) => {
    const out = rows.slice(0, height)
    while (out.length < height) out.push([])
    return out.map((row) => fit([{ text: " " }, ...fit(row, inner), { text: " " }], width))
  }
  const { hints, escape } = hintsOf(state)
  const title = "Initialize repository"
  const header = spread([{ text: title, fg: "primary", bold: true }], [{ text: fitHints({ title, hints, escape, inner }), fg: "muted" }], inner)
  const summary = clampLine([text(state.directory)], inner)
  const room = Math.max(0, height - 4)
  const notice: Line = state.notice ? clampLine([{ text: state.notice.text, fg: TONE[state.notice.tone] }], inner) : []
  const frame = (rows: Line[]) => pad([header, summary, [], ...rows.slice(0, room), ...Array.from({ length: Math.max(0, room - rows.length) }, (): Line => []), notice])
  const card = (heading: string, rows: (width: number) => Line[]) => panelGrid({ width: inner, padding: true, rows: [[{ title: heading, active: true, body: rows }]], heights: [room] })

  const body = state.body
  if (state.stage !== "view" && body.kind === "ready") return frame(card(state.stage === "running" ? "Initializing…" : "Confirm · local only, nothing leaves this machine", (w) => cardRows(body.plan, w, state.notice?.detail, room - 4)))
  const panel = (rows: (width: number) => Line[]) => panelGrid({ width: inner, padding: true, rows: [[{ title: "Not a Git repository", active: true, body: rows }]], heights: [room] })
  if (body.kind === "loading") return frame(panel(() => [[muted("checking the folder…")]]))
  if (body.kind === "refused") return frame(panel((w) => wrap(body.text, w).map((row): Line => [{ text: row, fg: "warning" }])))
  return frame(panel((w) => [
    ...wrapped("No changes to review, no commits and no worktrees here yet.", w),
    ...mutedWrapped("Initializing is local: nothing leaves this machine and your files are not touched.", w),
    [],
    [actionChip(LABEL)],
  ]))
}

/** Where a click on the Initialize action lands: its row in the page's rows (the tabs row is not one of them) and its screen columns; undefined while it is not drawn. */
export function gitInitHit(state: GitInitState, width: number, height: number) {
  if (state.stage !== "view" || state.body.kind !== "ready") return undefined
  return chipAt(renderGitInitPage({ state, width, height }), ` ${LABEL} `)
}
