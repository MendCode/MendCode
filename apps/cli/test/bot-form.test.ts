import { afterAll, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { BotInfo } from "@mendcode/protocol"
import type { ImagePlacement } from "../src/ui/image-layer"
import { activeTheme } from "../src/ui/theme"
import type { FaceCapability } from "../src/view/bot-face"
import { botFormKey, botFormProblems, botFormRows, botPromptOf, botSaveFields, deleteBotForm, editBotForm, newBotForm, renderBotForm, type BotFormAction, type BotFormState } from "../src/view/bot-form"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH } from "../src/view/sidebar"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const refuse = (message: string) => ({ ok: false, error: { code: "invalid_command", message } }) as CommandReply

const bot = (extra: Partial<BotInfo> = {}): BotInfo => ({
  name: "calm", description: "A calm reviewer", identity: { shape: "hexagon", color: "info", origin: "mendcode" }, model: "gpt-6-luna", permission: "edits", file: "/d/agents/calm.md", state: "idle",
  projects: [{ directory: "/work/app", state: "idle", sessions: [{ sessionId: "ses_1" as never, title: "Chrome", status: "idle", updatedAt: NOW }, { sessionId: "ses_2" as never, title: "Docs", status: "idle", updatedAt: NOW }] }],
  ...extra,
}) as BotInfo

/** Types `keys` one by one into a form the way the page receives them. */
function press(form: BotFormState, ...keys: string[]): { form: BotFormState | undefined; actions: BotFormAction[] } {
  let current: BotFormState | undefined = form
  const actions: BotFormAction[] = []
  for (const key of keys) {
    if (!current) break
    const result = botFormKey(current, key)
    current = result.form
    actions.push(result.action)
  }
  return { form: current, actions }
}
const TAB = "\t"
const text = (form: BotFormState, width = 100, height = 34) => renderBotForm({ form, width, height }).map(plain).join("\n")
const types = (value: string) => [...value]

describe("the form's rows and what is wrong with them", () => {
  test("a new form asks for a name, and says why a name is refused only once the user touched it or tried to save", () => {
    const form = newBotForm({ models: ["gpt-6-luna", "gpt-6-sol"], taken: ["calm"] })
    expect(botFormRows(form)).toEqual(["name", "color", "shape", "face", "prompt", "model", "permission", "buttons"])
    expect(botFormProblems(form).name).toContain("needs a name")
    expect(text(form)).not.toContain("needs a name")
    const taken = press(form, ...types("calm")).form!
    expect(botFormProblems(taken).name).toBe("calm is already an agent name")
    expect(text(taken)).toContain("calm is already an agent name")
    expect(botFormProblems(press(form, ...types("build")).form!).name).toContain("already an agent name")
    // A capital is typed as its lowercase; other characters a name cannot hold show the rule inline.
    const odd = press(form, "A", "b", " ", "c").form!
    expect(odd.name).toBe("ab c")
    expect(text(odd)).toContain("lowercase letters, digits, _ and - only")
    expect(botFormProblems(press(form, ...types("pixel")).form!)).toEqual({})
  })

  test("the face can be generated or an image path, and the path shows its problem inline", () => {
    let form = newBotForm({ name: "pixel" })
    expect(botFormRows(form)).not.toContain("avatar")
    form = press(form, TAB, TAB, "\x1b[C").form!
    expect(form.face).toBe("image")
    expect(botFormRows(form)).toContain("avatar")
    expect(botFormProblems(form).avatar).toContain("name a .png or .webp")
    form = press(form, TAB, ...types("face.txt")).form!
    expect(text(form)).toContain("the image must be a .png or .webp file")
    form = press(form, "\x15", ...types("face.png")).form!
    expect(botFormProblems(form)).toEqual({})
    expect(botSaveFields(form)).toMatchObject({ avatar: "face.png" })
    expect(botSaveFields(press(form, "\x1b[D").form ?? form)).toBeDefined()
  })

  test("a personality over the limit is refused inline", () => {
    const form = { ...newBotForm({ name: "pixel" }), prompt: "x".repeat(16_001) }
    expect(text({ ...form, attempted: true })).toContain("the personality takes at most 16000 characters")
  })

  test("the editor row appears only when an editor is set", () => {
    expect(botFormRows(newBotForm({ name: "a", editor: false }))).not.toContain("editor")
    expect(botFormRows(newBotForm({ name: "a", editor: true }))).toContain("editor")
    expect(text(newBotForm({ name: "a", editor: true }))).toContain("open in $EDITOR")
    expect(text(newBotForm({ name: "a", editor: false }))).not.toContain("EDITOR")
  })
})

