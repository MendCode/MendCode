import { describe, expect, test } from "bun:test"
import { normalizeNoIndexPatch } from "../../src/cli/cmd/tui/routes/changes/load-diff"
import { changesKeybindLabel } from "../../src/cli/cmd/tui/routes/changes/keybinds"
import { fileNavScrollOffset } from "../../src/cli/cmd/tui/routes/changes/file-nav"
import { routeReturnTarget } from "../../src/cli/cmd/tui/context/route-return"

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
