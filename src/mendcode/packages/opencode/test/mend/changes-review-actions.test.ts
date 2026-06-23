import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"
import {
  clearActiveReviewState,
  dropActiveReviewState,
  reviewCommentAdd,
  reviewCommentClear,
  reviewCommentList,
  reviewContextForAssistant,
  reviewGetFile,
  reviewNavigate,
  reviewReload,
  reviewSummary,
} from "../../src/cli/cmd/tui/routes/changes/review-actions"

const DIFF = `diff --git a/a.ts b/a.ts
index 111..222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`

const MOVED_DIFF = `diff --git a/a.ts b/a.ts
index 222..333 100644
--- a/a.ts
+++ b/a.ts
@@ -9 +9 @@
-old
+newer
`

const TWO_FILE_DIFF = `${DIFF}diff --git a/b.ts b/b.ts
index 111..222 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-left
+right
`

describe("changes review actions", () => {
  test("stores active review state and exposes bounded actions", () => {
    clearActiveReviewState("/repo")
    reviewReload("/repo", DIFF)
    reviewCommentAdd("/repo", {
      filePath: "a.ts",
      blockIndex: 0,
      body: "agent note",
    })

    expect(reviewSummary("/repo")?.stats.files).toBe(1)
    expect(reviewCommentList("/repo")).toHaveLength(1)
    expect(reviewContextForAssistant("/repo")).toContain("agent note")
  })

  test("navigates and clears comments without mutating missing workspaces", () => {
    clearActiveReviewState("/repo")
    reviewReload("/repo", DIFF)
    expect(reviewNavigate("/repo", { direction: "next-block" })?.selection.filePath).toBe("a.ts")
    reviewCommentAdd("/repo", { filePath: "a.ts", blockIndex: 0, body: "clear me" })
    expect(reviewCommentClear("/repo")?.comments).toEqual([])
    expect(reviewSummary("/missing")).toBeUndefined()
  })

  test("returns the selected file when no file path is requested", () => {
    clearActiveReviewState("/repo")
    reviewReload("/repo", TWO_FILE_DIFF)
    reviewNavigate("/repo", { direction: "next-file" })

    expect(reviewGetFile("/repo")?.path).toBe("b.ts")
  })

  test("reload keeps the selected file when it still exists", () => {
    clearActiveReviewState("/repo")
    reviewReload("/repo", TWO_FILE_DIFF)
    reviewNavigate("/repo", { direction: "next-file" })
    const reloaded = reviewReload("/repo", TWO_FILE_DIFF)

    expect(reloaded?.selection.filePath).toBe("b.ts")
  })

  test("reload reconciles comments instead of copying stale anchors blindly", () => {
    clearActiveReviewState("/repo")
    reviewReload("/repo", DIFF)
    reviewCommentAdd("/repo", { filePath: "a.ts", blockIndex: 0, side: "new", line: 1, body: "line note" })
    const reloaded = reviewReload("/repo", MOVED_DIFF)

    expect(reloaded?.comments[0]?.stale).toBe(true)
  })

  test("assistant context hydrates persisted comments across process-local state loss", () => {
    const root = mkdtempSync(path.join(tmpdir(), "changes-review-"))
    try {
      git(root, "init")
      git(root, "config", "user.email", "test@example.com")
      git(root, "config", "user.name", "Test User")
      writeFileSync(path.join(root, "a.ts"), "old\n")
      git(root, "add", "a.ts")
      git(root, "commit", "-m", "initial")
      writeFileSync(path.join(root, "a.ts"), "new\n")

      reviewReload(root, DIFF)
      reviewCommentAdd(root, { filePath: "a.ts", blockIndex: 0, side: "new", line: 1, body: "persisted note" })
      dropActiveReviewState(root)

      expect(reviewContextForAssistant(root)).toContain("persisted note")
      dropActiveReviewState(root)
      expect(reviewCommentList(root)[0]?.body).toBe("persisted note")
    } finally {
      clearActiveReviewState(root)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`)
}
