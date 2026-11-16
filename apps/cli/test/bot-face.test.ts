import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BOT_COLORS, BOT_SHAPES } from "../../../packages/packages/src/agents"
import { encodeImagePng } from "../../../packages/tools/src/pet-png"
import { botFace, botIconImage, FACE_STATES, faceCapability, faceFrameCount, faceLook, facePlacement, faceStateOf, type FaceCapability, type FaceState } from "../src/view/bot-face"
import { createFaceAnimator, FACE_FRAME_MS } from "../src/view/bot-face-anim"
import { loadBotAvatar, MAX_AVATAR_BYTES, MAX_AVATAR_SIDE } from "../src/view/bot-avatar"
import { THEMES } from "../src/themes"

const text = (lines: readonly { text: string }[][]) => lines.map((line) => line.map((span) => span.text).join(""))
const UNICODE: FaceCapability = {}
const ASCII: FaceCapability = { ascii: true }
const IMAGES: FaceCapability = { images: true }
const theme = (name: string) => THEMES.find((candidate) => candidate.name === name)!
const widthOf = (line: string) => [...line].length

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-bot-face-"))
  dirs.push(dir)
  return dir
}
const solid = (width: number, height: number) => ({ width, height, rgba: new Uint8Array(width * height * 4).fill(200) })

describe("a generated face is deterministic from the name", () => {
  test("the same name gives the same look, whatever the case", () => {
    expect(faceLook({ name: "Ada" })).toEqual(faceLook({ name: "ada" }))
    expect(faceLook({ name: "ada" })).toEqual(faceLook({ name: "ada" }))
  })

  test("shape and color role come from the allowed sets and many names spread over them", () => {
    const looks = Array.from({ length: 60 }, (_, i) => faceLook({ name: `bot-${i}` }))
    for (const look of looks) {
      expect(BOT_SHAPES).toContain(look.shape)
      expect(BOT_COLORS).toContain(look.color)
    }
    expect(new Set(looks.map((look) => look.shape)).size).toBe(BOT_SHAPES.length)
    expect(new Set(looks.map((look) => look.color)).size).toBeGreaterThanOrEqual(5)
    expect(new Set(looks.map((look) => look.eyes)).size).toBe(3)
    expect(new Set(looks.map((look) => look.mouth)).size).toBe(3)
  })

  test("a shape or color the bot sets wins over the generated one", () => {
    const look = faceLook({ name: "ada", shape: "triangle", color: "error" })
    expect(look.shape).toBe("triangle")
    expect(look.color).toBe("error")
  })

  test("the rendered text is identical for the same input", () => {
    const a = text(botFace({ name: "ada", state: "talking", size: "card", capability: UNICODE }).lines)
    const b = text(botFace({ name: "ada", state: "talking", size: "card", capability: UNICODE }).lines)
    expect(a).toEqual(b)
  })

  test("the generated image is byte for byte the same", () => {
    const input = { name: "ada", state: "thinking", size: "card", capability: { images: true, theme: theme("mendcode") } } as const
    const a = botFace(input).image!.image
    const b = botFace(input).image!.image
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true)
    expect(botFace(input).image!.key).toBe(botFace(input).image!.key)
  })
})

