import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply, SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { CLICK_GUARD_MS } from "../src/view/sidebar-window"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000
const click = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`

/** The open chat "Chrome" with a second chat "Other work" of the same folder in the list. */
function app({ profile = {}, width = 120 }: { profile?: Partial<TuiProfile>; width?: number } = {}) {
  const clock = { at: NOW }
  const current = ids("session")
  const other = ids("session")
  const sessions = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW - MINUTE, lastSeq: 0, state: "idle", queued: 0 },
    { sessionId: other, title: "Other work", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 10 * MINUTE, lastSeq: 0, state: "idle", queued: 0 },
  ] as SessionSummary[]
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile })
  const h = appHarness({
    width, height: 30, mode: "balanced", sessionId: current, dataDir, directory: "/work/app", now: () => clock.at,
    inspectProject: async () => ({ git: true }),
    reply: (command: CommandInput) => {
      if (command.type === "session.list") return reply({ sessions })
      if (command.type === "session.get") return reply({ session: sessions.find((session) => session.sessionId === (command as { sessionId: string }).sessionId) })
      return undefined
    },
  })
  h.app.applySettings({})
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, clock, current, other }
}
type App = ReturnType<typeof app>
const side = (h: App) => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH)).join("\n")
const rowOf = (h: App, needle: string) => h.text().findIndex((row) => row.slice(0, SIDEBAR_WIDTH).includes(needle))
async function until(h: App, needle: string) {
  for (let turn = 0; turn < 80; turn++) {
    h.app.render()
    if (side(h).includes(needle)) return
    await Bun.sleep(5)
  }
  throw new Error(`never drew ${needle}:\n${side(h)}`)
}

describe("the session list stays on every page", () => {
  for (const command of ["/help", "/settings", "/tools"]) {
    test(`${command} draws beside the list, in the width that is left, and nothing runs wider than the screen`, async () => {
      const h = app()
      await until(h, "Other work")
      await h.type(`${command}\r`)
      await until(h, "Other work")
      expect(h.app.page).not.toBe("chat")
      for (const row of h.frames.at(-1)!) expect(textWidth(plain(row))).toBeLessThanOrEqual(120)
      // The page's own text starts after the list.
      expect(h.text().some((row) => row.slice(SIDEBAR_WIDTH + 1).trim().length > 0)).toBe(true)
    })
  }

  test("a click on a chat in the list opens it from a page, and the page's own keys still work", async () => {
    const h = app()
    await until(h, "Other work")
    await h.type("/help\r")
    await until(h, "Other work")
    const page = h.app.page
    await h.type("\x1b[B")
    expect(h.app.page).toBe(page)
    h.clock.at += CLICK_GUARD_MS + 50
    h.app.render()
    await h.type(click(4, rowOf(h, "Other work")))
    expect(h.app.sessionId).toBe(h.other)
  })

  test("the list can sit on the right of a page", async () => {
    const h = app({ profile: { sidebarSide: "right" } })
    await h.type("/help\r")
    for (let turn = 0; turn < 40 && !h.text().some((row) => row.slice(-SIDEBAR_WIDTH).includes("Other work")); turn++) {
      h.app.render()
      await Bun.sleep(5)
    }
    expect(h.text().some((row) => row.slice(-SIDEBAR_WIDTH).includes("Other work"))).toBe(true)
  })

  test("a terminal too narrow for the list keeps the page whole", async () => {
    const narrow = app({ width: 60 })
    await narrow.type("/help\r")
    expect(narrow.text().join("\n")).not.toContain("Other work")
  })
})
