import { describe, expect, test } from "bun:test"
import { loadWorkspaceDiffWithGit, normalizeNoIndexPatch, parseGitPathList } from "../../src/cli/cmd/tui/routes/changes/load-diff"
import { changesKeybindLabel } from "../../src/cli/cmd/tui/routes/changes/keybinds"
import { fileNavScrollOffset } from "../../src/cli/cmd/tui/routes/changes/file-nav"
import { routeReturnTarget } from "../../src/cli/cmd/tui/context/route-return"
import { createReviewState } from "../../src/cli/cmd/tui/routes/changes/review-state"

describe("changes route", () => {
  test("returns to the originating session", () => {
    expect(
      routeReturnTarget({
        type: "changes",
        returnTo: { type: "session", sessionID: "ses_changes" },
      }),
    ).toEqual({ type: "session", sessionID: "ses_changes" })
  })

  test("falls back to home without return route", () => {
    expect(routeReturnTarget({ type: "changes" })).toEqual({ type: "home" })
  })

  test("keeps no-index untracked patches parseable as normal git files", () => {
    const patch = normalizeNoIndexPatch(
      `diff --git a/dev/null b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+hello
`,
      "new.ts",
    )

    expect(patch).toContain("diff --git a/new.ts b/new.ts")
  })

  test("keeps tracked files visible when one patch exceeds the git buffer", () => {
    const loaded = loadWorkspaceDiffWithGit("/repo", (_cwd, args) => {
      if (args[0] === "diff" && args.includes("--name-only")) {
        return { ok: true, stdout: "big.txt\0src/small.ts\0" }
      }
      if (args.at(-1) === "big.txt") {
        return {
          ok: false,
          stdout: "",
          error: "spawnSync git ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)",
          code: "ENOBUFS",
        }
      }
      if (args.at(-1) === "src/small.ts") {
        return {
          ok: true,
          stdout: `diff --git a/src/small.ts b/src/small.ts
--- a/src/small.ts
+++ b/src/small.ts
@@ -1 +1 @@
-old
+new
`,
        }
      }
      if (args[0] === "ls-files") return { ok: true, stdout: "" }
      return { ok: false, stdout: "", error: `unexpected git args ${args.join(" ")}` }
    })

    const state = createReviewState({ workspaceRoot: "/repo", diff: loaded.diff })

    expect(loaded.error).toBeUndefined()
    expect(loaded.skipped).toEqual(["big.txt"])
    expect(state.files.map((file) => file.path)).toEqual(["big.txt", "src/small.ts"])
  })

  test("parses nul-delimited git path output without trimming valid path spaces", () => {
    expect(parseGitPathList(" leading.txt\0dir/trailing .txt\0\0")).toEqual([" leading.txt", "dir/trailing .txt"])
  })

  test("renders compact and full keybind labels", () => {
    expect(changesKeybindLabel(60)).toContain("←/→ file")
    expect(changesKeybindLabel(60)).toContain("↑/↓ Pg lines")
    expect(changesKeybindLabel(60)).toContain("l line")
    expect(changesKeybindLabel(120)).toContain("c comment")
    expect(changesKeybindLabel(120)).not.toContain("Enter")
    expect(changesKeybindLabel(120)).toContain("←/→ or n/p files")
    expect(changesKeybindLabel(120)).toContain("esc/q back")
  })

  test("keeps file navigation near the scroll edge for the active direction", () => {
    expect(fileNavScrollOffset(20, 1, 40)).toBe(15)
    expect(fileNavScrollOffset(20, -1, 40)).toBe(40)
  })
})
