import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { appHarness, cleanTemps, conversation, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { createScreen } from "../src/ui/screen"
import { encodeImagePng } from "../src/ui/image-protocol"
import { decodeJpeg } from "../src/ui/jpeg"
import { decodeGif } from "../src/ui/gif"
import { decodeCardImage, sniffImage } from "../src/ui/image-decode"
import { fitImage, limitSide, resizeRgba } from "../src/ui/image-fit"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"

afterEach(cleanTemps)

const env = { COLORTERM: "truecolor", MENDCODE_MOUSE: "0", KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" }

/** A 400x200 picture: red left half, blue right half. */
function picture(width = 400, height = 200) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(x < width / 2 ? [220, 30, 30, 255] : [30, 40, 220, 255], (y * width + x) * 4)
  return { width, height, rgba }
}

type Served = { reads: Array<{ sha256: string; offset: number }> }

async function chat(options: { profile?: Partial<TuiProfile>; bytes?: Uint8Array; fail?: boolean; chunk?: number; remote?: boolean } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, images: "kitty", ...options.profile })
  const png = options.bytes ?? encodeImagePng(picture())
  const sha256 = createHash("sha256").update(png).digest("hex")
  const served: Served = { reads: [] }
  const writes: string[] = []
  const screen = createScreen({ columns: 100, rows: 34, write: (data) => void writes.push(data) }, env)
  const h = appHarness({
    dataDir, screen, env, width: 100, height: 34, imageAnswers: { cellPixels: { width: 10, height: 20 } },
    ...(options.remote ? { remote: { host: "box", readOnly: false } } : {}),
    reply: (command) => {
      if (command.type !== "attachment.read") return undefined
      served.reads.push({ sha256: command.sha256, offset: command.offset ?? 0 })
      if (options.fail) return { ok: false, error: { code: "target_mismatch", message: "no such attachment" } } as never
      const offset = command.offset ?? 0
      const length = Math.min(options.chunk ?? 98_304, png.length - offset)
      return { ok: true, result: { sha256, mime: "image/png", bytes: png.length, offset, data: Buffer.from(png.subarray(offset, offset + length)).toString("base64"), done: offset + length >= png.length } } as never
    },
  })
  h.app.applySettings({ onboarded: true })
  await h.app.imagesReady
  const talk = conversation(h.sessionId, h.app.onEvent)
  return { h, talk, sha256, png, served, writes }
}

function showImage(h: Harness, talk: ReturnType<typeof conversation>, sha256: string, bytes: number) {
  const turnId = "turn_images_1"
  talk.emit({ type: "turn.started", turnId, queueId: "queue_images_1" })
  talk.emit({ type: "item.started", turnId, itemId: "item_shot_1", kind: "tool_call", title: "screenshot" })
  talk.emit({ type: "item.completed", itemId: "item_shot_1", status: "ok", text: "saved", attachments: [{ sha256, bytes, mime: "image/png", name: "shot.png" }] })
  talk.emit({ type: "turn.completed", turnId })
  h.app.render()
}

const settle = async (h: Harness) => {
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(5)
    h.app.render()
  }
}
const drawn = (h: Harness) => h.placements.at(-1)!.filter((placement) => placement.slot.startsWith("transcript:"))

test("an image the session holds is fetched by hash, decoded and drawn over rows the transcript reserved", async () => {
  const { h, talk, sha256, png, served } = await chat()
  showImage(h, talk, sha256, png.length)
  const textRowsBefore = h.text().filter((row) => row.trim()).length
  await settle(h)
  expect(served.reads).toEqual([{ sha256, offset: 0 }])
  const [placement] = drawn(h)
  expect(placement).toBeDefined()
  // 400x200 px at 10x20 px cells: 40 columns by 10 rows, one cell column in from the card's own indent.
  expect(placement!.cols).toBe(40)
  expect(placement!.rows).toBe(10)
  expect(placement!.col).toBeGreaterThanOrEqual(2)
  expect(placement!.image.width).toBe(400)
  expect(placement!.image.height).toBe(200)
  expect([...placement!.image.rgba.subarray(0, 4)]).toEqual([220, 30, 30, 255])
  expect([...placement!.image.rgba.subarray((399) * 4, 399 * 4 + 4)]).toEqual([30, 40, 220, 255])
  // The rows under it are reserved and blank, and the card above keeps its text.
  const frame = h.text()
  const first = placement!.row
  for (let row = first; row < first + placement!.rows; row++) expect(frame[row]!.trim()).toBe("")
  expect(frame.some((row) => row.includes("■ 1 image"))).toBe(true)
  expect(frame.filter((row) => row.trim()).length).toBe(textRowsBefore)
})

