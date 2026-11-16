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
    expect(multiStops(input)).toEqual([externalBotId({ origin: "hermes", id: "ada" })])
    const rows = renderMultiSidebar({ ...input, selected: externalBotId({ origin: "hermes", id: "ada" }) }).rows.map(plain)
    expect(rows.find((row) => row.includes("Ada"))).toMatch(/hermes +● working/)
    expect(rows.find((row) => row.includes("Listed only"))).toMatch(/other +◌ idle/)
    expect(rows.join("\n")).toContain("↵ chat  o page")
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
