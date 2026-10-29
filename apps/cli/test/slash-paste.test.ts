import { afterAll, expect, test } from "bun:test"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

test("split text paste and empty paste never read the image clipboard", async () => {
  const h = appHarness({ dataDir: tempDir(), directory: tempDir() })
  h.app.applySettings({ onboarded: true })
  for (const chunk of ["\x1b[20", "0~", "plain text\r\nsecond line", "\x1b[20", "1~", "\x1b[200~\x1b[201~"]) await h.type(chunk)
  expect(h.sentOf("attachment.clipboard")).toEqual([])
  expect(h.sentOf("user.submit")).toEqual([])
  expect(h.text().join("\n")).toContain("plain text")
  expect(h.text().join("\n")).toContain("second line")
  expect(h.text().join("\n")).not.toContain("201~")
})

test("split escaped image path becomes a chip with no raw path in the submitted text", async () => {
  const h = appHarness({ dataDir: tempDir(), directory: tempDir(), reply: (command) => command.type === "attachment.paste" ? { ok: true, result: { kind: "image", name: "screen shot.png", attachment: { sha256: "a".repeat(64), bytes: 12, mime: "image/png" }, width: 4, height: 3 } } : undefined })
  h.app.applySettings({ onboarded: true })
  for (const chunk of ["\x1b[200~", "/tmp/screen\\ shot.png", "\x1b[201~"]) await h.type(chunk)
  expect(h.sentOf("attachment.paste")).toHaveLength(1)
  expect(h.text().join("\n")).toContain("Image #1")
  expect(h.text().join("\n")).not.toContain("/tmp/screen")
  await h.type("\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: "[Image #1]", attachments: [{ name: "screen shot.png", label: "[Image #1]", at: 10 }] })
})

test("only the explicit clipboard action reports a missing image", async () => {
  const h = appHarness({ reply: (command) => command.type === "attachment.clipboard" ? { ok: false, error: { code: "not_found", message: "no image in the clipboard" } } : undefined })
  h.app.applySettings({ onboarded: true })
  await h.type("\x1b[200~\x1b[201~")
  expect(h.text().join("\n")).not.toContain("no image in the clipboard")
  await h.type("\x16")
  expect(h.sentOf("attachment.clipboard")).toHaveLength(1)
  expect(h.text().join("\n")).toContain("no image in the clipboard")
})

test("pasting a slash command does not try to read a local attachment", async () => {
  const h = appHarness({ dataDir: tempDir(), directory: tempDir(), reply: (command) => command.type === "attachment.paste" ? { ok: false, error: { code: "not_found", message: "not a file or directory" } } : undefined })
  h.app.applySettings({ onboarded: true })
  for (const command of ["/tier", "/compaction", "/queue", "/sessions"]) {
    await h.type(`\x1b[200~${command}\x1b[201~`)
    expect(h.sentOf("attachment.paste")).toEqual([])
    expect(h.text().join("\n")).toContain(command)
    await h.type("\x15")
  }
  await h.type("\x1b[200~/tmp/fixture.txt\x1b[201~")
  expect(h.sentOf("attachment.paste")).toHaveLength(1)
  expect(h.sentOf("attachment.paste")[0]).toMatchObject({ path: "/tmp/fixture.txt" })
})