describe("the form's keys", () => {
  test("Tab and the arrows move between rows, left and right cycle the choices, Enter on a text row moves on", () => {
    let form = newBotForm({ models: ["gpt-6-luna", "gpt-6-sol"] })
    expect(form.row).toBe(0)
    form = press(form, TAB).form!
    expect(form.row).toBe(1)
    form = press(form, "\x1b[B", "\x1b[A", "\x1b[Z").form!
    expect(form.row).toBe(0)
    const colors = press(form, TAB, "\x1b[C", "\x1b[C").form!
    expect(colors.color).toBe("secondary")
    expect(press(colors, "\x1b[D", "\x1b[D", "\x1b[D").form!.color).toBe("info")
    expect(press(form, ...types("a"), "\r").form!.row).toBe(1)
    // Model: session default first, then the catalog; permission starts at smart.
    const model = press(form, TAB, TAB, TAB, TAB, TAB, "\x1b[C").form!
    expect(botFormRows(model)[model.row]).toBe("model")
    expect(model.model).toBe("gpt-6-luna")
    expect(press(model, "\x1b[C").form!.model).toBe("gpt-6-sol")
    expect(press(model, "\x1b[C", "\x1b[C").form!.model).toBe("")
    expect(form.permission).toBe("smart")
    expect(press(model, TAB, "\x1b[C").form!.permission).toBe("edits")
  })

  test("Create with a problem does not save: it shows the problem and moves to its row; with none it asks the app to save", () => {
    const empty = newBotForm({})
    const refused = press(empty, ...Array(7).fill(TAB), "\r")
    expect(refused.actions.at(-1)).toEqual({ type: "none" })
    expect(refused.form!.row).toBe(0)
    expect(text(refused.form!)).toContain("a bot needs a name")
    const good = press(newBotForm({ name: "pixel" }), ...Array(7).fill(TAB), "\r")
    expect(good.actions.at(-1)).toEqual({ type: "save" })
    expect(good.form!.busy).toBe("creating…")
    // Keys wait while it runs.
    expect(botFormKey(good.form!, "\x1b").action).toEqual({ type: "none" })
  })

  test("Cancel button and Esc close the form without saving", () => {
    expect(press(newBotForm({ name: "pixel" }), "\x1b")).toMatchObject({ form: undefined, actions: [{ type: "cancel" }] })
    const viaButton = press(newBotForm({ name: "pixel" }), ...Array(7).fill(TAB), "\x1b[C", "\r")
    expect(viaButton.form).toBeUndefined()
    expect(viaButton.actions.at(-1)).toEqual({ type: "cancel" })
    expect(viaButton.actions.some((action) => action.type === "save")).toBe(false)
  })

  test("a live preview of the face changes with the shape and the color", () => {
    const base = newBotForm({ name: "pixel" })
    const lines = (form: BotFormState) => text(form).split("\n").slice(2, 9).map((line) => line.slice(0, 14)).join("\n")
    // A named form opens on the color row; one Tab reaches the shape row.
    const picked = (form: BotFormState, tabs: number, key: string, times: number) => press(form, ...Array(tabs).fill(TAB), ...Array(times).fill(key)).form!
    const hexagon = picked(base, 1, "\x1b[C", 5)
    expect(hexagon.shape).toBe("hexagon")
    expect(lines(hexagon)).toContain("▄█████▄")
    const square = picked(base, 1, "\x1b[C", 2)
    expect(square.shape).toBe("square")
    expect(lines(square)).toContain("▄██████")
    expect(lines(square)).not.toBe(lines(hexagon))
    const green = picked({ ...base, shape: "circle" }, 0, "\x1b[C", 4)
    expect(green.color).toBe("success")
    const bodyColor = (form: BotFormState) => renderBotForm({ form, width: 100, height: 34 }).flat().find((span) => span.text.includes("████"))?.fgHex
    expect(bodyColor(green)).toBe(activeTheme().colors.success)
    expect(bodyColor(picked({ ...base, shape: "circle" }, 0, "\x1b[C", 7))).toBe(activeTheme().colors.info)
    expect(text(green)).toContain("green")
  })

  describe("where the terminal draws images, the preview is the picture", () => {
    const IMAGES: FaceCapability = { images: true }
    const draw = (form: BotFormState, { capability = IMAGES, width = 100, height = 34 }: { capability?: FaceCapability; width?: number; height?: number } = {}) => {
      const placements: ImagePlacement[] = []
      const lines = renderBotForm({ form, width, height, capability, placements })
      return { lines, placements }
    }

    test("a capable terminal gets one placement over the 9 by 4 cells at the face's place, with the cells under it blank", () => {
      const { lines, placements } = draw(newBotForm({ name: "pixel" }))
      expect(placements.length).toBe(1)
      expect(placements[0]).toMatchObject({ slot: "bot-form", row: 4, col: 2, cols: 9, rows: 4 })
      for (let row = 4; row < 8; row++) expect(plain(lines[row]!).slice(0, 13)).toBe("│" + " ".repeat(12))
      expect(plain(lines[4]!)).toContain("pixel")
      expect(plain(lines[8]!)).toContain("idle")
    })

    test("with an avatar the form shows the avatar, and a generated face without one", () => {
      const avatar = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4).fill(200) }
      const form = { ...newBotForm({ name: "pixel" }), face: "image" as const, avatar: "face.png" }
      expect(draw(form, { capability: { images: true, avatar } }).placements[0]!.image).toBe(avatar)
      expect(draw(form).placements[0]!.key).toStartWith("bot/")
    })

    test("a shape or color change gives another picture; the same look gives the very same one, encoded once", () => {
      const base = newBotForm({ name: "pixel" })
      const first = draw(base).placements[0]!
      const again = draw(base).placements[0]!
      expect(again.key).toBe(first.key)
      expect(again.image).toBe(first.image)
      const square = draw({ ...base, shape: "square" }).placements[0]!
      const red = draw({ ...base, color: "error" }).placements[0]!
      expect(square.key).not.toBe(first.key)
      expect(red.key).not.toBe(first.key)
      expect(draw({ ...base, shape: "square" }).placements[0]!.image).toBe(square.image)
      expect(draw({ ...base, color: "error" }).placements[0]!.image).toBe(red.image)
    })

    test("the text face stays when the terminal draws no images, in ASCII mode, with nowhere to put the picture, in a short page or once the panel scrolls", () => {
      const form = newBotForm({ name: "pixel" })
      const none = (result: ReturnType<typeof draw>) => {
        expect(result.placements).toEqual([])
        expect(plain(result.lines[4]!)).not.toMatch(/^│ {12}/)
      }
      none(draw(form, { capability: {} }))
      none(draw(form, { capability: { images: true, ascii: true } }))
      none(draw(form, { height: 8 }))
      expect(renderBotForm({ form, width: 100, height: 34, capability: IMAGES }).map(plain)[5]).toMatch(/[▀▄█]/)
      // Moving to the last row on a short page scrolls the panel: the face is text again.
      const scrolled = draw({ ...form, row: botFormRows(form).length - 1 }, { height: 12 })
      expect(scrolled.placements).toEqual([])
    })
  })

  test("the saved fields leave out what the form left on auto and carry what it set", () => {
    const form = { ...newBotForm({ name: "pixel" }), prompt: "Calm reviewer.", model: "gpt-6-sol", permission: "ask" as const }
    expect(botSaveFields(form)).toEqual({ name: "pixel", create: true, prompt: "Calm reviewer.", permission: "ask", model: "gpt-6-sol" })
    expect(botSaveFields({ ...form, shape: "square", color: "error" })).toMatchObject({ shape: "square", color: "error" })
    expect(botSaveFields(newBotForm({ draft: { name: "scout", description: "Use this agent when needed.", prompt: "You scout.", color: "info" } }))).toEqual({ name: "scout", create: true, prompt: "You scout.", permission: "smart", description: "Use this agent when needed.", color: "info" })
  })
})

