import { describe, expect, test } from "bun:test"
import {
  addReviewComment,
  applyReconciledComments,
  clearReviewComments,
  commentsForBlock,
  commentsForLine,
} from "../../src/cli/cmd/tui/routes/changes/review-comments"
import { createReviewState } from "../../src/cli/cmd/tui/routes/changes/review-state"

const ORIGINAL = `diff --git a/app.ts b/app.ts
index 111..222 100644
--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,2 @@
-old
+new
 keep
`

const UPDATED = `diff --git a/app.ts b/app.ts
index 222..333 100644
--- a/app.ts
+++ b/app.ts
@@ -8,2 +8,2 @@
-old
+newer
 keep
`

describe("changes review comments", () => {
  test("adds user and assistant comments to blocks", () => {
    const base = createReviewState({ workspaceRoot: "/repo", diff: ORIGINAL })
    const withUser = addReviewComment(base, {
      author: "user",
      filePath: "app.ts",
      blockIndex: 0,
      line: 1,
      body: "Check this change",
      now: "2026-06-20T00:00:00.000Z",
    })
    const withAssistant = addReviewComment(withUser, {
      author: "assistant",
      filePath: "app.ts",
      blockIndex: 0,
      body: "Looks risky",
      now: "2026-06-20T00:00:01.000Z",
    })

    expect(commentsForLine(withAssistant, "app.ts", 0, 1, "both").map((comment) => comment.author)).toEqual(["user"])
    expect(commentsForBlock(withAssistant, "app.ts", 0).map((comment) => comment.author)).toEqual(["assistant"])
  })

  test("line comments honor old/new side when line numbers overlap", () => {
    const base = createReviewState({ workspaceRoot: "/repo", diff: ORIGINAL })
    const next = addReviewComment(base, {
      author: "user",
      filePath: "app.ts",
      blockIndex: 0,
      side: "new",
      line: 1,
      body: "new side only",
    })

    expect(commentsForLine(next, "app.ts", 0, 1, "new")).toHaveLength(1)
    expect(commentsForLine(next, "app.ts", 0, 1, "old")).toHaveLength(0)
  })

  test("marks comments stale when reload moves the anchor", () => {
    const base = addReviewComment(createReviewState({ workspaceRoot: "/repo", diff: ORIGINAL }), {
      author: "user",
      filePath: "app.ts",
      blockIndex: 0,
      line: 1,
      body: "line-specific note",
    })
    const next = applyReconciledComments(createReviewState({ workspaceRoot: "/repo", diff: UPDATED }), base)

    expect(next.comments[0]?.stale).toBe(true)
  })

  test("clears comments by scope", () => {
    const base = addReviewComment(createReviewState({ workspaceRoot: "/repo", diff: ORIGINAL }), {
      author: "assistant",
      filePath: "app.ts",
      blockIndex: 0,
      body: "remove me",
    })

    expect(clearReviewComments(base, { filePath: "app.ts" }).comments).toEqual([])
  })
})
