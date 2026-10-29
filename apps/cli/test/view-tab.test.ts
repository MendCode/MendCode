import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

describe("tab cycles the view", () => {
  test("tab on an empty prompt steps minimal → balanced → full → minimal and saves each view", async () => {
    const h = appHarness({ width: 100, height: 30, mode: "minimal", sessionId: ids("session"), dataDir: tempDir() })
    await h.app.start()
    for (const expected of ["balanced", "full", "minimal"]) {
      await h.app.onKey("\t")
      expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { view: expected } })
    }
    expect(h.sentOf("settings.set")).toHaveLength(3)
  })

  test("with text in the prompt tab is the prompt's own: the view stays", async () => {
    const h = appHarness({ width: 100, height: 30, mode: "balanced", sessionId: ids("session"), dataDir: tempDir() })
    await h.app.start()
    await h.type("hello")
    await h.app.onKey("\t")
    expect(h.sentOf("settings.set")).toEqual([])
  })
})
