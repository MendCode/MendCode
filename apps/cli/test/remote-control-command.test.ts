import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { SLASH_COMMANDS } from "../src/view/commands"
import { removedAliasHint } from "../src/view/slash-aliases"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const asReply = (reply: unknown) => reply as CommandReply

function app(options: { remote?: boolean; enabled?: boolean; running?: boolean; error?: string; token?: boolean } = {}) {
  const directory = tempDir("mendcode-remote-control-")
  const report = (enabled: boolean) => ({ telegram: { enabled, tokenConfigured: options.token !== false, running: enabled && options.running !== false, botName: "mend_bot", chats: enabled ? [{ id: "7", name: "Ana", directory, pairedAt: 1 }] : [], ...(options.error ? { error: options.error } : {}) } })
  const h = appHarness({
    directory,
    ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
    reply: (command: CommandInput) => {
      if (command.type === "channels.status") return asReply({ ok: true, result: report(options.enabled === true) })
      if (command.type === "channels.change") {
        if (command.change.action === "pair") return asReply({ ok: true, result: { ...report(true), pairing: { code: "ABCD2345", expiresAt: Date.now() + 600_000 } } })
        return asReply({ ok: true, result: report(command.change.action === "enable") })
      }
      return undefined
    },
  })
  return { h, directory }
}

describe("/remote-control", () => {
  test("the command is listed and /pair is not its alias (it is the Telegram chat's own command)", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "remote-control")
    expect(command?.aliases).toEqual([])
  })

  test("bare command shows the state and how to set up when off", async () => {
    const { h } = app({ token: false })
    await h.type("/remote-control\r")
    expect(h.sentOf("channels.status")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("MENDCODE_TELEGRAM_TOKEN")
  })

  test("on and off send the change and show the result", async () => {
    const { h } = app()
    await h.type("/remote-control on\r")
    expect(h.sentOf("channels.change").at(-1)).toMatchObject({ change: { action: "enable" } })
    expect(h.text().join("\n")).toContain("remote control on as @mend_bot")
    await h.type("/remote-control off\r")
    expect(h.sentOf("channels.change").at(-1)).toMatchObject({ change: { action: "disable" } })
    expect(h.text().join("\n")).toContain("remote control off")
  })

  test("pair asks for a code in this project and shows the instruction; /pair here says where the command went", async () => {
    const { h, directory } = app()
    await h.type("/remote-control pair\r")
    expect(h.sentOf("channels.change").at(-1)).toMatchObject({ change: { action: "pair", directory } })
    expect(h.text().join("\n")).toContain("send /pair ABCD2345 to @mend_bot")
    // /pair is no command: the menu finds /remote-control by its summary (it says "Pair"), and the hint names where the word went.
    await h.type("/pair")
    expect(h.text().join("\n")).toContain("/remote-control")
    expect(h.sentOf("channels.change")).toHaveLength(1)
    expect(removedAliasHint("/pair")).toBe("/pair is now /remote-control")
  })

  test("unpair takes an optional chat id; a wrong argument shows the usage", async () => {
    const { h } = app()
    await h.type("/remote-control unpair 7\r")
    expect(h.sentOf("channels.change").at(-1)).toMatchObject({ change: { action: "unpair", chatId: "7" } })
    await h.type("/remote-control unpair\r")
    expect(h.sentOf("channels.change").at(-1)).toEqual(expect.objectContaining({ change: { action: "unpair" } }))
    const before = h.sentOf("channels.change").length
    await h.type("/remote-control nonsense\r")
    expect(h.sentOf("channels.change")).toHaveLength(before)
    expect(h.text().join("\n")).toContain("usage: /remote-control")
  })

  test("an enabled bridge that is not connected shows the reason", async () => {
    const { h } = app({ enabled: true, running: false, error: "no bot token" })
    await h.type("/remote-control\r")
    expect(h.text().join("\n")).toContain("not connected: no bot token")
  })

  test("a remote terminal does not control the bridge", async () => {
    const { h } = app({ remote: true })
    await h.type("/remote-control on\r")
    await h.type("/remote-control\r")
    expect(h.sentOf("channels.change")).toHaveLength(0)
    expect(h.sentOf("channels.status")).toHaveLength(0)
  })
})