describe("every state at both sizes", () => {
  for (const shape of BOT_SHAPES) {
    for (const state of FACE_STATES) {
      test(`card ${shape} ${state}: 4 rows of 9 cells, unicode and ASCII`, () => {
        for (const capability of [UNICODE, ASCII]) {
          const face = botFace({ name: "ada", shape, state, size: "card", capability })
          expect(face.rows).toBe(4)
          expect(face.cols).toBe(9)
          expect(face.lines.length).toBe(4)
          for (const line of text(face.lines)) expect(widthOf(line)).toBe(9)
          if (capability.ascii) for (const line of text(face.lines)) expect(line).toMatch(/^[\x20-\x7e]*$/)
        }
      })
    }
  }

  for (const state of FACE_STATES) {
    test(`icon ${state}: one row of 2 cells, unicode and ASCII`, () => {
      for (const capability of [UNICODE, ASCII]) {
        const face = botFace({ name: "ada", state, size: "icon", capability })
        expect(face.rows).toBe(1)
        expect(face.cols).toBe(2)
        const [line] = text(face.lines)
        expect(widthOf(line!)).toBe(2)
        if (capability.ascii) expect(line).toMatch(/^[\x20-\x7e]*$/)
      }
    })
  }

  test("each state looks different from the others (card and icon, unicode and ASCII)", () => {
    for (const size of ["card", "icon"] as const) {
      for (const capability of [UNICODE, ASCII]) {
        const seen = new Map<string, FaceState>()
        for (const state of FACE_STATES) {
          const key = text(botFace({ name: "ada", shape: "circle", state, size, capability }).lines).join("\n")
          expect(seen.get(key), `${size} ${state} equals ${seen.get(key)}`).toBeUndefined()
          seen.set(key, state)
        }
      }
    }
  })

  test("idle shows the sleeping face and the state words match the examples", () => {
    const get = (state: Parameters<typeof botFace>[0]["state"]) => text(botFace({ name: "ada", shape: "circle", state, size: "card", capability: ASCII }).lines).join("\n")
    expect(get("idle")).toBe(get("sleeping"))
    expect(get("sleeping")).toContain("- -")
    expect(get("problem")).toContain("x x")
    expect(get("talking")).toContain("o")
  })

  test("a bot state maps to a face state", () => {
    expect(faceStateOf("idle")).toBe("sleeping")
    expect(faceStateOf("working")).toBe("listening")
    expect(faceStateOf("waiting")).toBe("waiting")
    expect(faceStateOf("problem")).toBe("problem")
  })

  test("a label becomes a fifth row, centered, and problem and waiting are readable without color", () => {
    const face = botFace({ name: "ada", state: "problem", size: "card", capability: UNICODE, label: "problem" })
    expect(face.rows).toBe(5)
    expect(text(face.lines)[4]).toContain("problem")
    const plain = text(face.lines).join("\n")
    expect(plain).toContain("×")
    const waiting = text(botFace({ name: "ada", state: "waiting", size: "card", capability: UNICODE, label: "waiting" }).lines).join("\n")
    expect(waiting).toContain("?")
    expect(waiting).toContain("waiting")
  })

  test("the animation frames change the picture only for states that move", () => {
    for (const state of FACE_STATES) {
      const frames = faceFrameCount(state)
      const pictures = new Set(Array.from({ length: frames }, (_, frame) => text(botFace({ name: "ada", shape: "circle", state, size: "card", capability: UNICODE, frame }).lines).join("\n")))
      expect(pictures.size).toBe(frames)
    }
    expect(faceFrameCount("talking")).toBeGreaterThan(1)
    expect(faceFrameCount("problem")).toBe(1)
  })
})

describe("theme roles, light and dark", () => {
  test("text faces use theme color roles only", () => {
    for (const state of FACE_STATES) {
      const face = botFace({ name: "ada", state, size: "card", capability: UNICODE, label: state })
      for (const span of face.lines.flat()) {
        expect(span.fgHex).toBeUndefined()
        expect(span.bgHex).toBeUndefined()
        expect(span.bg).toBeUndefined()
      }
    }
  })

  test("problem draws in the error role and waiting in the warning role, the others in the bot's color", () => {
    const frame = (state: FaceState) => botFace({ name: "ada", color: "info", shape: "circle", state, size: "card", capability: UNICODE }).lines[0]![0]!.fg
    expect(frame("problem")).toBe("error")
    expect(frame("waiting")).toBe("warning")
    expect(frame("talking")).toBe("info")
  })

  test("the generated image uses the active theme's color for the role, on a light and a dark theme", () => {
    for (const name of ["mendcode", "paper"]) {
      const palette = theme(name)
      const face = botFace({ name: "ada", shape: "square", color: "success", state: "talking", size: "card", capability: { images: true, theme: palette } })
      const { image } = face.image!
      const hex = palette.colors.success
      const at = (x: number, y: number) => [...image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]
      const body = at(Math.floor(image.width * 0.5), Math.floor(image.height * 0.9))
      expect(body.slice(0, 3)).toEqual([1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)))
      expect(body[3]).toBe(255)
    }
  })

  test("the eyes in the image are black on a light body and light on a dark body", () => {
    const eyeAt = (palette: ReturnType<typeof theme>, color: (typeof BOT_COLORS)[number]) => {
      const { image } = botFace({ name: "ada", shape: "square", color, state: "listening", size: "card", capability: { images: true, theme: palette } }).image!
      const darkest = { sum: 999, rgb: [0, 0, 0] }
      let lightest = { sum: -1, rgb: [0, 0, 0] }
      for (let i = 0; i < image.rgba.length; i += 4) {
        if (image.rgba[i + 3] !== 255) continue
        const sum = image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!
        if (sum < darkest.sum) { darkest.sum = sum; darkest.rgb = [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!] }
        if (sum > lightest.sum) lightest = { sum, rgb: [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!] }
      }
      return { darkest: darkest.rgb, lightest: lightest.rgb }
    }
    const fake = (hex: string) => ({ ...theme("mendcode"), colors: { ...theme("mendcode").colors, primary: hex } })
    expect(eyeAt(fake("#f0d060"), "primary").darkest).toEqual([0, 0, 0])
    expect(eyeAt(fake("#101830"), "primary").lightest).toEqual([255, 255, 255])
  })
})

