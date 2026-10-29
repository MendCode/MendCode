import { expect, test } from "bun:test"
import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { orderChanges, refreshChangesState } from "../src/view/changes-order"
import { createChangesPageState } from "../src/view/changes-state"
import { createChanges } from "../src/ui/app/changes"
import type { AppContext } from "../src/ui/app/context"

const file = (path: string): ChangedFile => ({ path, status: "modified", additions: 1, deletions: 0, binary: false, truncated: false, diff: "@@ -1 +1 @@\n+a" })
const report: ChangesReport = { root: "/repo", branch: "main", omittedFiles: 0, files: [file("docs/readme.md"), file("tests/a.test.ts"), file("src/z.ts"), file("pnpm-lock.yaml"), file("src/a.ts")] }

test("explicit ordering is stable, local and leaves the input untouched", () => {
  const next = orderChanges(report)
  expect(next.files.map((f) => f.path)).toEqual(["src/a.ts", "src/z.ts", "tests/a.test.ts", "docs/readme.md", "pnpm-lock.yaml"])
  expect(report.files[0]!.path).toBe("docs/readme.md")
  expect(orderChanges(next)).toEqual(next)
})

test("refresh follows path and preserves composing state and comments", () => {
  const state = { ...createChangesPageState(), selected: 2, mode: "compose" as const, draft: "keep typing", cursor: 1, scroll: 1 }
  const next = refreshChangesState(state, report, orderChanges(report))
  expect(next).toMatchObject({ selected: 1, draft: "keep typing", mode: "compose", cursor: 1, scroll: 1 })
  expect(next.comments).toBe(state.comments)
  const gone = refreshChangesState(state, report, { ...report, files: [] })
  expect(gone).toMatchObject({ selected: 0, cursor: 0, scroll: 0, draft: "keep typing" })
})

test("factory previews without sorting, applies by user action and refuses while composing or minimalist", async () => {
  const state = { changesReport: report, changesState: { ...createChangesPageState(), selected: 2 }, settingsNow: { tier: "balanced" } }
  const notices: string[] = []
  const actions = createChanges({ state, input: {}, requestFrame() {}, say: (message: string) => notices.push(message) } as unknown as AppContext)
  await actions.orderReview(false)
  expect(state.changesReport).toBe(report)
  expect(state.changesState.notice).toContain("O applies")
  await actions.orderReview(true)
  expect(state.changesReport.files[state.changesState.selected]!.path).toBe("src/z.ts")
  state.changesState.mode = "compose"
  const before = state.changesReport
  await actions.orderReview(true)
  expect(state.changesReport).toBe(before)
  state.settingsNow.tier = "minimalist"
  await actions.orderReview(true)
  expect(notices).toEqual(["review order requires balanced tier"])
})

test("factory refresh follows the path after an inserted file without losing the comment draft", async () => {
  const state = { sessionId: "session", changesSource: undefined, changesReport: report, changesError: "", fetchedDiffs: new Set(), changesState: { ...createChangesPageState(), selected: 2, mode: "compose" as const, draft: "unfinished comment" }, settingsNow: {} }
  const next = { ...report, files: [file("new.ts"), ...report.files] }
  const actions = createChanges({ state, input: { send: async (command: { type: string }) => command.type === "changes.query" ? { ok: true, result: next } : { ok: false } }, requestFrame() {} } as unknown as AppContext)
  await actions.loadChanges()
  expect(state.changesState).toMatchObject({ selected: 3, mode: "compose", draft: "unfinished comment" })
})