describe("editing a bot", () => {
  test("the form is prefilled from the bot and the file's body; the name is read-only", () => {
    const form = editBotForm({ bot: bot(), prompt: botPromptOf("---\ndescription: x\nbot:\n  shape: hexagon\n---\nYou review.\nGently.\n"), models: ["gpt-6-luna"] })
    expect(form).toMatchObject({ mode: "edit", name: "calm", shape: "hexagon", color: "info", model: "gpt-6-luna", permission: "edits", prompt: "You review.\nGently.", face: "generated", sessions: 2 })
    expect(text(form)).toContain("Edit")
    expect(text(form)).toContain("(fixed)")
    expect(press({ ...form, row: 0 }, ...types("zzz")).form!.name).toBe("calm")
    expect(botSaveFields(form)).toEqual({ name: "calm", create: false, prompt: "You review.\nGently.", permission: "edits", shape: "hexagon", color: "info", model: "gpt-6-luna" })
    expect(botFormRows(form)).toContain("buttons")
    // A file that limits tools with rules of its own is not shown as a mode: saving sends no permission until one is picked.
    const ruled = editBotForm({ bot: bot({ permission: undefined, permissionRules: true }), prompt: "You review." })
    expect(ruled.permission).toBeUndefined()
    expect(text(ruled)).toContain("custom rules in the file")
    expect("permission" in botSaveFields(ruled)).toBe(false)
    const picked = press({ ...ruled, row: botFormRows(ruled).indexOf("permission") }, "\x1b[C").form!
    expect(botSaveFields(picked)).toMatchObject({ permission: expect.any(String) })
    // An image the bot already has opens the face as an image path.
    const withImage = editBotForm({ bot: bot({ identity: { origin: "mendcode", avatar: "face.png" } }), prompt: "" })
    expect(withImage).toMatchObject({ face: "image", avatar: "face.png" })
  })

  test("the buttons are Save, Delete and Cancel; Delete opens the confirmation and nothing is removed yet", () => {
    const form = editBotForm({ bot: bot(), prompt: "" })
    const onDelete = press(form, ...Array(7).fill(TAB), "\x1b[C", "\r")
    expect(onDelete.form!.confirm).toEqual({ memory: false })
    expect(onDelete.actions.some((action) => action.type === "delete")).toBe(false)
    expect(newBotForm({ name: "x" }).mode).toBe("create")
    expect(text(newBotForm({ name: "x" }))).not.toContain("Delete")
  })
})