describe("fallbacks in order", () => {
  test("images on gives an image and keeps the text under it", () => {
    const face = botFace({ name: "ada", state: "talking", size: "card", capability: { images: true, theme: theme("mendcode") } })
    expect(face.mode).toBe("image")
    expect(face.image?.image.width).toBe(face.cols * 8)
    expect(face.image?.image.height).toBe(face.rows * 16)
    expect(text(face.lines).join("").trim()).not.toBe("")
  })

  test("images off falls back to the unicode face", () => {
    const face = botFace({ name: "ada", state: "talking", size: "card", capability: UNICODE })
    expect(face.mode).toBe("unicode")
    expect(face.image).toBeUndefined()
  })

  test("ascii mode wins over images and unicode", () => {
    const face = botFace({ name: "ada", state: "talking", size: "card", capability: { ascii: true, images: true } })
    expect(face.mode).toBe("ascii")
    expect(face.image).toBeUndefined()
  })

  test("an avatar the bot has replaces the generated picture and keeps its own pixels", () => {
    const avatar = solid(64, 64)
    const face = botFace({ name: "ada", state: "talking", size: "card", capability: { images: true, avatar } })
    expect(face.mode).toBe("image")
    expect(face.image?.image).toBe(avatar)
    expect(text(face.lines).every((line) => line.trim() === "")).toBe(true)
  })

  test("an avatar with no image support falls back to the generated text face", () => {
    const face = botFace({ name: "ada", state: "talking", size: "card", capability: { avatar: solid(8, 8) } })
    expect(face.mode).toBe("unicode")
    expect(face.image).toBeUndefined()
  })

  test("capability comes from the existing detection: protocols and half blocks", () => {
    expect(faceCapability({ env: { TERM_PROGRAM: "ghostty" }, depth: "truecolor" }).images).toBe(true)
    expect(faceCapability({ env: { TERM_PROGRAM: "iTerm.app" }, depth: "truecolor" }).images).toBe(true)
    expect(faceCapability({ env: { TERM_PROGRAM: "Apple_Terminal" }, depth: "truecolor" }).images).toBe(false)
    expect(faceCapability({ env: { TERM_PROGRAM: "ghostty", TMUX: "x" }, depth: "truecolor" }).images).toBe(false)
    expect(faceCapability({ env: { TERM_PROGRAM: "ghostty" }, depth: "truecolor", mode: "off" }).images).toBe(false)
    expect(faceCapability({ env: { TERM_PROGRAM: "ghostty" }, depth: "truecolor", ascii: true }).ascii).toBe(true)
  })

  test("a placement for the image layer", () => {
    const face = botFace({ name: "ada", state: "talking", size: "card", capability: { images: true } })
    const placement = facePlacement({ face, slot: "bot:ada", row: 3, col: 2 })!
    expect(placement).toMatchObject({ slot: "bot:ada", row: 3, col: 2, cols: 9, rows: 4 })
    expect(placement.key).toBe(face.image!.key)
    expect(facePlacement({ face: botFace({ name: "ada", state: "talking", size: "card", capability: UNICODE }), slot: "x", row: 0, col: 0 })).toBeUndefined()
  })
})

