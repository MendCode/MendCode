import { describe, expect, test } from "bun:test"
import { followPage, type PageLink } from "../src/ui/app/page-back"
import { wheelStep } from "../src/ui/app/page-wheel"
import { petPickerKey } from "../src/view/pet-picker"
import { toolsPageKey, createToolsPageState } from "../src/view/tools-page"
import { hooksPageKey, createHooksPageState } from "../src/view/hooks-page"
import { createScreen } from "../src/ui/screen"

describe("esc goes back to the page that opened this one", () => {
  const open = (links: PageLink[], before: "settings" | "storage" | "chat", after: "settings" | "storage" | "chat" | "pet", key = "\r") => followPage({ links, before, after, key })

  test("settings -> storage -> esc returns to settings, then esc leaves", () => {
    const opened = open([], "settings", "storage")
    expect(opened).toEqual({ links: [{ parent: "settings", child: "storage" }], page: "storage" })
    const back = open(opened.links, "storage", "chat", "\x1b")
    expect(back).toEqual({ links: [], page: "settings" })
    expect(open(back.links, "settings", "chat", "\x1b").page).toBe("chat")
  })

  test("a nested page walks back one level at a time", () => {
    const first = open([], "settings", "storage")
    const second = followPage({ links: first.links, before: "storage", after: "pet", key: "\r" })
    const one = followPage({ links: second.links, before: "pet", after: "chat", key: "\x1b" })
    expect(one.page).toBe("storage")
    expect(followPage({ links: one.links, before: "storage", after: "chat", key: "\x1b" }).page).toBe("settings")
  })

  test("leaving by any other way forgets the trail", () => {
    const opened = open([], "settings", "storage")
    expect(open(opened.links, "storage", "chat", "\r")).toEqual({ links: [], page: "chat" })
  })

  test("a page opened from the chat has nowhere to go back to", () => {
    const opened = open([], "chat", "storage")
    expect(open(opened.links, "storage", "chat", "\x1b").page).toBe("chat")
  })
})

describe("the wheel scrolls every page that has rows or text", () => {
  test("stats pages page on the overview and arrow elsewhere", () => {
    expect(wheelStep({ page: "usage", usageTab: 0 })).toEqual({ up: "\x1b[5~", down: "\x1b[6~", repeat: "one" })
    expect(wheelStep({ page: "usage", usageTab: 3 })?.up).toBe("\x1b[A")
  })
  test("text pages take a notch of lines, lists a row", () => {
    expect(wheelStep({ page: "text" })?.repeat).toBe("notch")
    expect(wheelStep({ page: "storage" })?.repeat).toBe("one")
  })
  test("the chat, forms and typing get none", () => {
    expect(wheelStep({ page: "chat" })).toBeUndefined()
    expect(wheelStep({ page: "setup" })).toBeUndefined()
    expect(wheelStep({ page: "customize", typing: true })).toBeUndefined()
  })
})

describe("one way to switch things on and off", () => {
  const choices = [{ ref: "codex:a", name: "A", description: "" }, { ref: "user:b", name: "B", description: "" }]
  test("space turns the pet in use off; enter keeps the highlighted one; space with it off turns the highlighted one on", () => {
    expect(petPickerKey({ selected: 0 }, " ", choices, "codex:a").action).toEqual({ type: "choose", ref: "off" })
    expect(petPickerKey({ selected: 0 }, "\r", choices, "codex:a").action).toEqual({ type: "choose", ref: "codex:a" })
    expect(petPickerKey({ selected: 1 }, "\r", choices, "codex:a").action).toEqual({ type: "choose", ref: "user:b" })
    expect(petPickerKey({ selected: 1 }, " ", choices, "off").action).toEqual({ type: "choose", ref: "user:b" })
  })
  test("enter and space trust a project's tools and hooks like t does", () => {
    const tool = { name: "x", source: "project" as const, trusted: false, command: ["x"], description: "" }
    for (const key of ["t", " ", "\r"]) {
      expect(toolsPageKey(createToolsPageState(), key, [tool as never]).action).toEqual({ type: "trust", trusted: true })
      expect(hooksPageKey(createHooksPageState(), key, { trusted: false, hooks: [], runs: [], problems: [] } as never).action).toEqual({ type: "trust", trusted: true })
    }
  })
})