test("the kitty layer receives the picture, and a pasted image in a user message is drawn too", async () => {
  const { h, talk, sha256, png, writes } = await chat()
  talk.emit({ type: "turn.started", turnId: "turn_user_1", queueId: "queue_user_1" })
  talk.emit({ type: "item.started", turnId: "turn_user_1", itemId: "item_user_1", kind: "user_message" })
  talk.emit({ type: "item.completed", itemId: "item_user_1", status: "ok", text: "what is in this picture?", attachments: [{ sha256, bytes: png.length, mime: "image/png", name: "pasted.png" }] })
  talk.emit({ type: "turn.completed", turnId: "turn_user_1" })
  h.app.render()
  await settle(h)
  expect(drawn(h)).toHaveLength(1)
  expect(writes.join("")).toContain("\x1b_G")
  expect(h.text().some((row) => row.includes("what is in this picture?"))).toBe(true)
})

test("a long image is read in chunks and the picture is only fetched once", async () => {
  const big = picture(300, 300)
  let seed = 12345
  for (let i = 0; i < big.rgba.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    big.rgba[i + 1] = seed >> 16
  }
  const { h, talk, sha256, png, served } = await chat({ bytes: encodeImagePng(big), chunk: 5000 })
  expect(png.length).toBeGreaterThan(10_000)
  showImage(h, talk, sha256, png.length)
  await settle(h)
  expect(served.reads.length).toBeGreaterThan(2)
  expect(served.reads.map((read) => read.offset)).toEqual(served.reads.map((_, i) => i * 5000))
  expect(drawn(h)).toHaveLength(1)
  const before = served.reads.length
  await settle(h)
  expect(served.reads.length).toBe(before)
})

