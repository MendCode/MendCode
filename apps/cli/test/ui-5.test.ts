import { afterEach, expect, test } from "bun:test"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { textWidth } from "../src/view/wrap"
import { cleanTemps, appHarness, tempDir } from "./session-ui-harness"
import { ui4Harness } from "./ui-4-harness"
import { UI5_PAGES, UI5_RELAID, ui5Harness } from "./ui-5-harness"

afterEach(cleanTemps)

const quit = async (h: ReturnType<typeof appHarness>) => {
  await h.app.onKey("\x1b")
  await h.app.onKey("\x03")
  await h.app.onKey("\x03")
}

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [220, 60]] as const) {
  test(`UI-5 app pages fit ${width}×${height} with local data`, async () => {
    const h = ui5Harness(width, height)
    try {
      await h.type("/usage\r")
      expect(h.text().join("\n")).toContain("2026-09-30")
      expect(h.text().join("\n")).toContain("AI 0s · Tools 0s")
      await h.app.onKey("\x1b[D")
      h.app.render()
      expect(h.text().join("\n")).toContain("2026-09-29")
      expect(h.text().join("\n")).toContain("AI 12s · Tools 4s")
      await h.app.onKey("\x1b[H")
      h.app.render()
      expect(h.frames.at(-1)!.flat().filter((span) => span.text === "▣ ")).toHaveLength(1)
      await h.app.onKey("\x1b")
      for (const page of UI5_PAGES) {
        await h.type(`/${page}\r`)
        expect(h.text()).toHaveLength(height)
        for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width)
        if (width >= 110 && UI5_RELAID.includes(page as typeof UI5_RELAID[number])) expect(h.text().join("\n")).toContain("┌─")
        await h.app.onKey("\x1b")
      }
    } finally { await quit(h) }
  }, 15_000)
}

test("Usage clock can be disabled and persists in an isolated terminal profile", async () => {
  const h = ui5Harness(220, 60)
  try {
    await h.type("/usage\r")
    await h.app.onKey("c")
    for (let i = 0; i < 4; i++) await h.app.onKey("\x1b[B")
    await h.app.onKey("\r")
    await h.app.onKey("\x1b")
    expect(h.text().join("\n")).toContain("┌─ Clock")
    await h.app.onKey("\x1b")
    await h.type("/customize\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("usageClock"); i++) await h.app.onKey("\x1b[B")
    await h.app.onKey(" ")
    await h.app.onKey("\x1b")
    await h.type("/usage\r")
    expect(h.text().join("\n")).not.toContain("┌─ Clock")
  } finally { await quit(h) }
})

test("a diagram notice cannot leak into another page's footer", async () => {
  const h = appHarness({ dataDir: tempDir("mend-ui5-notice-") })
  try {
    await h.type("/diagram\r")
    await h.type("/help\r")
    expect(h.text().slice(-3).join("\n")).not.toContain("no diagram")
  } finally { await quit(h) }
})


test("sidebar widgets use three rows each, with open card rules and rails", async () => {
  for (const width of [60, 160]) {
    const h = ui4Harness(width, 45, [{ type: "text", title: "First", options: { text: "One" } }, { type: "text", title: "Second", options: { text: "Two" } }])
    try {
      if (width < 110) await h.app.onKey("\x1b]")
      h.app.render()
      const rows = h.text()
      const first = rows.findIndex((row) => row.includes("First"))
      const second = rows.findIndex((row) => row.includes("Second"))
      expect(second - first).toBe(3)
      expect(rows[first]).toContain("─ First")
      expect(rows[first]).not.toContain("┌")
      expect(rows[first + 1]).toContain("▏ One")
    } finally { await quit(h) }
  }
})