describe("the sidebar icon helper", () => {
  test("2 cells by 1 row image when images are supported, nothing otherwise so the caller keeps its glyph", () => {
    const icon = botIconImage({ name: "ada", state: "listening", capability: { images: true }, slot: "bot-icon:ada", row: 5, col: 1 })!
    expect(icon).toMatchObject({ slot: "bot-icon:ada", row: 5, col: 1, cols: 2, rows: 1 })
    expect(icon.image.width).toBe(16)
    expect(icon.image.height).toBe(16)
    expect(botIconImage({ name: "ada", state: "listening", capability: UNICODE, slot: "s", row: 0, col: 0 })).toBeUndefined()
    expect(botIconImage({ name: "ada", state: "listening", capability: { ascii: true, images: true }, slot: "s", row: 0, col: 0 })).toBeUndefined()
  })

  test("an avatar becomes the icon image", () => {
    const avatar = solid(32, 32)
    const icon = botIconImage({ name: "ada", state: "listening", capability: { images: true, avatar }, slot: "s", row: 0, col: 0 })!
    expect(icon.image).toBe(avatar)
  })
})

describe("animation", () => {
  function harness(options: { visible?: boolean; reduced?: boolean } = {}) {
    let timers = 0
    let pending: (() => void) | undefined
    let waits: number[] = []
    let changes = 0
    const animator = createFaceAnimator({
      onChange: () => void changes++,
      reducedMotion: () => options.reduced ?? false,
      setTimer: (run, ms) => { timers++; pending = run; waits.push(ms); return run },
      clearTimer: () => { pending = undefined },
    })
    if (options.visible) animator.setVisible(true)
    return { animator, fire: () => { const run = pending; pending = undefined; run?.() }, get pending() { return pending !== undefined }, get timers() { return timers }, waits: () => waits, changes: () => changes }
  }

  test("no timer exists while the face is hidden, whatever the state", () => {
    const h = harness()
    for (const state of FACE_STATES) h.animator.setState(state)
    expect(h.animator.armed).toBe(false)
    expect(h.timers).toBe(0)
  })

  test("a visible face in a moving state arms one timer, at most 4 frames a second", () => {
    const h = harness({ visible: true })
    h.animator.setState("talking")
    expect(h.animator.armed).toBe(true)
    expect(h.waits().every((ms) => ms >= 250)).toBe(true)
    for (const state of FACE_STATES) expect(FACE_FRAME_MS[state] === undefined || FACE_FRAME_MS[state]! >= 250).toBe(true)
  })

  test("a state that does not move arms nothing even when visible", () => {
    const h = harness({ visible: true })
    h.animator.setState("problem")
    expect(h.animator.armed).toBe(false)
    h.animator.setState("listening")
    expect(h.animator.armed).toBe(false)
  })

  test("each tick advances the frame and re-arms; hiding it cancels the timer; showing it again re-arms", () => {
    const h = harness({ visible: true })
    h.animator.setState("talking")
    expect(h.animator.frame()).toBe(0)
    h.fire()
    expect(h.animator.frame()).toBe(1)
    expect(h.animator.armed).toBe(true)
    h.animator.setVisible(false)
    expect(h.animator.armed).toBe(false)
    expect(h.pending).toBe(false)
    h.animator.setVisible(true)
    expect(h.animator.armed).toBe(true)
  })

  test("a state change restarts at frame 0 and repaints once; the same state does nothing", () => {
    const h = harness({ visible: true })
    h.animator.setState("talking")
    h.fire()
    const before = h.changes()
    h.animator.setState("talking")
    expect(h.changes()).toBe(before)
    h.animator.setState("thinking")
    expect(h.animator.frame()).toBe(0)
    expect(h.changes()).toBe(before + 1)
  })

  test("reduced motion keeps the first frame and no timer", () => {
    const h = harness({ visible: true, reduced: true })
    h.animator.setState("talking")
    expect(h.animator.armed).toBe(false)
    expect(h.animator.frame()).toBe(0)
  })

  test("stop clears everything and the animator stays quiet", () => {
    const h = harness({ visible: true })
    h.animator.setState("talking")
    h.animator.stop()
    expect(h.animator.armed).toBe(false)
    h.animator.setVisible(false)
    h.animator.setVisible(true)
    h.animator.setState("thinking")
    expect(h.animator.armed).toBe(false)
  })

  test("with the real timers a hidden animator leaves nothing pending", async () => {
    const animator = createFaceAnimator({ onChange: () => {} })
    animator.setState("talking")
    expect(animator.armed).toBe(false)
    animator.setVisible(true)
    expect(animator.armed).toBe(true)
    animator.setVisible(false)
    expect(animator.armed).toBe(false)
    animator.stop()
  })
})

