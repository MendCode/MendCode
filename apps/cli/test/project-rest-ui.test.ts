import { afterEach, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { projectRestHarness } from "./b85-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("workspace moves retain conversation and draft, refresh project data and render without overflow", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [180, 50]] as const) {
    const h = await projectRestHarness(width, height)
    await h.type("Continue reviewing")
    await h.warp()
    expect(h.sent.some((command) => command.type === "git.branch" && command.directory === h.target)).toBe(true)
    expect(h.sent.some((command) => command.type === "changes.query" && command.directory === h.target)).toBe(true)
    const text = h.text().join("\n")
    expect(text).toContain("Continue reviewing")
    expect(text).toContain("Review the worktree")
    expect(h.frames.at(-1)).toHaveLength(height)
    expect(h.frames.at(-1)!.every((row) => textWidth(row.map((span) => span.text).join("")) <= width)).toBe(true)
    await h.detach()
    expect(h.sent.filter((command) => command.type === "git.branch").at(-1)).toMatchObject({ directory: h.root })
    await h.app.onKey("\x03")
  }
})
