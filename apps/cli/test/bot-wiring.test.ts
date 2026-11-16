import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BotInfo, BotState } from "@mendcode/protocol"
import { encodeImagePng } from "../../../packages/tools/src/pet-png"
import { THEMES } from "../src/themes"
import type { ImagePlacement } from "../src/ui/image-layer"
import { botFace, botIconImage, faceStateOf, type FaceCapability } from "../src/view/bot-face"
import { createBotCard } from "../src/view/bot-card-page"
import { botIcon, type IconFaces } from "../src/view/bot-icon"
import { renderMultiSidebar, type MultiInput } from "../src/view/sidebar-multi"
import type { Line } from "../src/ui/theme"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const lines = (rows: readonly Line[]) => rows.map((row) => row.map((span) => span.text).join(""))
const theme = (name: string) => THEMES.find((candidate) => candidate.name === name)!

const bot = (state: BotState = "idle", extra: Partial<BotInfo> = {}): BotInfo => ({
  name: "calm", description: "A calm reviewer", identity: { shape: "circle", color: "success", origin: "mendcode" }, model: "gpt-6-luna", permission: "smart", file: "/d/agents/calm.md", state,
  projects: [{ directory: "/work/app", state, sessions: [{ sessionId: "ses_1", title: "Chrome", status: "idle", updatedAt: NOW }] }],
  ...extra,
}) as BotInfo

const faces = (capability: FaceCapability): IconFaces => ({ capability, slot: "bot-icon", make: botIconImage, stateOf: faceStateOf })

describe("botIcon stays the one icon entry point and uses the picture only when images are on", () => {
  test("an image-capable terminal gets a blank two-cell icon and a 2 by 1 placement from botIconImage", () => {
    const icon = botIcon({ name: "calm", shape: "circle", color: "success", state: "working", faces: faces({ images: true }) })
    // Its two cells and exactly one space after them.
    expect(icon.text).toBe("   ")
    const placed = icon.image!({ row: 4, col: 3 })!
    expect(placed).toMatchObject({ slot: "bot-icon", row: 4, col: 3, cols: 2, rows: 1 })
    const direct = botIconImage({ name: "calm", shape: "circle", color: "success", state: faceStateOf("working"), capability: { images: true }, slot: "bot-icon", row: 4, col: 3 })!
    expect(placed.key).toBe(direct.key)
  })

  test("a bot that sets no shape or color gets the glyph's and the card face's from one derivation", () => {
    const names = ["calm", "scout", "Ada", "reviewer", "bot-7", "hermes", "x", "night-owl", "Zed", "mend"]
    for (const name of names) {
      const icon = botIcon({ name })
      const face = botFace({ name, state: "idle", size: "card", capability: {} })
      expect([icon.shape, icon.color]).toEqual([face.shape, face.color])
    }
    expect(new Set(names.map((name) => botIcon({ name }).shape)).size).toBeGreaterThan(1)
    // What the bot sets still wins on both.
    expect(botIcon({ name: "calm", shape: "square", color: "error" })).toMatchObject({ shape: "square", color: "error" })
  })

  test("without images the icon is today's glyph, byte for byte", () => {
    const plain = botIcon({ name: "calm", shape: "circle", color: "success" })
    expect(botIcon({ name: "calm", shape: "circle", color: "success", state: "working", faces: faces({}) })).toEqual(plain)
    expect(botIcon({ name: "calm", shape: "circle", color: "success", state: "working" })).toEqual(plain)
  })

  test("ASCII mode wins over images, by the caller's flag and by the capability's", () => {
    const ascii = botIcon({ name: "calm", shape: "circle", color: "success", ascii: true })
    expect(botIcon({ name: "calm", shape: "circle", color: "success", ascii: true, state: "idle", faces: faces({ images: true }) })).toEqual(ascii)
    expect(botIcon({ name: "calm", shape: "circle", color: "success", state: "idle", faces: faces({ images: true, ascii: true }) }).image).toBeUndefined()
  })
})