describe("a terminal that was left stays left", () => {
  test("nothing reaches it after leave, and leaving twice writes once", () => {
    const writes: string[] = []
    const screen = createScreen({ write: (data: string) => (writes.push(data), true), columns: 40, rows: 10, isTTY: true }, { MENDCODE_MOUSE: "0", MENDCODE_TERMINAL_MODE: "0" }, {})
    screen.enter()
    screen.leave()
    const left = writes.length
    screen.leave()
    screen.write("\x07")
    screen.setTitle("late")
    screen.setCursorShape("block")
    screen.resize(50, 12)
    screen.draw([[{ text: "late frame" }]])
    expect(writes.length).toBe(left)
    expect(writes.join("").match(/\x1b\[\?1049l/g)).toHaveLength(1)
  })
})

describe("esc and the wheel inside the app", () => {
  const { createIdFactory } = require("@mendcode/protocol") as typeof import("@mendcode/protocol")
  const { createApp } = require("../src/ui/app") as typeof import("../src/ui/app")
  const { glyphs } = require("../src/ui/theme") as typeof import("../src/ui/theme")
  const { SETTINGS_GROUPS } = require("../src/view/settings-page") as typeof import("../src/view/settings-page")
  const ids = createIdFactory()
  const report = { dbBytes: 1024 ** 3, walBytes: 0, blobBytes: 2 * 1024 ** 3, blobs: 10, orphanBlobs: 0, orphanBytes: 0, sessions: 5, events: 500, eventBytes: 500 * 1024 ** 2, engineBytes: 0, otherBytes: 0, freeBytes: 0, autoVacuum: "incremental", topSessions: [] }

  async function harness() {
    const frames: Array<Array<Array<{ text: string }>>> = []
    const screen = { size: { width: 100, height: 40 }, draw: (rows: never) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const app = createApp({
      sessionId: ids("session"), screen,
      send: async (command: Record<string, unknown>) => {
        if (command.type === "storage.report") return { ok: true, result: report }
        if (command.type === "settings.get") return { ok: true, result: { settings: {} } }
        return { ok: true }
      },
      exit() {}, schedule: (fn: () => void) => fn(), glyphs: glyphs({}), now: () => 1_800_000_000_000,
    } as never)
    const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join("")).join("\n")
    return { app, text }
  }

  test("settings -> disk usage -> esc is settings again, and esc once more is the chat", async () => {
    const { app, text } = await harness()
    for (const key of "/settings") await app.onKey(key)
    await app.onKey("\r")
    const rows = SETTINGS_GROUPS.flatMap((group) => group.rows)
    for (let i = 0; i < rows.findIndex((row) => row.id === "storage"); i++) await app.onKey("\x1b[B")
    await app.onKey("\r")
    await Bun.sleep(5)
    expect(text()).toContain("on disk")
    await app.onKey("\x1b")
    expect(text()).toContain("disk usage")
    expect(text()).not.toContain("on disk")
    await app.onKey("\x1b")
    expect(text()).not.toContain("disk usage")
  })

  test("the wheel moves the settings rows and the disk usage page", async () => {
    const { app, text } = await harness()
    for (const key of "/settings") await app.onKey(key)
    await app.onKey("\r")
    const before = text()
    await app.onKey("\x1b[<65;10;10M")
    expect(text()).not.toBe(before)
  })
})

describe("path arguments complete from disk", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const { join } = require("node:path") as typeof import("node:path")
  const { pathMatches } = require("../src/view/path-arguments") as typeof import("../src/view/path-arguments")
  const { slashSuggestions } = require("../src/view/commands") as typeof import("../src/view/commands")
  const base = mkdtempSync(join(tmpdir(), "page-nav-cd-"))
  mkdirSync(join(base, "src", "inner"), { recursive: true })
  mkdirSync(join(base, "docs"))
  mkdirSync(join(base, ".hidden"))
  writeFileSync(join(base, "readme.md"), "")

  test("cd lists directories only, hidden ones after a dot, and walks into a typed directory", () => {
    expect(pathMatches({ command: "cd", args: "", base }).map((m) => m.name)).toEqual(["cd docs/", "cd src/"])
    expect(pathMatches({ command: "cd", args: "s", base }).map((m) => m.name)).toEqual(["cd src/"])
    expect(pathMatches({ command: "cd", args: ".", base }).map((m) => m.name)).toEqual(["cd .hidden/"])
    expect(pathMatches({ command: "cd", args: "src/", base }).map((m) => m.name)).toEqual(["cd src/inner/"])
  })
  test("attach also offers files; a remote terminal and other commands offer none", () => {
    expect(pathMatches({ command: "attach", args: "r", base }).map((m) => m.name)).toEqual(["attach readme.md"])
    expect(pathMatches({ command: "cd", args: "", base: undefined })).toEqual([])
    expect(pathMatches({ command: "goal", args: "", base })).toEqual([])
  })
  test("the slash suggestions carry the path flag so Tab writes the path without a space", () => {
    const [first] = slashSuggestions("/cd s", [], undefined, [], base)
    expect(first?.name).toBe("cd src/")
    expect(first?.argument).toEqual({ more: false, path: true })
  })
})
