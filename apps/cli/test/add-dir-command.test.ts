import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { SLASH_COMMANDS } from "../src/view/commands"
import { parseStartup } from "../src/startup"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const asReply = (reply: unknown) => reply as CommandReply

function app(options: { remote?: boolean } = {}) {
  const project = realpathSync(tempDir("mendcode-adddir-"))
  const extra = path.join(project, "extra")
  mkdirSync(extra, { recursive: true })
  const real = realpathSync(extra)
  let stored: Record<string, unknown> = {}
  let addDirs: string[] | undefined
  const h = appHarness({
    directory: project,
    ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
    reply: (command: CommandInput) => {
      if (command.type === "settings.set") {
        stored = { ...stored, ...command.patch }
        return asReply({ ok: true, result: { settings: stored } })
      }
      if (command.type === "session.run.configure") {
        if ("addDirs" in command) addDirs = command.addDirs ?? undefined
        return asReply({ ok: true, result: { limits: addDirs ? { addDirs } : {} } })
      }
      return undefined
    },
  })
  return { h, project, real }
}

describe("/add-dir", () => {
  test("the command is listed", () => expect(SLASH_COMMANDS.some((command) => command.name === "add-dir")).toBe(true))

  test("a path is added for this session only and listed afterwards", async () => {
    const { h, real } = app()
    await h.type(`/add-dir ${real}\r`)
    expect(h.sentOf("session.run.configure").at(-1)).toMatchObject({ addDirs: [real] })
    expect(h.sentOf("settings.set")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("extra directory for this session")
    await h.type("/add-dir\r")
    expect(h.text().join("\n")).toContain("extra · this session")
  })

  test("save keeps the directory in the additionalDirectories setting and remove drops it", async () => {
    const { h, real } = app()
    await h.type(`/add-dir save ${real}\r`)
    expect(h.sentOf("settings.set").at(-1)).toEqual({ type: "settings.set", patch: { additionalDirectories: [real] } })
    await h.type("/add-dir\r")
    expect(h.text().join("\n")).toContain("extra · saved")
    await h.type(`/add-dir remove ${real}\r`)
    expect(h.sentOf("settings.set").at(-1)).toEqual({ type: "settings.set", patch: { additionalDirectories: [] } })
    expect(h.text().join("\n")).toContain("no longer an extra directory")
  })

  test("missing paths, the project itself and bad usage change nothing", async () => {
    const { h, project } = app()
    await h.type(`/add-dir ${path.join(project, "nope")}\r`)
    expect(h.text().join("\n")).toContain("not a directory")
    await h.type(`/add-dir ${project}\r`)
    expect(h.text().join("\n")).toContain("already the project directory")
    await h.type("/add-dir save\r")
    expect(h.text().join("\n")).toContain("usage: /add-dir")
    expect(h.sentOf("session.run.configure").filter((command) => "addDirs" in command)).toHaveLength(0)
    expect(h.sentOf("settings.set")).toHaveLength(0)
  })

  test("a remote attach refuses it without sending anything", async () => {
    const { h, real } = app({ remote: true })
    await h.type(`/add-dir ${real}\r`)
    expect(h.sentOf("session.run.configure")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("local only")
  })
})

describe("--add-dir", () => {
  test("it is repeatable on the TUI and on run", () => {
    expect(parseStartup(["--add-dir", "/a", "--add-dir=/b"])).toMatchObject({ kind: "tui", addDirs: ["/a", "/b"] })
    expect(parseStartup(["run", "go", "--add-dir", "../shared"])).toMatchObject({ kind: "run", addDirs: ["../shared"] })
    expect(parseStartup(["run", "go"]).addDirs).toBeUndefined()
  })

  test("a missing value and more than 20 directories are usage errors", () => {
    expect(() => parseStartup(["run", "go", "--add-dir"])).toThrow()
    expect(() => parseStartup(["run", "go", ...Array.from({ length: 21 }, (_, index) => ["--add-dir", `/d${index}`]).flat()])).toThrow()
  })
})
