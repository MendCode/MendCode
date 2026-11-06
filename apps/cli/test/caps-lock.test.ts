import { describe, expect, test } from "bun:test"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { foldLetter } from "../src/ui/caps-lock"
import { translateKey } from "../src/ui/keyboard-protocol"
import { settingsPageKey, type SettingsValues } from "../src/view/settings-page"
import { createIdFactory } from "@mendcode/protocol"

const ids = createIdFactory({ now: () => 1_700_000_000_000, random: (size) => new Uint8Array(size).fill(1) })
const values = { settings: {}, theme: "mend", view: "balanced", reducedMotion: false } as unknown as SettingsValues
const press = (state: { row: number; typing?: string }, key: string) => settingsPageKey(state, key, values, { themes: ["mend"] })

test("Caps Lock letters arrive as capitals in both keyboard encodings", () => {
  // kitty: Caps Lock is modifier bit 64 (reported as 65) and the text field carries the capital.
  expect(translateKey("\x1b[113;65;81u")).toBe("Q")
  expect(translateKey("\x1b[113;2;81u")).toBe("Q")
  expect(foldLetter("Q")).toBe("q")
  expect(foldLetter("q")).toBe("q")
  expect(foldLetter("\x1b[A")).toBe("\x1b[A")
  expect(foldLetter("QQ")).toBe("QQ")
})

test("settings: capital Q closes, J and K move, L and H change a value", () => {
  expect(press({ row: 0 }, "Q").action).toEqual({ type: "close" })
  expect(press({ row: 0 }, "J").state.row).toBe(1)
  expect(press({ row: 3 }, "K").state.row).toBe(2)
  expect(press({ row: 1 }, "L").action).toEqual(press({ row: 1 }, "l").action)
  expect(press({ row: 1 }, "H").action).toEqual(press({ row: 1 }, "h").action)
})

test("settings: while typing a number the capital stays a typed character", () => {
  const typing = press({ row: 0, typing: "200" }, "K")
  expect(typing.action).not.toEqual({ type: "close" })
})

test("a capital Q closes the tools page opened from the prompt", async () => {
  const frames: Line[][] = []
  const app = createApp({ sessionId: ids("session"), directory: "/project", mode: "balanced", exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}),
    screen: { size: { width: 100, height: 30 }, draw: (rows: Line[]) => frames.push(rows) } as never,
    send: (async () => ({ ok: true, result: { tools: [], issues: [], directory: "/project" } })) as never,
  })
  const text = () => frames.slice(-1).flat().map((line) => line.map((span) => span.text).join("")).join("\n")
  await app.onInput("/tools"); await app.onKey("\r"); await Bun.sleep(5)
  expect(text()).toMatch(/tools/i)
  await app.onKey("Q"); await Bun.sleep(5)
  expect(text()).not.toMatch(/tools/i)
})

describe("Caps Lock across the pages", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs")
  const { CAPS_PAGES, foldForPage } = require("../src/ui/app/caps-pages") as typeof import("../src/ui/app/caps-pages")
  const pages = [...readFileSync(new URL("../src/ui/app/context.ts", import.meta.url), "utf8").match(/export type Page = ([^\n]+)/)![1]!.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]!)
  /** Pages left as typed, each for a reason: a text field of its own, capitals tied to no single mode, or not a page of shortcuts. */
  const AS_TYPED = new Set(["chat", "file", "sessions", "memory", "skills", "variants", "model-picker", "setup", "theme", "extension", "customize", "settings", "connect", "diagram", "sidebar", "memory-assistant", "plan-review", "prompt-mode", "compaction", "agent-commands", "worktrees", "warp", "git-commit", "git-pr", "git-init", "marketplace", "intro", "reviews", "changes", "console", "share", "keymap", "terminal-setup", "tutorial", "stash", "drafts", "mflow"])
  const fake = (page: string) => ({ page, historyState: { editing: false }, queueState: { edit: undefined }, usageState: { weatherInput: undefined }, loopsState: { form: undefined }, acpState: { form: undefined }, environmentPage: undefined }) as never

  test("every page is either folded or listed as read as typed", () => {
    expect(pages.length).toBeGreaterThan(50)
    for (const page of pages) expect([page, page in CAPS_PAGES || AS_TYPED.has(page)]).toEqual([page, true])
    for (const page of Object.keys(CAPS_PAGES)) expect([page, pages.includes(page)]).toEqual([page, true])
    for (const page of AS_TYPED) expect([page, page in CAPS_PAGES, pages.includes(page)]).toEqual([page, false, true])
  })

  test("a folded page reads every capital as its letter, except the capitals it keeps", () => {
    for (const [page, rule] of Object.entries(CAPS_PAGES)) {
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const kept = rule.keep?.includes(letter) ?? false
        expect([page, letter, foldForPage(fake(page), letter)]).toEqual([page, letter, kept ? letter : letter.toLowerCase()])
      }
      expect(foldForPage(fake(page), "q")).toBe("q")
      expect(foldForPage(fake(page), "\x1b[A")).toBe("\x1b[A")
      expect(foldForPage(fake(page), "1")).toBe("1")
    }
  })

  test("a page left as typed keeps the capital", () => {
    for (const page of AS_TYPED) expect(foldForPage(fake(page), "Q")).toBe("Q")
  })

  test("while a text field of the page is open the capital stays a capital", () => {
    const typing = { history: { historyState: { editing: true } }, queue: { queueState: { edit: { text: "" } } }, usage: { usageState: { weatherInput: "" } }, loops: { loopsState: { form: {} } }, acp: { acpState: { form: {} } }, env: { environmentPage: { edit: {} } } } as Record<string, object>
    for (const [page, fields] of Object.entries(typing)) expect(foldForPage({ ...fake(page), ...fields } as never, "K")).toBe("K")
  })
})
