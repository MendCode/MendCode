import { afterEach, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, ids, plain } from "./session-ui-harness"
import { renderMarketplacePage, createMarketplaceState } from "../src/view/marketplace-page"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("/handoff prepares a goal draft without submitting it; remote terminals refuse", async () => {
  const child = ids("session")
  const h = appHarness({ reply: (command) => command.type === "session.fork" ? { ok: true, result: { sessionId: child } } as CommandReply : undefined })
  await h.type("/handoff finish tests\r")
  expect(h.sentOf("session.fork")).toMatchObject([{ handoffGoal: "finish tests" }])
  expect(h.sentOf("user.submit")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("finish tests")
  const remote = appHarness({ remote: { host: "test.invalid", readOnly: false } })
  await remote.type("/handoff finish tests\r")
  expect(remote.sentOf("session.fork")).toHaveLength(0)
})

test("capability preview wraps into the existing detail panel at narrow and wide widths", () => {
  for (const width of [60, 120]) {
    const entry = { name: "test", version: "1", description: "test", sourceId: "local", location: "/fixture", tags: [], contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false }, state: "available" as const }
    const rows = renderMarketplacePage({ state: createMarketplaceState(), sources: [], preview: { entry, scope: "user", action: "install", problems: [], capabilities: { declared: ["network"], observed: ["tools", "hooks"], complete: false } }, error: "", width, height: 40 })
    expect(rows.map(plain).join("\n")).toContain("static hints")
    expect(rows.map(plain).join("\n")).toContain("capabilities unknown")
    for (const row of rows) expect(textWidth(plain(row))).toBeLessThanOrEqual(width)
  }
})