describe("deleting needs a lowercase y", () => {
  const confirm = () => deleteBotForm({ bot: bot(), prompt: "" })

  test("the confirmation says what will happen", () => {
    const shown = text(confirm())
    for (const needle of ["Delete bot calm?", "its agent file is removed: /d/agents/calm.md", "memory folder (bots/calm) is kept", "its 2 sessions and conversations are never deleted", "stay in /sessions as normal sessions", "y delete"]) expect(shown).toContain(needle)
    expect(text({ ...confirm(), confirm: { memory: true } })).toContain("memory folder (bots/calm) is removed too")
  })

  test("Enter, a capital Y, Space and other keys do not delete; Esc cancels", () => {
    for (const key of ["\r", "Y", " ", "n", "x", "\x1b[B"]) {
      const result = botFormKey(confirm(), key)
      expect(result.action).toEqual({ type: "none" })
      expect(result.form?.confirm).toBeDefined()
    }
    expect(botFormKey(confirm(), "\x1b")).toEqual({ form: undefined, action: { type: "cancel" } })
    // From the form's Delete button, Esc goes back to the form, not out of it.
    const fromForm = { ...confirm(), deleteOnly: undefined }
    const back = botFormKey(fromForm, "\x1b")
    expect(back.form?.confirm).toBeUndefined()
    expect(back.action).toEqual({ type: "none" })
  })

  test("y deletes keeping the memory by default; m flips that first", () => {
    expect(botFormKey(confirm(), "y").action).toEqual({ type: "delete", memory: false })
    expect(press(confirm(), "m", "y").actions.at(-1)).toEqual({ type: "delete", memory: true })
    expect(press(confirm(), "m", "m", "y").actions.at(-1)).toEqual({ type: "delete", memory: false })
    // It is busy once it was asked.
    expect(botFormKey(confirm(), "y").form!.busy).toBe("deleting…")
  })
})