describe("the sidebar places a picture over each bot icon only with faces", () => {
  const input = (over: Partial<MultiInput> = {}): MultiInput => ({
    sessions: [{ sessionId: "ses_1", title: "Chrome", directory: "/work/app", updatedAt: NOW, state: "idle", queued: 0 } as never],
    current: "ses_1", directory: "/work/app", focused: false, height: 12, now: NOW, sections: ["projects", "bots"], scope: "folder", icons: false, open: new Map(),
    bots: { bots: [bot("working")], external: [], problems: [] } as never,
    ...over,
  })

  test("without faces the rows and the placements are exactly today's", () => {
    const drawn = renderMultiSidebar(input())
    expect(drawn.images).toEqual([])
    expect(lines(drawn.rows).join("\n")).toContain("●")
  })

  test("with faces the bot row gets a picture at the icon's cell, and the cells are blank", () => {
    const plain = renderMultiSidebar(input())
    const drawn = renderMultiSidebar(input({ faces: faces({ images: true }) }))
    // The bot row; the bot's chat sits under it (no picture there: every row of that list is the bot's).
    expect(drawn.images.length).toBe(1)
    for (const placement of drawn.images) {
      expect(placement).toMatchObject({ cols: 2, rows: 1 })
      const row = lines(drawn.rows)[placement.row]!
      expect(row.slice(placement.col, placement.col + 3)).toBe("   ")
      expect(lines(plain.rows)[placement.row]!.slice(placement.col, placement.col + 1)).toBe("●")
    }
  })

  test("the icons column places them too", () => {
    const drawn = renderMultiSidebar(input({ icons: true, faces: faces({ images: true }) }))
    expect(drawn.images.length).toBe(1)
  })

  test("ASCII mode draws no pictures", () => {
    expect(renderMultiSidebar(input({ ascii: true, faces: faces({ images: true }) })).images).toEqual([])
  })
})

describe("the bot page draws the face", () => {
  const view = { width: 80, height: 24, now: NOW }
  const page = (state: BotState, capability: FaceCapability, extra: { ascii?: boolean; theme?: ReturnType<typeof theme>; placements?: ImagePlacement[] } = {}, timers?: { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void }) => {
    const redraw = { frames: 0 }
    const card = createBotCard({
      bot: bot(state), folders: ["/work/app"],
      actions: { openSession: async () => {}, newSession: async () => {}, edit: async () => {}, delete: async () => {}, memory: async () => {}, close() {}, redraw() {} },
      face: { capability: () => capability, onFrame: () => void redraw.frames++, ...(timers ? { setTimer: timers.set, clearTimer: timers.clear } : {}) },
    })
    return { card, redraw, text: () => lines(card.render({ ...view, ...extra })).join("\n") }
  }

  test("the face and the state word are drawn beside the identity, as half-block pixel art", () => {
    const text = page("working", {}).text()
    expect(text).toContain("▀▀███▀▀") // the bottom row of a circle
    expect(text).toContain("working")
    for (const needle of ["calm", "mendcode", "A calm reviewer", "gpt-6-luna", "smart", "Chrome"]) expect(text).toContain(needle)
  })

  test("the state maps through faceStateOf: each bot state draws a different face under its word", () => {
    const faces = (["idle", "working", "waiting", "problem"] as const).map((state) => page(state, {}).text().split("\n").slice(4, 8).map((line) => line.slice(0, 13)).join("\n"))
    expect(new Set(faces).size).toBe(4)
  })

  test("ASCII mode draws the ASCII face only, even when images are on", () => {
    const placements: ImagePlacement[] = []
    const text = page("working", { images: true }, { ascii: true, placements }).text()
    expect(text).toContain(".-------.")
    expect(text).not.toContain("╭")
    expect(placements).toEqual([])
  })

  test("with images the picture is placed in the left panel under the page header, and the label stays text", () => {
    const placements: ImagePlacement[] = []
    const text = page("working", { images: true }, { placements, theme: theme("mendcode") }).text()
    expect(placements.length).toBe(1)
    expect(placements[0]).toMatchObject({ slot: "bot-card", row: 4, col: 2, cols: 9, rows: 4 })
    // The cells under the picture are blank inside the panel's border.
    expect(text.split("\n")[4]!.slice(0, 12)).toBe("│" + " ".repeat(11))
    expect(text).not.toContain("╭")
    expect(text).toContain("working")
  })

  test("a theme change reaches the picture", () => {
    const keyFor = (name: string) => {
      const placements: ImagePlacement[] = []
      page("working", { images: true }, { placements, theme: theme(name) }).text()
      return placements[0]!.key
    }
    expect(keyFor("mendcode")).not.toBe(keyFor("paper"))
  })

  test("the bot's own picture replaces the generated one", () => {
    const avatar = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4).fill(180) }
    const placements: ImagePlacement[] = []
    page("working", { images: true, avatar }, { placements }).text()
    expect(placements[0]!.image).toBe(avatar)
    expect(placements[0]!.key.startsWith("bot-avatar/")).toBe(true)
  })

  test("a narrow page is the list alone under the shared header and summary", () => {
    const text = lines(page("working", {}).card.render({ ...view, width: 40 })).join("\n")
    expect(text).not.toContain("╭")
    expect(text).toContain("Bot · calm")
    expect(text).toContain("working · mendcode")
    expect(text).toContain("New chat")
  })
})

