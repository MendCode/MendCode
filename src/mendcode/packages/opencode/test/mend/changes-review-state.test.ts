import { describe, expect, test } from "bun:test"
import {
  activeReviewFile,
  activeReviewBlock,
  createReviewState,
  reviewLayoutForDimensions,
  reviewStats,
  selectableLineCount,
  selectedReviewLineOrdinal,
  selectFileLineByOrdinal,
  selectLineByNumber,
  selectLineByOffset,
  selectNextFile,
  selectNextBlock,
  selectNextLine,
  shouldChangesRouteHandleKey,
} from "../../src/cli/cmd/tui/routes/changes/review-state"

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+more
 tail
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+hello
+world
`

describe("changes review state", () => {
  test("parses patch files into stable files, blocks, rows, and stats", () => {
    const state = createReviewState({ workspaceRoot: "/repo", diff: DIFF, now: "2026-06-20T00:00:00.000Z" })

    expect(state.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(state.selection).toMatchObject({ filePath: "src/a.ts", blockIndex: 0 })
    expect(state.selection.lineID).toContain("src_a.ts:0")
    expect(reviewStats(state.files)).toEqual({ files: 2, additions: 4, deletions: 1, blocks: 2 })
    expect(state.files[0]!.blocks[0]!.lines.map((line) => line.kind)).toEqual([
      "context",
      "removed",
      "added",
      "added",
      "context",
    ])
  })

  test("navigates files and blocks without losing route state", () => {
    const state = createReviewState({ workspaceRoot: "/repo", diff: DIFF })
    const nextFile = { ...state, selection: selectNextFile(state, 1) }

    expect(activeReviewFile(nextFile)?.path).toBe("src/b.ts")
    expect(activeReviewBlock(nextFile)?.index).toBe(0)
    expect(selectNextBlock(nextFile, 1).filePath).toBe("src/a.ts")
  })

  test("navigates selectable lines before moving to the next block", () => {
    const state = createReviewState({ workspaceRoot: "/repo", diff: DIFF })
    const nextLine = { ...state, selection: selectNextLine(state, 1) }

    expect(nextLine.selection.filePath).toBe("src/a.ts")
    expect(nextLine.selection.blockIndex).toBe(0)
    expect(nextLine.selection.lineID).not.toBe(state.selection.lineID)
  })

  test("supports fast line navigation within large file blocks", () => {
    const state = createReviewState({ workspaceRoot: "/repo", diff: DIFF })
    const paged = { ...state, selection: selectLineByOffset(state, 4) }
    const bottom = { ...state, selection: selectFileLineByOrdinal(state, selectableLineCount(state) - 1) }
    const byNumber = { ...state, selection: selectLineByNumber(state, 3) }

    expect(selectedReviewLineOrdinal(paged)).toBe(4)
    expect(selectedReviewLineOrdinal(bottom)).toBe(selectableLineCount(state) - 1)
    expect(activeReviewFile(byNumber)?.path).toBe("src/a.ts")
    expect(byNumber.selection.lineID).toContain(":new:3")
  })

  test("computes responsive terminal breakpoints", () => {
    expect(reviewLayoutForDimensions({ width: 160, height: 40 })).toMatchObject({
      wide: true,
      medium: true,
      tiny: false,
    })
    expect(reviewLayoutForDimensions({ width: 70, height: 20 })).toMatchObject({
      wide: false,
      medium: false,
      tiny: true,
    })
  })

  test("route hotkeys stay inactive while dialogs own input", () => {
    expect(shouldChangesRouteHandleKey({ dialogOpen: false })).toBe(true)
    expect(shouldChangesRouteHandleKey({ dialogOpen: true })).toBe(false)
    expect(shouldChangesRouteHandleKey({ dialogOpen: false, defaultPrevented: true })).toBe(false)
  })
})