describe("avatar validation", () => {
  const png = (width = 16, height = 16) => encodeImagePng(solid(width, height))

  test("accepts a small PNG inside an allowed folder, by absolute or relative path", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "ada.png"), png())
    const absolute = await loadBotAvatar({ path: path.join(dir, "ada.png"), allowed: [dir] })
    expect(absolute).toMatchObject({ width: 16, height: 16 })
    const relative = await loadBotAvatar({ path: "ada.png", base: dir, allowed: [dir] })
    expect(relative.width).toBe(16)
  })

  test("rejects a path outside the allowed folders", async () => {
    const dir = tempDir()
    const other = tempDir()
    writeFileSync(path.join(other, "ada.png"), png())
    await expect(loadBotAvatar({ path: path.join(other, "ada.png"), allowed: [dir] })).rejects.toThrow(/\[BOTS\].*outside/)
    await expect(loadBotAvatar({ path: "../x.png", base: dir, allowed: [dir] })).rejects.toThrow(/outside/)
  })

  test("rejects a symlink that leaves the allowed folder", async () => {
    const dir = tempDir()
    const other = tempDir()
    writeFileSync(path.join(other, "secret.png"), png())
    symlinkSync(path.join(other, "secret.png"), path.join(dir, "ada.png"))
    await expect(loadBotAvatar({ path: path.join(dir, "ada.png"), allowed: [dir] })).rejects.toThrow(/outside/)
  })

  test("rejects other extensions, folders and missing files", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "ada.gif"), png())
    mkdirSync(path.join(dir, "folder.png"))
    await expect(loadBotAvatar({ path: path.join(dir, "ada.gif"), allowed: [dir] })).rejects.toThrow(/\.png or \.webp/)
    await expect(loadBotAvatar({ path: path.join(dir, "folder.png"), allowed: [dir] })).rejects.toThrow(/not a file/)
    await expect(loadBotAvatar({ path: path.join(dir, "none.png"), allowed: [dir] })).rejects.toThrow(/\[BOTS\]/)
  })

  test("rejects a file over the byte limit before reading it", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "big.png"), Buffer.alloc(MAX_AVATAR_BYTES + 1))
    await expect(loadBotAvatar({ path: path.join(dir, "big.png"), allowed: [dir] })).rejects.toThrow(/larger than/)
  })

  test("rejects a file whose content is not a PNG or WebP, whatever its name", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "ada.png"), "not an image at all, just text")
    await expect(loadBotAvatar({ path: path.join(dir, "ada.png"), allowed: [dir] })).rejects.toThrow(/PNG or WebP/)
  })

  test("rejects a picture wider or taller than the side limit from its header alone", async () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, "wide.png"), png(MAX_AVATAR_SIDE + 1, 2))
    writeFileSync(path.join(dir, "tall.png"), png(2, MAX_AVATAR_SIDE + 1))
    await expect(loadBotAvatar({ path: path.join(dir, "wide.png"), allowed: [dir] })).rejects.toThrow(/exceeds/)
    await expect(loadBotAvatar({ path: path.join(dir, "tall.png"), allowed: [dir] })).rejects.toThrow(/exceeds/)
  })

  test("a PNG whose header lies about a small size and carries a huge one is cut by the header check", async () => {
    const dir = tempDir()
    const bytes = Buffer.from(png(8, 8))
    bytes.writeUInt32BE(60000, 16)
    writeFileSync(path.join(dir, "lie.png"), bytes)
    await expect(loadBotAvatar({ path: path.join(dir, "lie.png"), allowed: [dir] })).rejects.toThrow(/exceeds/)
  })
})