describe("the face clock exists only while the page is shown", () => {
  const timers = () => {
    const live = new Set<object>()
    return { live, set: (_run: () => void, _ms: number) => { const timer = {}; live.add(timer); return timer }, clear: (timer: unknown) => void live.delete(timer as object) }
  }
  const make = (state: BotState, clock: ReturnType<typeof timers>, reducedMotion = false) => createBotCard({
    bot: bot(state), folders: [],
    actions: { openSession: async () => {}, newSession: async () => {}, edit: async () => {}, delete: async () => {}, memory: async () => {}, close() {}, redraw() {} },
    face: { capability: () => ({}), onFrame() {}, reducedMotion: () => reducedMotion, setTimer: clock.set, clearTimer: clock.clear },
  })

  test("a card that is created, drawn or hidden has no timer; showing it starts one, closing it ends it", () => {
    const clock = timers()
    const card = make("idle", clock)
    expect(clock.live.size).toBe(0)
    card.render({ width: 80, height: 24, now: NOW })
    expect(clock.live.size).toBe(0)
    card.setVisible(true)
    expect(clock.live.size).toBe(1)
    card.setVisible(false)
    expect(clock.live.size).toBe(0)
    card.setVisible(true)
    card.stop()
    expect(clock.live.size).toBe(0)
    card.setVisible(true)
    expect(clock.live.size).toBe(0)
  })

  test("a state that holds one picture, or reduced motion, never starts a timer", () => {
    const still = timers()
    make("working", still).setVisible(true)
    expect(still.live.size).toBe(0)
    const calm = timers()
    make("idle", calm, true).setVisible(true)
    expect(calm.live.size).toBe(0)
  })

  test("without the face option nothing is created at all", () => {
    const card = createBotCard({ bot: bot("idle"), folders: [], actions: { openSession: async () => {}, newSession: async () => {}, edit: async () => {}, delete: async () => {}, memory: async () => {}, close() {}, redraw() {} } })
    card.setVisible(true)
    card.stop()
    expect(lines(card.render({ width: 80, height: 24, now: NOW })).join("\n")).not.toContain("╭")
  })
})

