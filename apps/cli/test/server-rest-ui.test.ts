import { afterEach, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { serverRestHarness } from "./b82-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("B82 config/lifecycle events retain the terminal transcript at both evidence sizes", async () => {
  for (const [width, height] of [[100, 30], [180, 50]]) {
    const h = await serverRestHarness(width!, height!)
    h.configChanged()
    h.app.render()
    const before = h.text()
    expect(before.join("\n")).toContain("The session stays in durable storage")
    h.disposed()
    h.app.render()
    expect(h.text()).toEqual(before)
    expect(h.text()).toHaveLength(height!)
    expect(h.text().every((line) => textWidth(line) <= width!)).toBe(true)
    expect(h.sentOf("daemon.shutdown")).toHaveLength(0)
    await h.app.onKey("\x03")
  }
})
