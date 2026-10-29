import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { readFileSync } from "node:fs"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { createScreen } from "../src/ui/screen"
import type { ImagePlacement } from "../src/ui/image-layer"
import type { Line } from "../src/ui/theme"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { tuiProfilePath } from "../src/view/tui-profile"
import { scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
const apps: Array<ReturnType<typeof createApp>> = []
afterEach(() => {
  for (const app of apps.splice(0)) app.applySettings({ pet: "off" })
  for (const dir of made.splice(0)) dir.cleanup()
})

async function harness(options: { env?: Record<string, string>; profile?: string; pet?: boolean; answers?: Parameters<typeof createApp>[0]["imageAnswers"] } = {}) {
  const dir = scratch()
  made.push(dir)
  if (options.profile) dir.write("data/tui/profile.json", options.profile)
  const writes: string[] = []
  const frames: Array<{ rows: Line[]; placements: ImagePlacement[] }> = []
  const sent: string[] = []
  const env = { COLORTERM: "truecolor", MENDCODE_MOUSE: "0", ...options.env }
  const screen = createScreen({ columns: 100, rows: 34, write: (d) => void writes.push(d) }, env)
  const draw = screen.draw
  screen.draw = (rows, cursor, placements) => {
    frames.push({ rows, placements: placements ?? [] })
    return draw(rows, cursor, placements)
  }
  const app = createApp({
    sessionId: createIdFactory()("session"), screen, env, dataDir: dir.dataDir, directory: dir.project,
    send: async (command) => (sent.push(command.type), { ok: true }),
    exit() {}, schedule() {}, random: () => 0,
    ...(options.answers ? { imageAnswers: options.answers } : {}),
    ...(options.pet ? { pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" as const }], cacheDir: path.join(dir.dataDir, "pets-cache"), images: false } } : {}),
  })
  apps.push(app)
  app.applySettings({ onboarded: true, ...(options.pet ? { pet: "user:tiny" } : {}) })
  await app.imagesReady
  if (options.pet) await app.petReady
  app.render()
  const text = () => frames.at(-1)!.rows.map((row) => row.map((span) => span.text).join("")).join("\n")
  async function customizeImages() {
    await app.onInput("/customize")
    await app.onKey("\r")
    for (let row = 0; row < CUSTOMIZE_ROWS.indexOf("images"); row++) await app.onKey("\x1b[B")
    app.render()
  }
  async function key(seq: string) {
    await app.onKey(seq)
    await app.imagesReady
    app.render()
  }
  return { app, screen, writes, frames, sent, dir, text, customizeImages, key }
}

describe("image protocol app integration", () => {
  test("saved override applies at startup; /customize cycles, persists and switches live without a daemon command", async () => {
    const h = await harness({ env: { TERM_PROGRAM: "ghostty" }, profile: '{"images":"iterm2"}' })
    expect(h.screen.imageProtocol).toBe("iterm2")
    await h.customizeImages()
    expect(h.text()).toMatch(/Images\s+‹ iterm2 ›/)
    for (const protocol of ["sixel", "off", "kitty"] as const) {
      await h.key("\x1b[C") // iterm2 -> sixel -> off -> auto (Ghostty selects Kitty)
      expect(h.screen.imageProtocol).toBe(protocol)
    }
    const saved = JSON.parse(readFileSync(tuiProfilePath(h.dir.dataDir), "utf8"))
    expect(saved.images).toBe("auto")
    expect(h.sent).not.toContain("settings.set")
    await h.key("\x1b[D") // auto -> off
    expect(h.screen.imageProtocol).toBe("off")
    expect(JSON.parse(readFileSync(tuiProfilePath(h.dir.dataDir), "utf8")).images).toBe("off")
  })

  test("iTerm2 auto works without COLORTERM; rapidly changing the mode cannot install an old pending layer", async () => {
    const h = await harness({ env: { TERM_PROGRAM: "iTerm.app", COLORTERM: "" } })
    expect(h.screen.imageProtocol).toBe("iterm2")
    await h.customizeImages()
    for (let i = 0; i < 4; i++) await h.app.onKey("\x1b[C") // auto -> kitty -> iterm2 -> sixel -> off
    await h.app.imagesReady
    await Bun.sleep(2)
    expect(h.screen.imageProtocol).toBe("off")
  })

  test("multiplexers suppress every forced backend and show a terse note once", async () => {
    const h = await harness({ env: { TERM_PROGRAM: "WezTerm", TMUX: "socket" }, profile: '{"images":"sixel"}' })
    expect(h.screen.imageProtocol).toBe("off")
    expect(h.text()).toContain("images disabled in tmux")
    expect(h.writes.join("")).not.toContain("1337;File=")
    expect(h.writes.join("")).not.toContain("\x1bP0;1;0q")
    await h.customizeImages()
    await h.key("\x1b[D")
    expect(h.screen.imageProtocol).toBe("off")
    // Opening /customize dismisses the startup warning; changing the override must not repeat it.
    expect(h.text()).not.toContain("images disabled in tmux")
  })

  test("tuios is a multiplexer too: a forced kitty reserves no rows there and the note names it", async () => {
    const h = await harness({ env: { TERM_PROGRAM: "TUIOS", TUIOS_ENV: "1", TERM: "xterm-256color" }, profile: '{"images":"kitty"}' })
    expect(h.screen.imageProtocol).toBe("off")
    expect(h.text()).toContain("images disabled in tuios (MENDCODE_PET_IMAGES=1 turns them on)")
    expect(h.writes.join("")).not.toContain("\x1b_G")
    // On the default `auto` nothing was asked for, so nothing is said.
    const quiet = await harness({ env: { TERM_PROGRAM: "TUIOS", TUIOS_ENV: "1", TERM: "xterm-256color" } })
    expect(quiet.screen.imageProtocol).toBe("off")
    expect(quiet.text()).not.toContain("images disabled")
  })

  test("a host's already available DA1 and pixel geometry select sixel without sending a query", async () => {
    const h = await harness({ pet: true, answers: { da1: "\x1b[?62;4c", cellPixels: { width: 10, height: 19 } } })
    expect(h.screen.imageProtocol).toBe("sixel")
    expect(h.writes.join("")).toContain('q"1;1;100;76')
    expect(h.writes.join("")).not.toContain("\x1b[c")
    expect(h.writes.join("")).not.toContain("\x1b[16t")
  })

  for (const protocol of ["iterm2", "sixel"] as const) test(`${protocol} pets are static, hide on another page, reappear, and fall back to half blocks when off`, async () => {
    const h = await harness({ pet: true, profile: JSON.stringify({ images: protocol }), env: { MENDCODE_CELL_PIXELS: "9x15" } })
    const key = h.frames.at(-1)!.placements[0]!.key
    expect(key).toContain("/0/")
    if (protocol === "sixel") expect(h.writes.join("")).toContain('q"1;1;90;60')
    h.writes.length = 0
    // No reduced-motion setting: the protocol itself suppresses animation frames.
    await Bun.sleep(170)
    h.app.render()
    expect(h.frames.at(-1)!.placements[0]!.key).toBe(key)
    expect(h.writes.join("")).not.toContain(protocol === "iterm2" ? "1337;File=" : "\x1bP0;1;0q")
    await h.customizeImages()
    expect(h.frames.at(-1)!.placements).toEqual([])
    await h.key("\x1b")
    expect(h.frames.at(-1)!.placements).toHaveLength(1)
    await h.customizeImages()
    for (let i = 0; i < (protocol === "sixel" ? 1 : 2); i++) await h.key("\x1b[C")
    expect(h.screen.imageProtocol).toBe("off")
    await h.key("\x1b")
    expect(h.frames.at(-1)!.placements).toEqual([])
    expect(h.frames.at(-1)!.rows.some((row) => row.some((span) => span.fgHex && /[▀▄]/.test(span.text)))).toBe(true)
  })

  test("switching away from Kitty releases its cached images", async () => {
    const h = await harness({ pet: true, profile: '{"images":"kitty"}' })
    expect(h.writes.join("")).toContain("\x1b_Ga=t,")
    h.writes.length = 0
    await h.customizeImages()
    await h.key("\x1b[C")
    expect(h.screen.imageProtocol).toBe("iterm2")
    expect(h.writes.join("")).toContain("\x1b_Ga=d,d=I,")
  })
})

/** Whether Mend is drawn in half blocks: a cell in its mint face color. */
const mendBlocks = (rows: Line[]) => rows.some((row) => row.some((span) => span.fgHex === "#d4f9d9" || span.bgHex === "#d4f9d9"))

test("beside the prompt the built-in Mend is a picture in a pet's cells where kitty draws pictures, half blocks where it does not", async () => {
  const kitty = await harness({ profile: '{"images":"kitty","pet":"mend"}' })
  await Bun.sleep(30)
  kitty.app.render()
  const placed = kitty.frames.at(-1)!.placements.find((at) => at.slot === "pet")!
  // The small box, 10x5: Mend's 13x14 pixels stand three quarters of it, 4 rows, as any pet at rest does.
  expect([placed.key.split("/")[0], placed.cols, placed.rows, placed.image.width, placed.image.height]).toEqual(["mend", 7, 4, 56, 64])
  expect(mendBlocks(kitty.frames.at(-1)!.rows)).toBe(false)
  const off = await harness({ profile: '{"images":"off","pet":"mend"}' })
  expect(off.frames.at(-1)!.placements.filter((at) => at.slot === "pet")).toEqual([])
  expect(mendBlocks(off.frames.at(-1)!.rows)).toBe(true)
})

test("/pet preview emits a real graphical panel, scales on resize and draws Mend as a picture at a pet's size", async () => {
  const h = await harness({ pet: true, profile: '{"images":"kitty"}' })
  await h.app.onInput("/pet\r")
  await Bun.sleep(30)
  h.app.render()
  const first = h.frames.at(-1)!.placements[0]!
  expect(first.slot).toBe("pet-preview")
  expect(first.cols).toBeGreaterThan(16)
  expect(first.rows).toBeGreaterThan(8)
  expect(h.text()).toContain("Source: user")
  expect(h.text()).toContain("States: idle")
  h.screen.resize(180, 50)
  h.app.render()
  const wide = h.frames.at(-1)!.placements[0]!
  expect(wide.col).toBeGreaterThan(50)
  expect(wide.rows).toBeLessThanOrEqual(16)
  expect(first.rows).toBeLessThanOrEqual(16)
  await h.app.onKey("\x1b[A")
  h.app.render()
  // Mend's own pixels in the cells any pet gets in the 32x16 box: three quarters of its height, no half blocks under it.
  const mend = h.frames.at(-1)!.placements[0]!
  expect([mend.key, mend.cols, mend.rows, mend.image.width, mend.image.height]).toEqual(["mend/idle/0/preview", 22, 12, 176, 192])
  expect(mendBlocks(h.frames.at(-1)!.rows)).toBe(false)
  expect(h.text()).toContain("testing")
})

test("no graphic is emitted until the TTY cell report arrives; first placement equals settled geometry", async () => {
  const dir = scratch()
  made.push(dir)
  const writes: string[] = []
  const frames: ImagePlacement[][] = []
  const screen = createScreen({ isTTY: true, columns: 100, rows: 34, write: (d) => writes.push(d) }, { TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" })
  const draw = screen.draw.bind(screen)
  screen.draw = (rows, cursor, placements) => { frames.push(placements ?? []); return draw(rows, cursor, placements) }
  const app = createApp({ sessionId: createIdFactory()("session"), screen, env: { TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" }, dataDir: dir.dataDir, directory: dir.project, pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: path.join(dir.dataDir, "cache"), images: true }, send: async () => ({ ok: true }), exit() {}, schedule() {} })
  apps.push(app)
  app.applySettings({ pet: "user:tiny", reducedMotion: true })
  await app.petReady
  app.render()
  expect(writes.join("")).toContain("\x1b[16t")
  expect(writes.join("")).not.toContain("\x1b_Ga=p")
  await app.onInput("\x1b[6;19;")
  await app.onInput("10t")
  await app.imagesReady
  app.render()
  const first = frames.find((ps) => ps.length > 0)![0]!
  // The tiny pet is wider than tall: 10 x 4 cells of the small box (the default), at 10 x 19 pixels a cell.
  expect(writes.join("")).toContain("a=t,f=32,s=100,v=76")
  expect(app.editor.text).toBe("")
  await app.onInput("\x1b[6;40;20t")
  app.render()
  const settled = frames.at(-1)![0]!
  expect({ ...first, image: undefined }).toEqual({ ...settled, image: undefined })
  expect(screen.cellPixels).toEqual({ width: 10, height: 19 })
})