const reply = (result: unknown) => ({ ok: true, result }) as CommandReply
const CAPABLE_ENV = { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty", COLORTERM: "truecolor" }

/** The app with bots on a fake screen that draws images (`imageProtocol: kitty`) or not. */
function app({ bots = true, images = true, avatar }: { bots?: boolean; images?: boolean; avatar?: string } = {}) {
  const current = ids("session")
  const sessions: SessionSummary[] = [{ sessionId: current, title: "Chrome", directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 0, state: "idle", queued: 0 }]
  const identity = { shape: "circle", color: "success", origin: "mendcode", ...(avatar ? { avatar } : {}) }
  const report = { bots: [bot("idle", { identity, projects: [{ directory: "/work/app", state: "idle", sessions: [{ sessionId: current, title: "Chrome", status: "idle", updatedAt: NOW }] }] } as never)], external: [], problems: [] }
  const dataDir = tempDir()
  mkdirSync(join(dataDir, "bots", "calm"), { recursive: true })
  writeFileSync(join(dataDir, "bots", "calm", "face.png"), encodeImagePng({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(200) }))
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  const frames: Line[][] = []
  const placements: ImagePlacement[][] = []
  const screen = { size: { width: 120, height: 24 }, ...(images ? { imageProtocol: "kitty" } : {}), draw: (rows: Line[], _cursor: unknown, drawn?: ImagePlacement[]) => { frames.push(rows); placements.push(drawn ?? []) }, write() {}, setTitle() {} } as never
  const h = appHarness({ screen, env: CAPABLE_ENV, sessionId: current, dataDir, directory: "/work/app", reply: (command: CommandInput) => {
    if (command.type === "session.list") return reply({ sessions })
    if (command.type === "bot.list") return reply(report)
    return undefined
  } })
  h.app.applySettings(bots ? { experimental: { bots: true } } : {})
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Show the layout", "Done.")
  return { ...h, frames, placements }
}

async function settle(h: ReturnType<typeof app>, until: () => boolean) {
  for (let turn = 0; turn < 80 && !until(); turn++) {
    h.app.render()
    await Bun.sleep(5)
  }
}

/** The list takes focus (←), `b` goes to the first bot and `o` opens its page. */
async function openPage(h: ReturnType<typeof app>) {
  await h.type("\x1b[D")
  await h.type("b")
  await h.type("o")
}

describe("wired into the app", () => {
  test("flag off: no picture is ever placed, whatever the terminal can draw", async () => {
    const h = app({ bots: false })
    await Bun.sleep(30)
    for (let turn = 0; turn < 10; turn++) { h.app.render(); await Bun.sleep(5) }
    expect(h.placements.flat().filter((placement) => placement.slot.startsWith("bot-"))).toEqual([])
  })

  test("flag on in a terminal that draws images: the sidebar's bot icons become pictures", async () => {
    const h = app()
    await settle(h, () => h.placements.at(-1)?.some((placement) => placement.slot.startsWith("bot-icon")) === true)
    const icons = h.placements.at(-1)!.filter((placement) => placement.slot.startsWith("bot-icon"))
    expect(icons.length).toBe(1)
    for (const icon of icons) expect(icon).toMatchObject({ cols: 2, rows: 1, col: expect.any(Number) })
  })

  test("flag on, no image layer: the glyphs stay and nothing is placed", async () => {
    const h = app({ images: false })
    await settle(h, () => h.text().join("\n").includes("calm"))
    h.app.render()
    expect(h.text().join("\n")).toContain("●")
    expect(h.placements.flat().filter((placement) => placement.slot.startsWith("bot-"))).toEqual([])
  })

  test("the page of a bot places the face and takes the picture away when it closes", async () => {
    const h = app()
    await settle(h, () => h.text().join("\n").includes("calm"))
    await openPage(h)
    expect(h.app.page).toBe("bot")
    h.app.render()
    expect(h.placements.at(-1)!.filter((placement) => placement.slot === "bot-card").length).toBe(1)
    await h.type("\x1b")
    h.app.render()
    expect(h.placements.at(-1)!.filter((placement) => placement.slot === "bot-card")).toEqual([])
  })

  async function cardKey(avatar: string) {
    const h = app({ avatar })
    await settle(h, () => h.text().join("\n").includes("calm"))
    await openPage(h)
    // The avatar is read once, after the page opens; the next frames carry it.
    let key = ""
    await settle(h, () => { key = h.placements.at(-1)?.find((placement) => placement.slot === "bot-card")?.key ?? ""; return key.startsWith("bot-avatar/") })
    return key
  }

  test("the bot's avatar inside its folder is the page's picture; one outside the data dir is refused and the generated face stays", async () => {
    expect(await cardKey("face.png")).toStartWith("bot-avatar/")
    expect(await cardKey("../../../../../../etc/hosts")).toStartWith("bot/")
  })
})