describe("in the app", () => {
  const dataDir = () => { const dir = tempDir(); writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE }); return dir }
  const calm = bot({ projects: [] })

  function app({ editor, extra, bots = [calm], env }: { editor?: string; extra?: (command: CommandInput) => CommandReply | undefined; bots?: BotInfo[]; env?: Record<string, string> } = {}) {
    const current = ids("session")
    const h = appHarness({
      mode: "balanced", width: 120, height: 34, sessionId: current, dataDir: dataDir(), directory: "/work/app", inspectProject: async () => ({ git: true }),
      env: { ...(editor ? { EDITOR: editor } : {}), ...env },
      reply: (command) => {
        const mine = extra?.(command)
        if (mine) return mine
        if (command.type === "bot.list") return reply({ bots, external: [], problems: [] })
        if (command.type === "bot.file") return reply({ file: "/d/agents/calm.md", text: "---\ndescription: A calm reviewer\nmode: primary\nbot:\n  shape: hexagon\n---\nYou review gently.\n", saved: false })
        if (command.type === "models.list") return reply({ engine: "native", selectable: true, models: [{ id: "gpt-6-luna" }, { id: "gpt-6-sol" }], defaults: { model: "gpt-6-luna" }, roles: {} })
        if (command.type === "session.list") return reply({ sessions: [] })
        return undefined
      },
    })
    h.app.applySettings({ experimental: { bots: true } })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
    return h
  }
  type App = ReturnType<typeof app>
  const screen = (h: App) => h.text().join("\n")
  async function until(h: App, needle: string) {
    for (let turn = 0; turn < 80; turn++) {
      h.app.render()
      if (screen(h).includes(needle)) return
      await Bun.sleep(5)
    }
    throw new Error(`never drew ${needle}:\n${screen(h)}`)
  }
  const none = (h: App) => ["bot.create", "bot.save", "bot.delete", "bot.file"].flatMap((type) => h.sentOf(type as never)).filter((command) => "text" in command || command.type !== "bot.file")

  test("/bot new with no words opens the form, and the form is not a dead end without an editor", async () => {
    const h = app()
    await h.type("/bot new\r")
    expect(h.app.page).toBe("bot-form")
    for (const needle of ["Bots · New", "New bot", "Name", "Color", "Shape", "Face", "Personality", "Model", "Permission", "[ Create ]", "[ Cancel ]"]) expect(screen(h)).toContain(needle)
    expect(screen(h)).not.toContain("$VISUAL")
    expect(screen(h)).not.toContain("EDITOR")
    expect(none(h)).toEqual([])
  })

  test("in a terminal that draws images the form page places the generated picture and swaps it when the shape changes", async () => {
    const screen = { size: { width: 120, height: 34 }, imageProtocol: "kitty", draw() {}, write() {}, setTitle() {} } as unknown as NonNullable<Parameters<typeof appHarness>[0]>["screen"]
    const current = ids("session")
    const h = appHarness({
      mode: "balanced", width: 120, height: 34, sessionId: current, dataDir: dataDir(), directory: "/work/app", inspectProject: async () => ({ git: true }), screen,
      env: { TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" },
      reply: (command) => command.type === "bot.list" ? reply({ bots: [calm], external: [], problems: [] }) : command.type === "models.list" ? reply({ engine: "native", selectable: true, models: [], defaults: {}, roles: {} }) : command.type === "session.list" ? reply({ sessions: [] }) : undefined,
    })
    h.app.applySettings({ experimental: { bots: true } })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
    await h.type("/bot new pixel\r")
    expect(h.app.page).toBe("bot-form")
    const form = () => { h.app.render(); return h.placements.at(-1)!.filter((placement) => placement.slot === "bot-form") }
    const first = form()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ row: 4, col: 2, cols: 9, rows: 4 })
    expect(form()[0]!.key).toBe(first[0]!.key)
    await h.type("\t\x1b[C")
    const square = form()
    expect(square).toHaveLength(1)
    expect(square[0]!.key).not.toBe(first[0]!.key)
    await h.type("\x1b")
    expect(h.placements.at(-1)!.filter((placement) => placement.slot === "bot-form")).toHaveLength(0)
  })

  test("/bot new <name> opens it with the name filled, and typing, picking and Create send one bot.save", async () => {
    const h = app({ extra: (command) => command.type === "bot.save" ? reply({ file: "/d/agents/pixel.md", agent: { name: "pixel" }, generation: "deterministic", callsProviders: false }) : undefined })
    await h.type("/bot new pixel\r")
    expect(h.app.page).toBe("bot-form")
    expect(screen(h)).toContain("pixel")
    await h.type("\x1b[C\x1b[C\x1b[C\x1b[C")
    expect(screen(h)).toContain("green")
    await h.type("\t\x1b[C\x1b[C")
    await h.type("\t\t")
    await h.type("Calm reviewer.")
    for (let turn = 0; turn < 3; turn++) await h.type("\t")
    expect(h.text().some((row) => row.includes("❯") && row.includes("[ Create ]"))).toBe(true)
    await h.type("\r")
    for (let turn = 0; turn < 20 && h.sentOf("bot.save").length === 0; turn++) await Bun.sleep(5)
    expect(h.sentOf("bot.save")).toHaveLength(1)
    expect(h.sentOf("bot.save")[0]).toMatchObject({ name: "pixel", create: true, prompt: "Calm reviewer.", permission: "smart", color: "success", shape: "square" })
    expect(h.sentOf("bot.create")).toHaveLength(0)
    expect(h.app.page).toBe("chat")
    expect(screen(h)).toContain("bot pixel made")
  })

  test("a bracketed paste goes into the field the form is on", async () => {
    const h = app({ extra: (command) => command.type === "bot.save" ? reply({ file: "/d/agents/pixel.md", agent: { name: "pixel" }, generation: "deterministic", callsProviders: false }) : undefined })
    await h.type("/bot new pixel\r")
    await h.type("\t\t\t")
    await h.type("\x1b[200~Calm\nreviewer.\x1b[201~")
    for (let turn = 0; turn < 3; turn++) await h.type("\t")
    await h.type("\r")
    for (let turn = 0; turn < 20 && h.sentOf("bot.save").length === 0; turn++) await Bun.sleep(5)
    expect(h.sentOf("bot.save")[0]).toMatchObject({ name: "pixel", prompt: "Calm reviewer." })
  })

  test("Esc discards: nothing is written, whatever was typed", async () => {
    const h = app()
    await h.type("/bot new pixel\r")
    await h.type("\t\x1b[C\x1b[C")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    expect(none(h)).toEqual([])
    expect(h.sentOf("bot.draft")).toHaveLength(0)
  })

  test("a name the daemon refuses is shown on the Name row, with nothing saved", async () => {
    const h = app({ extra: (command) => command.type === "bot.save" ? refuse("[BOT]: calm2 is already an agent name") : undefined })
    await h.type("/bot new calm2\r")
    for (let turn = 0; turn < 7; turn++) await h.type("\t")
    await h.type("\r")
    for (let turn = 0; turn < 20 && !screen(h).includes("already an agent name"); turn++) { h.app.render(); await Bun.sleep(5) }
    expect(h.app.page).toBe("bot-form")
    expect(screen(h)).toContain("calm2 is already an agent name")
    expect(screen(h)).toContain("nothing was saved")
  })

  test("/bot new -d asks the model for a draft, writes nothing, and shows the draft in the form to confirm", async () => {
    const h = app({ extra: (command) => command.type === "bot.draft" ? reply({ name: "calm-reviewer", description: "Use this agent when a diff needs a gentle review.", prompt: "You are a calm reviewer.", color: "success", generation: "model", callsProviders: true }) : undefined })
    await h.type("/bot new -d a calm green reviewer\r")
    await until(h, "Bots · New")
    expect(h.sentOf("bot.draft")[0]).toMatchObject({ description: "a calm green reviewer" })
    expect(h.sentOf("bot.create")).toHaveLength(0)
    expect(h.sentOf("bot.save")).toHaveLength(0)
    for (const needle of ["calm-reviewer", "You are a calm reviewer.", "green"]) expect(screen(h)).toContain(needle)
  })

  test("/bot edit opens the form prefilled from the bot and its file, with the name fixed", async () => {
    const h = app()
    await h.type("/bot edit calm\r")
    await until(h, "Bots · Edit")
    for (const needle of ["calm", "(fixed)", "hexagon", "blue", "gpt-6-luna", "You review gently.", "(•) edits", "[ Save ]", "[ Delete ]", "[ Cancel ]"]) expect(screen(h)).toContain(needle)
    expect(screen(h)).not.toContain("$VISUAL")
  })

  test("saving an edit sends bot.save with create false", async () => {
    const h = app({ extra: (command) => command.type === "bot.save" ? reply({ file: "/d/agents/calm.md", agent: { name: "calm" }, generation: "deterministic", callsProviders: false }) : undefined })
    await h.type("/bot edit calm\r")
    await until(h, "Bots · Edit")
    for (let turn = 0; turn < 3; turn++) await h.type("\t")
    await h.type("!")
    for (let turn = 0; turn < 3; turn++) await h.type("\t")
    await h.type("\r")
    for (let turn = 0; turn < 20 && h.sentOf("bot.save").length === 0; turn++) await Bun.sleep(5)
    expect(h.sentOf("bot.save")[0]).toMatchObject({ name: "calm", create: false, prompt: "You review gently.!", shape: "hexagon", color: "info", model: "gpt-6-luna", permission: "edits" })
    expect(screen(h)).toContain("bot calm saved")
  })

  test("with an editor set, the personality can be opened in it and its result comes back into the form", async () => {
    const seen: string[] = []
    const h = appHarness({
      mode: "balanced", width: 120, height: 34, directory: "/work/app", env: { EDITOR: "vim" }, dataDir: dataDir(),
      editorLauncher: async () => async (request) => { seen.push(request.text); return { ok: true as const, text: "You review in detail.\n", changed: true } },
      reply: (command) => command.type === "bot.list" ? reply({ bots: [calm], external: [], problems: [] }) : command.type === "bot.file" ? reply({ file: "/d/agents/calm.md", text: "---\ndescription: x\nbot: {}\n---\nOld", saved: false }) : undefined,
    })
    h.app.applySettings({ experimental: { bots: true } })
    await h.type("/bot edit calm\r")
    for (let turn = 0; turn < 40 && h.app.page !== "bot-form"; turn++) await Bun.sleep(5)
    expect(h.text().join("\n")).toContain("open in $EDITOR")
    for (let turn = 0; turn < 4; turn++) await h.type("\t")
    await h.type("\r")
    for (let turn = 0; turn < 20 && seen.length === 0; turn++) await Bun.sleep(5)
    expect(seen).toEqual(["Old"])
    h.app.render()
    expect(h.text().join("\n")).toContain("You review in detail.")
  })

  test("/bot delete asks first: Enter does nothing, y deletes keeping the memory, and the sessions are only counted", async () => {
    const withSessions = bot()
    const h = app({ bots: [withSessions], extra: (command) => command.type === "bot.delete" ? reply({ file: "/d/agents/calm.md", memoryRemoved: false, sessions: 2 }) : undefined })
    await h.type("/bot delete calm\r")
    await until(h, "Delete bot calm?")
    await h.type("\r")
    await h.type(" ")
    await h.type("Y")
    expect(h.sentOf("bot.delete")).toHaveLength(0)
    expect(screen(h)).toContain("Delete bot calm?")
    await h.type("y")
    for (let turn = 0; turn < 20 && h.sentOf("bot.delete").length === 0; turn++) await Bun.sleep(5)
    expect(h.sentOf("bot.delete")).toEqual([expect.objectContaining({ name: "calm", memory: false })])
    expect(h.app.page).toBe("chat")
    h.app.render()
    expect(screen(h)).toContain("bot calm deleted · memory kept · its 2 sessions stay in /sessions")
  })

  test("m in the confirmation also removes the memory; Esc cancels and sends nothing", async () => {
    const h = app({ extra: (command) => command.type === "bot.delete" ? reply({ file: "/d/agents/calm.md", memoryRemoved: true, sessions: 0 }) : undefined })
    await h.type("/bot delete calm\r")
    await until(h, "Delete bot calm?")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    expect(h.sentOf("bot.delete")).toHaveLength(0)
    await h.type("/bot delete calm\r")
    await until(h, "Delete bot calm?")
    await h.type("m")
    expect(screen(h)).toContain("memory folder (bots/calm) is removed too")
    await h.type("y")
    for (let turn = 0; turn < 20 && h.sentOf("bot.delete").length === 0; turn++) await Bun.sleep(5)
    expect(h.sentOf("bot.delete")[0]).toMatchObject({ name: "calm", memory: true })
  })

  test("a bot the daemon refuses to delete stays in the confirmation with the reason", async () => {
    const h = app({ extra: (command) => command.type === "bot.delete" ? refuse("[BOT]: no bot named calm; /bot list shows them") : undefined })
    await h.type("/bot delete calm\r")
    await until(h, "Delete bot calm?")
    await h.type("y")
    await until(h, "the bot was not deleted")
    expect(h.app.page).toBe("bot-form")
  })

  test("the bot page: e opens the form, d opens the confirmation, and neither mentions $EDITOR", async () => {
    const sidebar = (h: App) => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH))
    const h = app({ bots: [bot()] })
    const open = async () => {
      for (let turn = 0; turn < 80 && !sidebar(h).some((row) => row.includes("calm")); turn++) { h.app.render(); await Bun.sleep(5) }
      // ← takes the list, b goes to the first bot, o opens its page.
      await h.type("\x1b[D")
      await h.type("b")
      await h.type("o")
      expect(h.app.page).toBe("bot")
    }
    await open()
    expect(screen(h)).toContain("e edit · m memory · d delete")
    await h.type("e")
    await until(h, "Bots · Edit")
    expect(screen(h)).not.toContain("$VISUAL")
    await h.type("\x1b")
    // Cancelling goes back to the page it came from.
    expect(h.app.page).toBe("bot")
    await h.type("d")
    await until(h, "Delete bot calm?")
    await h.type("\r")
    expect(h.sentOf("bot.delete")).toHaveLength(0)
    await h.type("\x1b")
    expect(h.app.page).toBe("bot")
  })
})
