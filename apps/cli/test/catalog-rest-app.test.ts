import { afterEach, expect, test } from "bun:test"
import { b83Harness } from "./b83-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("B83 MCP control events refresh bordered status and OAuth without stale config or filler copy", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b83Harness(width, height)
    await h.open()
    expect(h.text()).toContain("4 tools")
    expect(h.text()).not.toContain("no output")
    await h.update({ enabled: false, state: "stopped", tools: 0 })
    expect(h.text()).toContain("disabled")
    expect(h.text()).not.toContain("disabled in config")
    await h.update({ enabled: true, state: "failed", auth: "needs_auth", lastError: "Authorization required" })
    expect(h.text()).toContain("a auth")
    await h.key("a")
    expect(h.sentOf("mcp.auth")).toHaveLength(1)
    expect(h.text()).toContain("Authorization URL")
    expect(h.text()).toContain("auth URL copied")
    expect(h.text()).not.toContain("┃")
    expect(h.text()).toContain("https://auth.example.invalid/authorize?state=")
    expect(h.text()).toContain("fixture")
    await h.update({ state: "failed", auth: "pending" })
    expect(h.text()).toContain("auth: pending")
    await h.update({ state: "running", auth: "authorized", tools: 4, lastError: undefined })
    expect(h.text()).toContain("auth: authorized")
    expect(h.text()).not.toContain("Authorization URL")
    expect(h.frames.at(-1)).toHaveLength(height!)
    expect(h.text().split("\n").every((line) => textWidth(line) <= width!)).toBe(true)
    await h.key("\x03"); await h.key("\x03")
  }
})
