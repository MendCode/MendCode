import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { botListText, parseBotWords } from "../src/view/bot"
import { SLASH_COMMANDS, commandOffered, parseSlash, takesArguments } from "../src/view/commands"
import { menuCatalog } from "../src/view/slash-menu"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (value: unknown) => value as CommandReply

describe("/bot words", () => {
  test("list, new with and without a description, new -d, edit, duplicate and memory", () => {
    expect(parseBotWords("")).toEqual({ kind: "list" })
    expect(parseBotWords("list")).toEqual({ kind: "list" })
    expect(parseBotWords("new calm")).toEqual({ kind: "new", name: "calm", description: "The calm bot", generate: false })
    expect(parseBotWords("new calm a calm green reviewer")).toEqual({ kind: "new", name: "calm", description: "a calm green reviewer", generate: true })
    expect(parseBotWords("new -d a calm green reviewer")).toEqual({ kind: "new", description: "a calm green reviewer", generate: true })
    expect(parseBotWords("edit calm")).toEqual({ kind: "edit", name: "calm" })
    expect(parseBotWords("duplicate calm calm-2")).toEqual({ kind: "duplicate", name: "calm", newName: "calm-2" })
    expect(parseBotWords("memory calm")).toEqual({ kind: "memory", name: "calm", op: "list", project: false })
    expect(parseBotWords("memory calm add --project uses tabs")).toEqual({ kind: "memory", name: "calm", op: "add", project: true, text: "uses tabs" })
    expect(parseBotWords("memory calm clear")).toEqual({ kind: "memory", name: "calm", op: "clear", project: false })
  })

  test("what does not parse says why", () => {
    const why = (text: string) => { const parsed = parseBotWords(text); return parsed.kind === "error" ? parsed.message : "" }
    expect(why("new")).toContain("needs a name")
    expect(why("new Calm Bot")).toContain("is not a bot name")
    expect(why("new -d")).toContain("needs a description")
    expect(why(`new calm ${"x".repeat(301)}`)).toContain("at most 300")
    expect(why("edit")).toContain("one bot name")
    expect(why("duplicate calm")).toContain("new name")
    expect(why("memory")).toContain("bot name")
    expect(why("memory calm add")).toContain("text to remember")
    expect(why("memory calm clear now")).toContain("no text")
    expect(why("memory calm wipe")).toContain("unknown memory word")
    expect(why("list now")).toContain("no arguments")
    expect(why("fly")).toContain("unknown bot word")
  })

  test("a line per bot names its state in words, with its folders under it", () => {
    const identity = { shape: "circle" as const, color: "success" as const, origin: "mendcode" }
    const lines = botListText({
      bots: [{ name: "calm", description: "A calm reviewer", identity, file: "/f", state: "waiting", projects: [{ directory: "/work/a", state: "waiting", sessions: [{ sessionId: "ses_a" as never, title: "t", status: "waiting_for_input", updatedAt: 1 }] }] }],
      external: [{ origin: "hermes", id: "1", name: "Hermes", state: "idle" }],
      problems: [],
    })
    expect(lines).toEqual(["- calm · waiting for you · circle success · A calm reviewer", "    /work/a · waiting for you · 1 session", "- Hermes · idle · from hermes"])
  })
})

describe("the /bot command is behind the flag", () => {
  const command = SLASH_COMMANDS.find((entry) => entry.name === "bot")!

  test("it exists once, takes arguments, and the menu offers it only with experimental.bots on", () => {
    expect(command).toMatchObject({ group: "agents", flag: "bots", aliases: [] })
    expect(takesArguments(command)).toBe(true)
    expect(SLASH_COMMANDS.filter((entry) => entry.name === "bot" || entry.aliases.includes("bot"))).toHaveLength(1)
    expect(commandOffered(command, {})).toBe(false)
    expect(commandOffered(command, { experimental: { bots: false } })).toBe(false)
    expect(commandOffered(command, { experimental: { bots: true } })).toBe(true)
    expect(menuCatalog([], DEFAULT_TUI_PROFILE, {}).some((entry) => entry.name === "bot")).toBe(false)
    expect(menuCatalog([], DEFAULT_TUI_PROFILE, { experimental: { bots: true } }).some((entry) => entry.name === "bot")).toBe(true)
    expect(parseSlash("/bot list")?.command.name).toBe("bot")
  })
})

