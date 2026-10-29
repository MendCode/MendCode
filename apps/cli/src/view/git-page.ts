import { keyText } from "../ui/key-labels"
import type { Line, Span } from "../ui/theme"
import { fit, lineWidth, spread } from "./deck"
import { tabsRow, type PageTab } from "./page"
import { textWidth } from "./wrap"

/**
 * The frame the Git page puts around its tabs (docs/git.md): one row on top of the page that is open, with the three tabs on the left
 * and the repository's state on the right. The pages inside keep their own header and keys; this row is all the frame adds.
 */

export type GitTab = "changes" | "commit" | "worktrees" | "pr"
export const GIT_TAB_IDS: readonly GitTab[] = ["changes", "commit", "worktrees", "pr"]

/** Tabs are switched with `<` and `>` or a click, so they carry no number (1 and 2 are the Changes page's Files and Diff). */
const TABS: Array<PageTab & { id: GitTab }> = [
  { id: "changes", key: "", label: "Changes", short: "Chg" },
  { id: "commit", key: "", label: "Commit", short: "Com" },
  { id: "worktrees", key: "", label: "Worktrees", short: "Wt" },
  { id: "pr", key: "", label: "PR", short: "PR" },
]
const NARROW = 70

/** What `git.status` answers: the branch, how far it is from its upstream, and how many paths are dirty. Nothing leaves the machine. */
export type GitStatusInfo = { loaded: boolean; branch?: string; detached?: boolean; dirty?: number; conflicts?: number; ahead?: number; behind?: number; error?: string }

/** The tab a page belongs to; the Worktrees tab is both the manager and the workspace picker. */
export function gitTabOf(page: string): GitTab | undefined {
  if (page === "changes") return "changes"
  if (page === "git-commit") return "commit"
  if (page === "git-pr") return "pr"
  if (page === "worktrees" || page === "warp") return "worktrees"
  return undefined
}

function statusSpans(status: GitStatusInfo, full: boolean): Line {
  if (!status.loaded) return [{ text: "…", fg: "muted" }]
  if (!status.branch && !status.detached) return [{ text: status.error ?? "not a git repository", fg: "muted" }]
  const out: Span[] = [{ text: status.detached ? "detached HEAD" : status.branch!, fg: status.detached ? "warning" : "text" }]
  if (!full) return out
  if (status.ahead !== undefined && status.behind !== undefined) out.push({ text: ` ↑${status.ahead} ↓${status.behind}`, fg: "muted" })
  const dirty = status.dirty ?? 0
  out.push({ text: " · ", fg: "muted" }, dirty > 0 ? { text: `${dirty} dirty`, fg: "text" } : { text: "clean", fg: "muted" })
  if (status.conflicts) out.push({ text: ` · ${status.conflicts} ${status.conflicts === 1 ? "conflict" : "conflicts"}`, fg: "warning" })
  return out
}

/** The tabs row alone, `inner` cells wide: the tabs, the `< >` hint when the room and the keys allow it, then the state of the repository. */
function row(input: { active: GitTab | undefined; status: GitStatusInfo; inner: number; typing: boolean }): Line {
  const { active, status, inner } = input
  const compact = inner + 2 < NARROW
  const tabs = tabsRow(TABS.map((tab) => ({ key: tab.key, label: compact ? tab.short ?? tab.label : tab.label, ...(tab.short ? { short: tab.short } : {}) })), TABS.findIndex((tab) => tab.id === active), inner)
  const hint: Line = input.typing || compact ? [] : [{ text: `  ${keyText("< > tabs")}`, fg: "muted" }]
  for (const [left, right] of [[[...tabs, ...hint], statusSpans(status, true)], [tabs, statusSpans(status, true)], [tabs, statusSpans(status, false)]] as const) {
    if (lineWidth(left) + 1 + lineWidth(right) <= inner) return spread([...left], [...right], inner)
  }
  return fit(tabs, inner)
}

/** The full-width row for the top of a page `width` cells wide (one cell of padding on each side, like the pages below it). No `active` tab: the folder is not a repository, so no tab has content. */
export function gitTabsRow(input: { active: GitTab | undefined; status: GitStatusInfo; width: number; typing?: boolean }): Line {
  const inner = Math.max(1, input.width - 2)
  return fit([{ text: " " }, ...row({ active: input.active, status: input.status, inner, typing: input.typing ?? false })], input.width)
}

export type GitTabHit = { from: number; to: number; tab: GitTab }

/** Where a click on the tabs row picks a tab, in screen columns of a page `width` cells wide. */
export function gitTabHits(width: number): GitTabHit[] {
  const inner = Math.max(1, width - 2)
  const compact = width < NARROW
  const line = tabsRow(TABS.map((tab) => ({ key: tab.key, label: compact ? tab.short ?? tab.label : tab.label, ...(tab.short ? { short: tab.short } : {}) })), 0, inner)
  const hits: GitTabHit[] = []
  let column = 1
  let index = 0
  for (const span of line) {
    const end = column + textWidth(span.text)
    if (span.text.trim() !== "") hits.push({ from: column, to: end, tab: TABS[index++]!.id })
    column = end
  }
  return hits
}

/**
 * The hints of a page header that fit beside its title: the page's own, in order, then the escape hint last. Pages draw `Title … hints`
 * on one row; a hint that does not fit is dropped whole.
 */
export function fitHints(input: { title: string; hints: string; escape: string; inner: number }): string {
  const chosen: string[] = []
  const room = Math.max(8, input.inner - Math.min(textWidth(input.title), 26) - 2)
  for (const hint of input.hints.split(" · ").filter((entry) => !entry.startsWith("esc "))) if (textWidth([...chosen, hint, input.escape].join(" · ")) <= room) chosen.push(hint)
  return keyText([...chosen, input.escape].join(" · "))
}
