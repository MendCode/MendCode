import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, plain, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

afterEach(cleanTemps)

const LONG = Array.from({ length: 60 }, (_, i) => `paragraph ${i + 1}: the quick brown fox jumps over the lazy dog and keeps on running until this line has to wrap at a narrow width`).join("\n\n")

test("scrolled to the top, a chat that lays out in fewer rows (a wider terminal) still shows its first lines, never an empty screen", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, footerDefaultRows: false, sidebar: "hidden" })
  const size = { width: 60, height: 24 }
  const h = appHarness({ dataDir, directory: tempDir(), width: size.width, height: size.height, mode: "full" })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Tell me the long story", LONG)
  h.app.render()
  for (let i = 0; i < 80; i++) await h.type("\x1b[5~")
  h.app.render()
  expect(h.text().join("\n")).toContain("Tell me the long story")
  // The terminal grows: every paragraph wraps into fewer rows, so the history is shorter than the distance scrolled from its bottom.
  h.size.width = 200
  h.size.height = 24
  h.app.render()
  const body = h.text().join("\n")
  expect(body).toContain("Tell me the long story")
  expect(body).toContain("paragraph 1:")
})
