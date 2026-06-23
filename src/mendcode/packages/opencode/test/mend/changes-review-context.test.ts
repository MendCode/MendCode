import { describe, expect, test } from "bun:test"
import { addReviewComment } from "../../src/cli/cmd/tui/routes/changes/review-comments"
import {
  reviewContextSummary,
  reviewContextText,
  selectedReviewPatch,
} from "../../src/cli/cmd/tui/routes/changes/review-context"
import { createReviewState } from "../../src/cli/cmd/tui/routes/changes/review-state"

const DIFF = `diff --git a/lib/example.ts b/lib/example.ts
index 111..222 100644
--- a/lib/example.ts
+++ b/lib/example.ts
@@ -1,2 +1,3 @@
 a
-b
+c
+d
`

describe("changes review context", () => {
  test("summarizes files, selection, diff blocks, and comments without raw patch by default", () => {
    const state = addReviewComment(createReviewState({ workspaceRoot: "/repo", diff: DIFF }), {
      author: "user",
      filePath: "lib/example.ts",
      blockIndex: 0,
      body: "why this change?",
    })
    const summary = reviewContextSummary(state)

    expect(summary.stats).toEqual({ files: 1, additions: 2, deletions: 1, blocks: 1 })
    expect(summary.files[0]?.patch).toBeUndefined()
    expect(summary.comments[0]?.body).toBe("why this change?")
  })

  test("includes raw patch only on demand for selected file", () => {
    const state = createReviewState({ workspaceRoot: "/repo", diff: DIFF })

    expect(selectedReviewPatch(state)).toContain("diff --git")
    expect(reviewContextSummary(state, { includePatch: true, filePath: "lib/example.ts" }).files[0]?.patch).toContain(
      "+++ b/lib/example.ts",
    )
  })

  test("formats compact assistant context text", () => {
    const state = createReviewState({ workspaceRoot: "/repo", diff: DIFF })

    expect(reviewContextText(state)).toContain("MendCode review workspace")
    expect(reviewContextText(state)).toContain("lib/example.ts")
  })
})