describe("/bot in the terminal", () => {
  function app(replies: (command: CommandInput) => unknown, editorLauncher?: NonNullable<Parameters<typeof appHarness>[0]>["editorLauncher"]) {
    const h = appHarness({ directory: tempDir("mendcode-bot-"), ...(editorLauncher ? { editorLauncher } : {}), reply: (command) => (command.type === "settings.get" ? reply({ ok: true, result: { settings: { experimental: { bots: true } } } }) : reply(replies(command))) })
    return h
  }
  const screen = (h: ReturnType<typeof app>) => h.text().join("\n")
  const bot = { name: "calm", description: "A calm reviewer", identity: { shape: "circle", color: "success", origin: "mendcode" }, file: "/d/agents/calm.md", state: "idle", projects: [] }

  test("/bot lists the bots, and names the flag when the daemon says they are off", async () => {
    let off = false
    const h = app((command) => command.type === "bot.list" ? (off ? { ok: false, error: { code: "forbidden", message: "[BOT]: bots are off: turn them on with /experimental bots on" } } : { ok: true, result: { bots: [bot], external: [], problems: [] } }) : undefined)
    await h.type("/bot\r")
    expect(screen(h)).toContain("calm · idle · circle success · A calm reviewer")
    await h.type("\x1b")
    off = true
    await h.type("/bot list\r")
    expect(screen(h)).toContain("bots are off: turn them on with /experimental bots on")
  })

  test("/bot new with a description asks the model; with a bare name it does not; the result says what was written", async () => {
    const h = app((command) => command.type === "bot.create" ? { ok: true, result: { file: "/d/agents/calm.md", agent: { name: "calm", bot: { shape: "circle", color: "success", origin: "mendcode" } }, generation: command.generate ? "model" : "deterministic", callsProviders: command.generate === true } } : undefined)
    await h.type("/bot new calm a calm green reviewer\r")
    expect(h.sentOf("bot.create")[0]).toMatchObject({ name: "calm", description: "a calm green reviewer", generate: true })
    expect(screen(h)).toContain("bot calm made · circle success · written by the model")
    await h.type("/bot new plain\r")
    expect(h.sentOf("bot.create")[1]).toMatchObject({ name: "plain", description: "The plain bot" })
    expect((h.sentOf("bot.create")[1] as { generate?: boolean }).generate).toBeUndefined()
    await h.type("/bot new -d a quiet tester\r")
    expect((h.sentOf("bot.create")[2] as { name?: string }).name).toBeUndefined()
    expect(h.sentOf("bot.create")[2]).toMatchObject({ description: "a quiet tester", generate: true })
  })

  test("/bot edit opens the file in the editor and saves only a change", async () => {
    const seen: string[] = []
    let next = { ok: true as const, text: "---\ndescription: A calm reviewer\nbot: {}\n---\nChanged", changed: true }
    const h = app(
      (command) => command.type === "bot.file" ? { ok: true, result: { file: "/d/agents/calm.md", text: "---\ndescription: A calm reviewer\nbot: {}\n---\nOld", saved: "text" in command } } : undefined,
      async () => async (request) => { seen.push(`${request.fileName}:${request.text.endsWith("Old")}`); return next },
    )
    await h.type("/bot edit calm\r")
    expect(seen).toEqual(["calm.md:true"])
    expect(h.sentOf("bot.file")).toHaveLength(2)
    expect(h.sentOf("bot.file")[1]).toMatchObject({ name: "calm", text: next.text })
    expect(screen(h)).toContain("bot calm saved")
    next = { ...next, changed: false }
    await h.type("/bot edit calm\r")
    expect(h.sentOf("bot.file")).toHaveLength(3)
    expect(screen(h)).toContain("bot calm unchanged")
  })

  test("/bot duplicate and /bot memory send the daemon commands", async () => {
    const h = app((command) => command.type === "bot.duplicate" ? { ok: true, result: { file: "/d/agents/calm-2.md" } } : command.type === "bot.memory" ? { ok: true, result: { global: command.op === "list" ? "- likes short answers" : "", project: "" } } : undefined)
    await h.type("/bot duplicate calm calm-2\r")
    expect(h.sentOf("bot.duplicate")[0]).toMatchObject({ name: "calm", newName: "calm-2" })
    expect(screen(h)).toContain("bot calm-2 copied from calm")
    await h.type("/bot memory calm add --project uses tabs\r")
    expect(h.sentOf("bot.memory")[0]).toMatchObject({ name: "calm", op: "add", scope: "project", text: "uses tabs" })
    expect(screen(h)).toContain("calm will remember it in this project")
    await h.type("/bot memory calm\r")
    expect(screen(h)).toContain("likes short answers")
  })
})
