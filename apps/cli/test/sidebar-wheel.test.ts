import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply, SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const MINUTE = 60_000

const wheel = (button: number, col: number, row: number) => `\x1b[<${button};${col + 1};${row + 1}M`
const down = (col: number, row: number) => wheel(65, col, row)
const up = (col: number, row: number) => wheel(64, col, row)
const swipeLeft = (col: number, row = 10) => wheel(66, col, row)
const swipeRight = (col: number, row = 10) => wheel(67, col, row)

const REPOS = Array.from({ length: 24 }, (_, n) => `/repos/r${String(n).padStart(2, "0")}`)

/** The open chat with a long answer, and a sidebar longer than the screen: 24 projects (every project lists) or 40 chats of one folder (the classic list). */
function chatApp({ multi, profile = {}, height = 18 }: { multi: boolean; profile?: Partial<TuiProfile>; height?: number }) {
  const clock = { at: NOW }
  const current = ids("session")
  const make = (directory: string, title: string, age: number): SessionSummary => ({ sessionId: ids("session"), title, directory, createdAt: NOW - age, updatedAt: NOW - age, lastSeq: 0, state: "idle", queued: 0 }) as SessionSummary
  const sessions: SessionSummary[] = [
    { sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW - MINUTE, updatedAt: NOW - MINUTE, lastSeq: 0, state: "idle", queued: 0 } as SessionSummary,
    ...(multi ? REPOS.map((directory, n) => make(directory, `chat ${n}`, (n + 2) * MINUTE)) : Array.from({ length: 40 }, (_, n) => make("/work/app", `chat ${String(n).padStart(2, "0")}`, (n + 2) * MINUTE))),
  ]
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebarProjectCount: 30, ...profile })
  const h = appHarness({
    width: 120, height, mode: "balanced", sessionId: current, dataDir, directory: "/work/app", now: () => clock.at,
    inspectProject: async () => ({ git: true }),
    reply: (command: CommandInput) => {
      if (command.type === "session.list") return reply({ sessions })
      if (command.type === "bot.list") return reply({ bots: [], external: [], problems: [] })
      return undefined
    },
  })
  h.app.applySettings(multi ? { experimental: { bots: true } } : {})
  const lines = Array.from({ length: 60 }, (_, i) => `answer line ${i + 1}`).join("\n\n")
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", lines)
  return { ...h, clock, sessions }
}
type App = ReturnType<typeof chatApp>

async function settled(h: App, needle: string) {
  for (let turn = 0; turn < 100; turn++) {
    h.app.render()
    if (h.text().join("\n").includes(needle)) return
    await Bun.sleep(5)
  }
  throw new Error(`never drew ${needle}:\n${h.text().join("\n")}`)
}
const side = (h: App, right = false) => h.text().map((row) => right ? row.slice(-SIDEBAR_WIDTH) : row.slice(0, SIDEBAR_WIDTH)).join("\n")
const chatSide = (h: App) => h.text().map((row) => row.slice(SIDEBAR_WIDTH + 1)).join("\n")
const shown = (h: App) => h.text().some((row) => row.includes("Sessions"))
const flick = async (h: App, key: (col: number) => string, col: number, count: number, gap = 30) => {
  for (let n = 0; n < count; n++) {
    h.clock.at += gap
    await h.app.onKey(key(col))
  }
  h.app.render()
}

for (const multi of [true, false]) {
  const kind = multi ? "projects and bots list" : "classic list"
  describe(`the wheel over the ${kind}`, () => {
    test("scrolls the list and leaves the chat where it was", async () => {
      const h = chatApp({ multi })
      await settled(h, multi ? "chat 1" : "chat 00")
      const listBefore = side(h)
      const chatBefore = chatSide(h)
      expect(listBefore).toContain("more")
      for (let n = 0; n < 4; n++) await h.app.onKey(down(5, 8))
      h.app.render()
      expect(side(h)).not.toBe(listBefore)
      expect(side(h)).toContain("↑")
      expect(chatSide(h)).toBe(chatBefore)
    })

    test("wheel up brings the rows back and stops at the first row", async () => {
      const h = chatApp({ multi })
      await settled(h, multi ? "chat 1" : "chat 00")
      const first = side(h)
      for (let n = 0; n < 4; n++) await h.app.onKey(down(5, 8))
      for (let n = 0; n < 30; n++) await h.app.onKey(up(5, 8))
      h.app.render()
      expect(side(h)).toBe(first)
    })

    test("stops at the last row and a wheel back moves at once", async () => {
      const h = chatApp({ multi })
      await settled(h, multi ? "chat 1" : "chat 00")
      for (let n = 0; n < 80; n++) await h.app.onKey(down(5, 8))
      h.app.render()
      const end = side(h)
      expect(end).not.toContain("↓")
      await h.app.onKey(up(5, 8))
      h.app.render()
      expect(side(h)).not.toBe(end)
    })

    test("scrolls the chat, not the list, when the pointer is over the chat", async () => {
      const h = chatApp({ multi })
      await settled(h, multi ? "chat 1" : "chat 00")
      const listBefore = side(h)
      const chatBefore = chatSide(h)
      await h.app.onKey(up(60, 8))
      h.app.render()
      expect(side(h)).toBe(listBefore)
      expect(chatSide(h)).not.toBe(chatBefore)
    })

    test("a list on the right takes the wheel at its own columns", async () => {
      const h = chatApp({ multi, profile: { sidebarSide: "right" } })
      await settled(h, multi ? "chat 1" : "chat 00")
      const listBefore = side(h, true)
      const chatBefore = h.text().map((row) => row.slice(0, 80)).join("\n")
      for (let n = 0; n < 4; n++) await h.app.onKey(down(110, 8))
      h.app.render()
      expect(side(h, true)).not.toBe(listBefore)
      expect(h.text().map((row) => row.slice(0, 80)).join("\n")).toBe(chatBefore)
    })
  })
}

describe("a sideways swipe", () => {
  test("does nothing to the list, open or hidden: /sidebar opens and closes it", async () => {
    const open = chatApp({ multi: false })
    await settled(open, "chat 00")
    await flick(open, swipeLeft, 5, 12)
    await flick(open, swipeLeft, 60, 12)
    expect(shown(open)).toBe(true)
    const hidden = chatApp({ multi: false, profile: { sidebar: "hidden" } })
    await settled(hidden, "answer line")
    await flick(hidden, swipeRight, 60, 12)
    expect(shown(hidden)).toBe(false)
    expect(hidden.app.tuiProfile.sidebar).toBe("hidden")
  })
})

describe("the wheel over the list drawn beside a page", () => {
  test("scrolls the list, and the page keeps its place", async () => {
    const h = chatApp({ multi: false, height: 30 })
    await settled(h, "chat 00")
    await h.type("/help\r")
    h.app.render()
    expect(h.app.page).not.toBe("chat")
    const listBefore = side(h)
    const pageBefore = chatSide(h)
    expect(listBefore).toContain("more")
    for (let n = 0; n < 4; n++) await h.app.onKey(down(5, 8))
    h.app.render()
    expect(side(h)).not.toBe(listBefore)
    expect(chatSide(h)).toBe(pageBefore)
  })
})
