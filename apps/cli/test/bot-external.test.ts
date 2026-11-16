import { describe, expect, test } from "bun:test"
import type { BotInfo, BotListReport } from "@mendcode/protocol"
import { glyphSet } from "../src/ui/theme"
import type { Line } from "../src/ui/theme"
import { createBotCard } from "../src/view/bot-card-page"
import { botListText } from "../src/view/bot"
import { externalBotId, externalBotOf, multiStops, renderMultiSidebar, type MultiInput } from "../src/view/sidebar-multi"
import { plain } from "./session-ui-harness"

const NOW = new Date(2026, 10, 16, 15, 0).getTime()
const lines = (rows: readonly Line[]) => rows.map((row) => row.map((span) => span.text).join(""))
const report: BotListReport = {
  bots: [],
  external: [
    { origin: "hermes", id: "ada", name: "Ada", state: "working", model: "gpt-6.1-sol", chat: "acp:hermes-ada", app: "Desk Agent", identity: { origin: "hermes" } },
    { origin: "other", id: "x", name: "Listed only", state: "idle" },
  ],
  problems: [],
}
const input: MultiInput = { sessions: [], current: "", directory: "/work/app", focused: true, height: 30, now: NOW, bots: report, sections: ["bots"], scope: "all", icons: false, open: new Map(), glyphs: glyphSet("unicode") }

describe("external bots in the sidebar", () => {
  test("one a connector can chat with is a row to pick; one it cannot stays a plain line", () => {
    const opened = { ...input, open: new Map([["xgroup:hermes", true], ["xgroup:other", true]]) }
    expect(multiStops(opened)).toEqual(["xgroup:hermes", externalBotId({ origin: "hermes", id: "ada" }), "xgroup:other"])
    const rows = renderMultiSidebar({ ...opened, selected: externalBotId({ origin: "hermes", id: "ada" }) }).rows.map(plain)
    expect(rows.find((row) => row.includes("Ada"))).toMatch(/● working/)
    expect(rows.find((row) => row.includes("Listed only"))).toMatch(/◌ idle/)
    expect(rows.join("\n")).toContain("↵ chat  o page")
  })

  describe("the bots of one app share a foldable row", () => {
    const hermes = Array.from({ length: 23 }, (_, n) => ({ origin: "hermes", id: `b${n}`, name: `Bot ${String(n).padStart(2, "0")}`, state: "idle" as const, chat: `acp:hermes-b${n}` }))
    const many: MultiInput = { ...input, bots: { bots: [], external: hermes, problems: [] } }
    const rowsOf = (over: Partial<MultiInput> = {}) => renderMultiSidebar({ ...many, ...over }).rows.map(plain)

    test("folded by default: one row with the count, and no bot under it while none has a recent chat", () => {
      const rows = rowsOf().join("\n")
      expect(rows).toMatch(/▸ hermes · 23/)
      expect(rows).not.toContain("Bot 00")
      expect(multiStops(many)).toEqual(["xgroup:hermes"])
    })

    test("opened, every bot lists; a bot working or with a chat of the last day shows under the folded row", () => {
      expect(multiStops({ ...many, open: new Map([["xgroup:hermes", true]]) })).toHaveLength(24)
      const busy = hermes.map((bot) => bot.id === "b7" ? { ...bot, state: "working" as const } : bot)
      const recent = { sessionId: "s1", title: "Hello", directory: "/work/app", state: "idle", queued: 0, updatedAt: NOW - 60_000, model: { model: "acp:hermes-b3" } }
      const stale = { sessionId: "s2", title: "Old", directory: "/work/app", state: "idle", queued: 0, updatedAt: NOW - 3 * 86_400_000, model: { model: "acp:hermes-b4" } }
      const rows = rowsOf({ bots: { bots: [], external: busy, problems: [] }, sessions: [recent, stale] as never }).join("\n")
      expect(rows).toContain("Bot 07")
      expect(rows).toContain("Bot 03")
      expect(rows).not.toContain("Bot 04")
    })
  })

  describe("chats with a bot of another app", () => {
    const withChats: BotListReport = { bots: [], external: [{ origin: "hermes", id: "ada", name: "Ada", state: "working", chat: "acp:hermes-ada", projects: [{ directory: "/work/app", state: "working", sessions: [{ sessionId: "s1" as never, title: "Plan the week", status: "running", updatedAt: NOW }] }] }], problems: [] }
    const full: MultiInput = { ...input, sessions: [{ sessionId: "s1", title: "Plan the week", directory: "/work/app", state: "generating", queued: 0, updatedAt: NOW, model: { model: "acp:hermes-ada" } }, { sessionId: "s2", title: "Plain one", directory: "/work/app", state: "idle", queued: 0, updatedAt: NOW - 60_000 }] as never, bots: withChats, sections: ["projects", "bots"], current: "s2", open: new Map([["xgroup:hermes", true]]), projects: { isProject: () => true, count: 5 } }

    test("a `chats` row under the bot lists them and the chat never shows under Projects", () => {
      expect(renderMultiSidebar({ ...full, height: 40 }).rows.map(plain).join("\n")).toContain("▸ chats")
      const rows = renderMultiSidebar({ ...full, height: 40, open: new Map([["xgroup:hermes", true], ["xbot:hermes:ada", true]]) }).rows.map(plain).join("\n")
      expect(rows).toContain("▾ chats")
      const bots = rows.slice(rows.indexOf("Bots"))
      const projects = rows.slice(rows.indexOf("Projects"), rows.indexOf("Bots") > rows.indexOf("Projects") ? rows.indexOf("Bots") : undefined)
      expect(rows.match(/Plan the week/g)).toHaveLength(1)
      expect(projects).not.toContain("Plan the week")
      expect(projects).toContain("Plain one")
      expect(bots).toBeDefined()
      expect(multiStops({ ...full, open: new Map([["xgroup:hermes", true], ["xbot:hermes:ada", true]]) })).toContain("s1")
    })

    test("a chat on the bot's model counts as its chat before any list holds it, and so does one the terminal started", () => {
      const bare: BotListReport = { ...withChats, external: [{ ...withChats.external[0]!, projects: [] }] }
      const byModel = multiStops({ ...full, bots: bare, open: new Map([["xgroup:hermes", true], ["xbot:hermes:ada", true]]) })
      expect(byModel).toContain("s1")
      const plain = { ...full, bots: bare, sessions: [{ sessionId: "s9", title: "Just made", directory: "/work/app", state: "idle", queued: 0, updatedAt: NOW }] as never, current: "s9" }
      expect(multiStops(plain)).toContain("s9")
      const told = multiStops({ ...plain, sections: ["projects", "bots"], chatBots: new Map([["s9", "xbot:hermes:ada"]]), open: new Map([["xgroup:hermes", true], ["xbot:hermes:ada", true]]) })
      expect(told.indexOf("s9")).toBeGreaterThan(told.indexOf("xbot:hermes:ada"))
      expect(told.filter((id) => id === "s9")).toHaveLength(1)
    })
  })

  test("the row id names the connector and the bot, whatever the id holds", () => {
    const id = externalBotId({ origin: "hermes", id: "a:b" })
    expect(externalBotOf(id)).toEqual({ origin: "hermes", id: "a:b" })
    expect(externalBotOf("bot:calm")).toBeUndefined()
  })

  test("/bot list shows an external bot with its origin", () => {
    expect(botListText(report).join("\n")).toContain("Ada · working · from hermes")
  })
})

