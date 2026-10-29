import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { SLASH_COMMANDS } from "../src/view/commands"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const asReply = (reply: unknown) => reply as CommandReply

function app(options: { remote?: boolean } = {}) {
  let stored: Record<string, unknown> = {}
  const h = appHarness({
    directory: tempDir("mendcode-sandbox-"),
    ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
    reply: (command: CommandInput) => {
      if (command.type === "settings.set") {
        stored = { ...stored, ...command.patch }
        return asReply({ ok: true, result: { settings: stored } })
      }
      if (command.type === "sandbox.status") {
        const setting = (stored.sandbox ?? {}) as { mode?: string; network?: string; writableRoots?: string[] }
        return asReply({ ok: true, result: { mode: setting.mode ?? "off", network: setting.network ?? "off", writableRoots: setting.writableRoots ?? [], enforced: setting.mode !== undefined && setting.mode !== "off", backend: "seatbelt", detail: `${setting.mode ?? "off"} through seatbelt` } })
      }
      return undefined
    },
  })
  return h
}

describe("/sandbox", () => {
  test("the command is listed", () => expect(SLASH_COMMANDS.some((command) => command.name === "sandbox")).toBe(true))

  test("bare /sandbox asks the daemon for the status and shows it", async () => {
    const h = app()
    await h.type("/sandbox\r")
    expect(h.sentOf("sandbox.status")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("sandbox off through seatbelt")
  })

  test("a mode, the toggle and the aliases write the sandbox setting", async () => {
    const h = app()
    await h.type("/sandbox workspace-write\r")
    expect(h.sentOf("settings.set").at(-1)).toEqual({ type: "settings.set", patch: { sandbox: { mode: "workspace-write" } } })
    expect(h.text().join("\n")).toContain("sandbox workspace-write, network off")
    await h.type("/sandbox read-only\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { sandbox: { mode: "read-only" } } })
    await h.type("/sandbox toggle\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { sandbox: { mode: "off" } } })
    await h.type("/sandbox on\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { sandbox: { mode: "workspace-write" } } })
  })

  test("network and extra writable paths keep the rest of the setting", async () => {
    const h = app()
    await h.type("/sandbox workspace-write\r")
    await h.type("/sandbox network on\r")
    expect(h.sentOf("settings.set").at(-1)).toEqual({ type: "settings.set", patch: { sandbox: { mode: "workspace-write", network: "on" } } })
    await h.type("/sandbox allow /opt/cache\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { sandbox: { mode: "workspace-write", network: "on", writableRoots: ["/opt/cache"] } } })
    await h.type("/sandbox deny /opt/cache\r")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { sandbox: { writableRoots: [] } } })
    const before = h.sentOf("settings.set").length
    await h.type("/sandbox allow relative/dir\r")
    expect(h.sentOf("settings.set")).toHaveLength(before)
    expect(h.text().join("\n")).toContain("absolute path")
  })

  test("a wrong argument shows the usage and changes nothing", async () => {
    const h = app()
    await h.type("/sandbox yolo\r")
    expect(h.sentOf("settings.set")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("usage: /sandbox")
  })

  test("a remote terminal does not control the sandbox", async () => {
    const h = app({ remote: true })
    await h.type("/sandbox off\r")
    await h.type("/sandbox\r")
    expect(h.sentOf("settings.set")).toHaveLength(0)
    expect(h.sentOf("sandbox.status")).toHaveLength(0)
  })
})
