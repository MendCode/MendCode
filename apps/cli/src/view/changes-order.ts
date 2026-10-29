import type { ChangesReport } from "@mendcode/protocol"
import type { ChangesPageState } from "./changes-state"

export const REVIEW_ORDER_REASON = "source → tests → docs → generated/binary · path within each group"
const rank = (path: string, binary: boolean) => binary || /(?:^|\/)(?:dist|build|generated)\/|(?:^|\/)(?:pnpm-lock\.yaml|bun\.lockb?)$|\.min\./i.test(path) ? 3
  : /(?:^|\/)(?:docs?)\/|\.(?:md|mdx|txt)$/i.test(path) ? 2
  : /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./i.test(path) ? 1 : 0

/** Local heuristic only: no model call and no claim of dependency analysis. */
export function orderChanges(report: ChangesReport): ChangesReport {
  return { ...report, files: report.files.toSorted((a, b) => rank(a.path, a.binary) - rank(b.path, b.binary) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
}

/** Preserve identity rather than the previous numeric position; never mutate review drafts or comments. */
export function refreshChangesState(state: ChangesPageState, previous: ChangesReport | undefined, next: ChangesReport): ChangesPageState {
  const path = previous?.files[state.selected]?.path
  const found = next.files.findIndex((file) => file.path === path)
  if (found >= 0) return { ...state, selected: found }
  return { ...state, selected: Math.max(0, Math.min(state.selected, next.files.length - 1)), cursor: 0, scroll: 0, anchor: null }
}