describe("the page of an external bot", () => {
  const bot: BotInfo = { name: "Ada", description: "Embedded AI lead", identity: { origin: "hermes" }, model: "gpt-6.1-sol", file: "", state: "working", projects: [] }
  const make = (external: { app?: string }, calls: string[]) => createBotCard({
    bot,
    folders: ["/work/app"],
    external,
    actions: {
      openSession: async () => {}, newSession: async (directory) => void calls.push(`new ${directory}`), edit: async () => void calls.push("edit"), delete: async () => void calls.push("delete"), memory: async () => void calls.push("memory"),
      ...(external.app ? { openApp: async () => void calls.push("app") } : {}), close() {}, redraw() {},
    },
  })

  test("it offers a new chat and the app, and edit, memory and delete do nothing there", async () => {
    const calls: string[] = []
    const card = make({ app: "Desk Agent" }, calls)
    const text = lines(card.render({ width: 80, height: 24, now: NOW })).join("\n")
    for (const needle of ["Ada", "hermes", "gpt-6.1-sol", "New chat in a folder", "Open in Desk Agent", "o open app"]) expect(text).toContain(needle)
    for (const word of ["Edit", "Memory", "Delete", "Permission"]) expect(text).not.toContain(word)
    for (const key of ["e", "m", "d"]) await card.key(key)
    expect(calls).toEqual([])
    await card.key("o")
    expect(calls).toEqual(["app"])
    await card.key("n")
    await card.key("\r")
    expect(calls).toEqual(["app", "new /work/app"])
  })

  test("a bot that names no app has no open row", async () => {
    const calls: string[] = []
    const card = make({}, calls)
    expect(lines(card.render({ width: 80, height: 24, now: NOW })).join("\n")).not.toContain("Open in")
    await card.key("o")
    expect(calls).toEqual([])
  })
})
