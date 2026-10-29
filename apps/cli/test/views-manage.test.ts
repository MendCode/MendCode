import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { VIEW_SLOT_NAMES } from "@mendcode/extension-api/views"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { discoverExtensions } from "../src/extensions/discover"
import { scaffoldView, viewStarter } from "../src/extensions/view-scaffold"
import { parseViewCommand } from "../src/view-args"
import { readTuiProfile } from "../src/view/tui-profile"
import { appHarness, extension, scratch } from "./extensions-harness"

/** /customize > Views (list, disable, reset, scaffold) and `mendcode view`. */

const temporary: Array<{ cleanup(): void }> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })

async function open(body: string) {
  const temp = scratch()
  temporary.push(temp)
  temp.write("data/extensions/look.ts", extension("look", body))
  const h = await appHarness({ dataDir: temp.dataDir, directory: temp.project, width: 140, height: 50 })
  await h.start({ onboarded: true })
  h.message("hello there", "an answer")
  await h.type("/customize\r")
  // Rows: UI modules, Export look, then Views.
  await h.key("j")
  await h.key("j")
  return { h, temp }
}

describe("/customize > Views", () => {
  test("lists the slot, its owner and its timing; enter switches it off and on, r resets it", async () => {
    const { h, temp } = await open(`api.view("message.user", (m) => [[{ text: "USER<" + m.text + ">" }]])`)
    expect(h.app.page).toBe("customize")
    expect(h.text()).toContain("message.user")
    expect(h.text()).toContain("user look")
    await h.key("\x1b")
    expect(h.text()).toContain("USER<hello there>")
    await h.type("/customize\r")
    await h.key("j")
    await h.key("j")
    await h.key("\r")
    expect(readTuiProfile(temp.dataDir).disabledViews).toEqual(["message.user"])
    expect(h.text()).toContain("off")
    await h.key("\x1b")
    expect(h.text()).not.toContain("USER<hello there>")
    await h.type("/customize\r")
    await h.key("j")
    await h.key("j")
    await h.key("r")
    expect(readTuiProfile(temp.dataDir).disabledViews).toEqual([])
    await h.key("\x1b")
    expect(h.text()).toContain("USER<hello there>")
  })

  test("a view that tripped shows its last error", async () => {
    const { h } = await open(`api.view("message.user", () => { throw new Error("kaput") })`)
    await h.key("\x1b")
    for (let n = 0; n < 3; n++) h.message(`again ${n}`, "ok")
    await h.type("/customize\r")
    await h.key("j")
    await h.key("j")
    expect(h.text()).toContain("stopped")
    expect(h.text()).toContain("threw: kaput")
  })

  test("the New view file row writes a starter for the picked slot, which the watcher can load", async () => {
    const { h, temp } = await open(`api.view("message.user", (m) => [[{ text: "USER<" + m.text + ">" }]])`)
    await h.key("\x1b[C") // message.assistant
    await h.key("j")
    await h.key("\r")
    const file = path.join(temp.dataDir, "extensions", "view-message-assistant.ts")
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf8")).toContain('api.view("message.assistant"')
  })
})

describe("view starters", () => {
  test("every slot's starter loads, registers its slot and falls through", async () => {
    for (const slot of VIEW_SLOT_NAMES) {
      const temp = scratch()
      temporary.push(temp)
      const made = scaffoldView({ dataDir: temp.dataDir, slot })
      expect(made.ok, slot).toBe(true)
      const instance = createExtensionRuntime({ redraw() {} })
      await instance.load(discoverExtensions({ dataDir: temp.dataDir, directory: temp.project }))
      expect(instance.problems, slot).toHaveLength(0)
      expect(instance.views.has(slot), slot).toBe(true)
      instance.dispose()
    }
  })

  test("a starter is commented with the slot's rules and never overwrites a file", () => {
    const text = viewStarter("approval")
    expect(text).toContain("{options}")
    expect(text).toContain("owns their clicks")
    expect(text).not.toContain("actions: choose")
    expect(text).toContain("docs/views.md")
    const temp = scratch()
    temporary.push(temp)
    expect(scaffoldView({ dataDir: temp.dataDir, slot: "footer" }).ok).toBe(true)
    const again = scaffoldView({ dataDir: temp.dataDir, slot: "footer" })
    expect(again.ok).toBe(false)
    expect(scaffoldView({ dataDir: temp.dataDir, slot: "footer", force: true }).ok).toBe(true)
    expect(scaffoldView({ dataDir: temp.dataDir, slot: "nope" })).toMatchObject({ ok: false })
  })
})

describe("mendcode view", () => {
  const cli = path.join(import.meta.dir, "..")
  const run = (...args: string[]) => Bun.spawnSync(["bun", "./src/entry.ts", ...args], { cwd: cli, stdout: "pipe", stderr: "pipe" })

  test("parses list and scaffold and leaves other words alone", () => {
    expect(parseViewCommand(["view", "scaffold", "footer", "--dir", "/x"])).toMatchObject({ action: "scaffold", slot: "footer", dir: "/x" })
    expect(parseViewCommand(["view", "list"])).toMatchObject({ action: "list" })
    expect(parseViewCommand(["view", "the", "file"])).toBeUndefined()
    expect(parseViewCommand(["view", "scaffold"])).toMatchObject({ error: "view scaffold needs one slot" })
  })

  test("scaffold writes into the given data dir without starting a daemon; list names every slot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendcode-view-"))
    try {
      const made = run("view", "scaffold", "tool.card", "--dir", dir)
      expect(made.stderr.toString()).toBe("")
      expect(made.exitCode).toBe(0)
      expect(existsSync(path.join(dir, "extensions", "view-tool-card.ts"))).toBe(true)
      const again = run("view", "scaffold", "tool.card", "--dir", dir)
      expect(again.exitCode).toBe(1)
      expect(again.stderr.toString()).toContain("exists")
      expect(run("view", "scaffold", "nope", "--dir", dir).exitCode).toBe(1)
      const listed = run("view", "list", "--dir", dir)
      expect(listed.exitCode).toBe(0)
      for (const slot of VIEW_SLOT_NAMES) expect(listed.stdout.toString()).toContain(slot)
      expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
