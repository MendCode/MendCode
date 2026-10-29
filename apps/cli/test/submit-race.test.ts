import { afterEach, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

test("a send that fails after newer text was typed leaves the newer text in the prompt", async () => {
  let fail: (reply: CommandReply) => void = () => {}
  const h = appHarness({ dataDir: tempDir(), directory: "/repo", width: 100, height: 24, reply: (command) => command.type === "user.submit" ? new Promise<CommandReply>((resolve) => { fail = resolve }) : undefined })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(15)
  await h.type("first message")
  const sending = h.app.onInput("\r")
  await Bun.sleep(5)
  await h.type("second thought")
  fail({ ok: false, error: { code: "busy", message: "[DAEMON]: busy" } })
  await sending
  await Bun.sleep(5)
  h.app.render()
  const screen = h.text().join("\n")
  expect(screen).toContain("second thought")
  expect(screen).not.toContain("first message")
})
