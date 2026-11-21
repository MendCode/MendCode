import { afterEach, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

/** A project command (or an extension's command, which `commands.list` reports the same way) named `mend-decide`. */
const reply = (command: { type: string }) => command.type === "commands.list" ? { ok: true as const, result: { commands: [{ name: "mend-decide", description: "decide", argumentHint: "" }] } } : undefined

async function ready() {
  const h = appHarness({ width: 100, height: 40, dataDir: tempDir(), directory: "/work/project", mode: "balanced", reply })
  h.app.applySettings({ onboarded: true })
  h.app.render()
  // Typing a `/` loads the project's commands, as it does for anyone who has opened the suggestions once.
  await h.type("/")
  await h.type("\x7f")
  return h
}

describe("a command word inside a pasted block", () => {
  test("a pasted chat that mentions /mend-decide is sent as the message, never run as that command with the whole text as its arguments", async () => {
    const h = await ready()
    const pasted = `aprueba el plan de todo-cli\nThought: run /mend-decide plan todo-cli abc123 first\n${"x".repeat(1100)}`
    await h.type("si me pregunto pero aun asi bruh: ")
    await h.type(`\x1b[200~${pasted}\x1b[201~`)
    await h.type("\r")
    expect(h.sentOf("commands.execute")).toEqual([])
    const sent = h.sentOf("user.submit") as unknown as Array<{ text: string }>
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text.startsWith("si me pregunto pero aun asi bruh: aprueba el plan")).toBe(true)
    expect(sent[0]!.text).toContain("/mend-decide plan todo-cli abc123")
  })

  test("a multi-line message with a command word inside is a message too", async () => {
    const h = await ready()
    await h.type("\x1b[200~line one\nrun /mend-decide now\nline three\x1b[201~")
    await h.type("\r")
    expect(h.sentOf("commands.execute")).toEqual([])
    expect(h.sentOf("user.submit")).toHaveLength(1)
  })

  test("a one-line message with the command word in it still runs it with the rest as arguments", async () => {
    const h = await ready()
    await h.type("explain /mend-decide this")
    await h.type("\r")
    expect(h.sentOf("commands.execute")).toMatchObject([{ name: "mend-decide", args: "explain this" }])
  })
})