test("an image half scrolled out of view keeps the rows still on screen, cut, until the last one leaves", async () => {
  const { h, talk, sha256, png } = await chat({ profile: { wheelLines: 1 } })
  talk.exchange("Count for me", Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n\n"))
  showImage(h, talk, sha256, png.length)
  talk.exchange("Thanks", "You are welcome.")
  await settle(h)
  expect(drawn(h)).toHaveLength(1)
  const whole = drawn(h)[0]!
  expect(whole.part).toBeUndefined()
  const seen: number[] = []
  // One row at a time: the image's lower rows pass the bottom edge first, then the whole picture leaves.
  for (let i = 0; i < 40; i++) {
    await h.app.onKey("\x1b[<64;10;10M")
    h.app.render()
    const [shown] = drawn(h)
    seen.push(shown?.rows ?? 0)
    // A cut picture is the top of the same one: same cells across, its whole height named, nothing skipped at the top.
    if (shown && shown.rows < whole.rows) expect(shown).toMatchObject({ col: whole.col, cols: whole.cols, part: { of: whole.rows, skip: 0 } })
    // The jump pill's row is never under a picture.
    if (shown) expect(h.text()[shown.row + shown.rows - 1]).not.toContain("End")
  }
  expect(seen[0]).toBe(whole.rows)
  expect(seen.at(-1)).toBe(0)
  expect(seen.every((rows, i) => i === 0 || rows <= seen[i - 1]!)).toBe(true)
  // Every height from the whole picture down to one row was shown on the way out.
  expect(new Set(seen).size).toBeGreaterThan(whole.rows - 2)
  for (let i = 0; i < 60; i++) await h.app.onKey("\x1b[<65;10;10M")
  await settle(h)
  expect(drawn(h)).toHaveLength(1)
  expect(drawn(h)[0]!.part).toBeUndefined()
})

test("an image that cannot be fetched or decoded keeps the text card and takes no rows", async () => {
  const failed = await chat({ fail: true })
  showImage(failed.h, failed.talk, failed.sha256, failed.png.length)
  await settle(failed.h)
  expect(failed.served.reads).toHaveLength(1)
  expect(drawn(failed.h)).toEqual([])
  expect(failed.h.text().some((row) => row.includes("■ 1 image"))).toBe(true)

  const garbage = new TextEncoder().encode("not an image at all")
  const bad = await chat({ bytes: garbage })
  showImage(bad.h, bad.talk, bad.sha256, garbage.length)
  await settle(bad.h)
  expect(drawn(bad.h)).toEqual([])
})

test("transcriptImages off, a remote client and a terminal without graphics never fetch anything", async () => {
  const off = await chat({ profile: { transcriptImages: false } })
  showImage(off.h, off.talk, off.sha256, off.png.length)
  await settle(off.h)
  expect(off.served.reads).toEqual([])
  expect(drawn(off.h)).toEqual([])

  const remote = await chat({ remote: true })
  showImage(remote.h, remote.talk, remote.sha256, remote.png.length)
  await settle(remote.h)
  expect(remote.served.reads).toEqual([])

  const none = await chat({ profile: { images: "off" } })
  showImage(none.h, none.talk, none.sha256, none.png.length)
  await settle(none.h)
  expect(none.served.reads).toEqual([])
  expect(none.h.placements.at(-1)!.filter((placement) => placement.slot.startsWith("transcript:"))).toEqual([])
})

test("turning transcriptImages on in /customize draws the images that were waiting", async () => {
  const { h, talk, sha256, png, served } = await chat({ profile: { transcriptImages: false } })
  showImage(h, talk, sha256, png.length)
  await settle(h)
  expect(drawn(h)).toEqual([])
  h.app.applySettings({ onboarded: true })
  await h.app.onInput("/customize")
  await h.app.onKey("\r")
  for (let row = 0; row < CUSTOMIZE_ROWS.indexOf("transcriptImages"); row++) await h.app.onKey("\x1b[B")
  await h.app.onKey("\r")
  await h.app.onKey("\x1b")
  await settle(h)
  expect(served.reads).toHaveLength(1)
  expect(drawn(h)).toHaveLength(1)
})

test("sizes: images keep their shape, never grow past their pixels and stay inside the cell box", () => {
  const cell = { width: 10, height: 20 }
  expect(fitImage({ source: { width: 400, height: 200 }, maxCols: 72, maxRows: 16, cell })).toEqual({ cols: 40, rows: 10, width: 400, height: 200 })
  expect(fitImage({ source: { width: 2000, height: 2000 }, maxCols: 72, maxRows: 16, cell })).toEqual({ cols: 32, rows: 16, width: 320, height: 320 })
  expect(fitImage({ source: { width: 1600, height: 100 }, maxCols: 30, maxRows: 16, cell })).toEqual({ cols: 30, rows: 1, width: 300, height: 19 })
  expect(fitImage({ source: { width: 3, height: 3 }, maxCols: 30, maxRows: 16, cell })).toMatchObject({ cols: 1, rows: 1 })
})

test("resizing averages by area, keeps transparency out of the colors and limits the longest side", () => {
  const source = { width: 4, height: 2, rgba: new Uint8Array([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  ]) }
  expect([...resizeRgba(source, 2, 1).rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  expect([...resizeRgba(source, 1, 1).rgba]).toEqual([128, 0, 128, 255])
  const faded = { width: 2, height: 1, rgba: new Uint8Array([200, 10, 10, 255, 0, 255, 0, 0]) }
  expect([...resizeRgba(faded, 1, 1).rgba]).toEqual([200, 10, 10, 128])
  expect(limitSide({ width: 3000, height: 1500, rgba: new Uint8Array(0) }, 1500).width).toBe(1500)
  expect(() => resizeRgba(source, 0, 1)).toThrow()
})

// A 32x32 JPEG (sips, 4:2:0): red, green, blue and yellow quadrants.
const QUADRANTS_JPEG = "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAIAAgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAv/aAAwDAQACEQMRAD8A+W6KKK/n8/18PrCiiivzM/5Yz//Q+E6KKK/1UPw8/o0ooor/AJEz+xD/2Q=="

test("baseline JPEG decodes to its colors and progressive or truncated files are refused", () => {
  const bytes = new Uint8Array(Buffer.from(QUADRANTS_JPEG, "base64"))
  expect(sniffImage(bytes)).toBe("jpeg")
  const image = decodeJpeg(bytes)
  expect([image.width, image.height]).toEqual([32, 32])
  const at = (x: number, y: number) => [...image.rgba.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3)]
  const close = (actual: number[], expected: number[]) => expected.every((value, i) => Math.abs(actual[i]! - value) <= 8)
  expect(close(at(8, 8), [220, 30, 30])).toBe(true)
  expect(close(at(24, 8), [30, 200, 40])).toBe(true)
  expect(close(at(8, 24), [30, 60, 220])).toBe(true)
  expect(close(at(24, 24), [240, 230, 30])).toBe(true)
  const progressive = new Uint8Array(bytes)
  const sof = progressive.findIndex((byte, i) => byte === 0xff && progressive[i + 1] === 0xc0)
  progressive[sof + 1] = 0xc2
  expect(() => decodeJpeg(progressive)).toThrow(/progressive/)
  expect(() => decodeJpeg(bytes.subarray(0, 60))).toThrow()
  expect(() => decodeJpeg(new Uint8Array([1, 2, 3, 4]))).toThrow()
})

// An 8x8 GIF (sips): left half red, right half blue, bottom-right pixel transparent.
const GIF = new Uint8Array(Buffer.from("R0lGODdhCAAIAKIAAAAAAAAA//8AAP///wAAAAAAAAAAAAAAACH5BAkAAAQALAAAAAAIAAgAAAMPKCrRscxB9xad0mZ1dSAJADs=", "base64"))

test("GIF decodes its first frame and transparent pixels stay clear", () => {
  expect(sniffImage(GIF)).toBe("gif")
  const image = decodeGif(GIF)
  expect([image.width, image.height]).toEqual([8, 8])
  const pixel = (x: number, y: number) => [...image.rgba.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)]
  expect(pixel(0, 0)).toEqual([255, 0, 0, 255])
  expect(pixel(7, 0)).toEqual([0, 0, 255, 255])
  expect(pixel(7, 7)[3]).toBe(0)
  expect(() => decodeGif(GIF.subarray(0, 9))).toThrow()
})

test("every format goes through one entry and unknown bytes are refused", async () => {
  const png = encodeImagePng(picture(1600, 800))
  const decoded = await decodeCardImage(png)
  expect(decoded.width).toBe(1280)
  expect(decoded.height).toBe(640)
  await expect(decodeCardImage(new Uint8Array([0, 1, 2, 3]))).rejects.toThrow(/unsupported/)
})

/** Renders until the picture's graphics sequence is written (a loaded CI runner encodes it later than 20 ms), at most 3 s. */
async function painted(h: { app: { render(): void } }, writes: string[]) {
  for (let waited = 0; waited < 3_000 && !writes.join("").includes("\x1b_G"); waited += 20) {
    await Bun.sleep(20)
    h.app.render()
  }
}

const PIE = '```mermaid\npie title Tokens\n"MendCode": 138.543775\n"Codex CLI": 106.64183\n```'

test("a pie is painted as a picture where the terminal draws them: its text disc is blanked, the legend stays beside it", async () => {
  const { h, talk, writes } = await chat()
  talk.exchange("chart it", PIE)
  await painted(h, writes)
  const text = h.text()
  expect(writes.join("")).toContain("\x1b_G")
  expect(text.join("\n")).not.toMatch(/●{4}/)
  expect(text.find((row) => row.includes("MendCode"))).toMatch(/^\s+● MendCode {3}138\.54 {2}56\.5%/)
  expect(text.join("\n")).toContain("Tokens")
})

test("without pictures (the setting off) the same pie is the disc of dots", async () => {
  const { h, talk, writes } = await chat({ profile: { transcriptImages: false } })
  talk.exchange("chart it", PIE)
  await Bun.sleep(20)
  h.app.render()
  expect(h.text().join("\n")).toMatch(/●{10}/)
  expect(h.text().find((row) => row.includes("MendCode"))).toMatch(/●{24} +● MendCode/)
  expect(writes.join("")).not.toContain("\x1b_G")
})

test("the painted pie is a disc on a transparent ground, one colour per slice, a line of the ground between them", async () => {
  const { registerChart, drawChart } = await import("../src/view/chart-picture")
  const key = registerChart({ kind: "pie", slices: [{ share: 0.75, color: "info" }, { share: 0.25, color: "warning" }] })
  const image = drawChart(key, 220, 242)!
  const at = (x: number, y: number) => [...image.rgba.subarray((y * 220 + x) * 4, (y * 220 + x) * 4 + 4)]
  // Corners are outside the disc; right of the centre is the first slice, up and left the second; twelve o'clock is the cut.
  expect(at(2, 2)[3]).toBe(0)
  expect(at(170, 121)[3]).toBe(255)
  expect(at(60, 70)[3]).toBe(255)
  expect(at(170, 121).slice(0, 3)).not.toEqual(at(60, 70).slice(0, 3))
  expect(at(110, 40)[3]).toBeLessThan(255)
  expect(drawChart("chart:unknown", 220, 242)).toBeUndefined()
})

const XY = '```mermaid\nxychart-beta\ntitle "Tokens"\nx-axis [a, b, c]\ny-axis "M" 0 --> 100\nbar [20, 100, 50]\nline [10, 60, 90]\n```'

test("a bar and line chart keeps its axes, ticks and labels as text and has its plot painted as a picture", async () => {
  const { h, talk, writes } = await chat()
  talk.exchange("chart it", XY)
  await painted(h, writes)
  const text = h.text().join("\n")
  expect(writes.join("")).toContain("\x1b_G")
  expect(text).toContain("Tokens")
  expect(text).toMatch(/100 +│/)
  expect(text).toMatch(/└─+▶/)
  expect(text).not.toContain("█")
  const off = await chat({ profile: { transcriptImages: false } })
  off.talk.exchange("chart it", XY)
  await Bun.sleep(20)
  off.h.app.render()
  expect(off.h.text().join("\n")).toContain("█")
})

test("the painted plot has a bar in its series' colour from the zero line to its value, and nothing above it", async () => {
  const { registerChart, drawChart } = await import("../src/view/chart-picture")
  const key = registerChart({ kind: "xy", cols: 30, rows: 10, stride: 10, min: 0, max: 100, series: [{ kind: "bar", values: [50, 100, 0], color: "info" }] })
  const image = drawChart(key, 300, 200)!
  const alpha = (x: number, y: number) => image.rgba[(y * 300 + x) * 4 + 3]!
  // The first bar is centred on x = 55 and reaches half of the range: solid at three quarters of the height, clear at one quarter.
  expect(alpha(55, 150)).toBe(255)
  expect(alpha(55, 40)).toBeLessThan(200)
  // The second reaches the top row's middle; between two bars there is no bar.
  expect(alpha(155, 20)).toBe(255)
  expect(alpha(105, 100)).toBeLessThan(200)
})

test("a radar chart has its web painted and its axis labels and legend left as text; a label that reaches into the web keeps it all text", async () => {
  const { renderMermaid } = await import("../src/view/mermaid")
  const { pictureOf } = await import("../src/view/line-meta")
  const radar = (left: string) => `radar-beta\ntitle Skills\naxis a["Speed"], b["Cost"], c["Quality"], d["Docs"], e["${left}"]\ncurve x["Ours"]{80, 60, 90, 70, 85}\ncurve y["Other"]{60, 80, 70, 50, 60}\nmax 100`
  const drawn = renderMermaid(radar("UX"), 100)
  if (!("lines" in drawn)) throw new Error("no radar")
  const marked = drawn.lines.map(pictureOf).filter((cells) => cells !== undefined)
  expect(marked).toHaveLength(19)
  expect(marked[0]).toMatchObject({ cols: 43, col: 11, rows: 19 })
  // No label has a letter in the web's box, and the legend's marks carry their curve's colour.
  for (const [at, line] of drawn.lines.entries()) {
    const cells = pictureOf(line)
    if (cells) expect(line.map((span) => span.text).join("").slice(cells.col, cells.col + cells.cols)).not.toMatch(/[A-Za-z]/)
    if (at === 1) expect(line.filter((span) => span.text === "●" || span.text === "○").map((span) => span.fg)).toEqual(["info", "warning"])
  }
  const long = renderMermaid(radar("A very long label here"), 100)
  if (!("lines" in long)) throw new Error("no radar")
  expect(long.lines.some((line) => pictureOf(line))).toBe(false)
  const { drawChart } = await import("../src/view/chart-picture")
  const image = drawChart(marked[0]!.key, 430, 418)!
  // The centre is inside both curves; a corner of the box is outside the web.
  expect(image.rgba[(209 * 430 + 215) * 4 + 3]).toBeGreaterThan(40)
  expect(image.rgba[(4 * 430 + 4) * 4 + 3]).toBe(0)
})
