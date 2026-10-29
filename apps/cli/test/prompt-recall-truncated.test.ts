import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

test("recalling a capped long prompt puts it in the prompt and says it was truncated", async () => {
  const capped = `${"word ".repeat(100)}\n… [truncated: 48213 chars, first 15920 kept]`
  const h = appHarness({ dataDir: tempDir(), directory: "/repo", reply: (command) => (command.type === "prompt.history" ? { ok: true, result: { prompts: [capped, "short one"] } } : undefined) })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  await h.type("\x1b[A")
  expect(h.app.editor.text).toBe(capped)
  expect(h.text().join("\n")).toContain("truncated prompt, 48213 chars originally")
})

test("recalling an ordinary prompt shows no truncation notice", async () => {
  const h = appHarness({ dataDir: tempDir(), directory: "/repo", reply: (command) => (command.type === "prompt.history" ? { ok: true, result: { prompts: ["short one"] } } : undefined) })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  await h.type("\x1b[A")
  expect(h.app.editor.text).toBe("short one")
  expect(h.text().join("\n")).not.toContain("truncated prompt")
})
