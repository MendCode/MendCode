import { expect, test } from "bun:test"
import { createImageHost, imageHostCommand } from "../src/ui/image-host"
import { createFrameReader, encodeFrame } from "../../../packages/tools/src/framed-host"
import { encodeImagePng } from "../src/ui/image-protocol"
import { decodeCardImage, imageSize, renderCardImage } from "../src/ui/image-decode"
import { keptSize } from "../src/ui/image-fit"

/** A picture whose pixels differ everywhere, so a wrong row or column in the host's answer shows. */
function noisy(width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y + 7) & 255, 255], (y * width + x) * 4)
  return { width, height, rgba }
}

test("frames split at any byte come back whole and in order", () => {
  const payload = new Uint8Array(70_000).map((_, i) => i & 255)
  const wire = new Uint8Array([...encodeFrame({ id: 1, op: "decode" }, payload), ...encodeFrame({ id: 2, ok: false, error: "no" })])
  const reader = createFrameReader<{ id: number }>()
  const frames = []
  for (let at = 0; at < wire.length; at += 997) frames.push(...reader.push(wire.subarray(at, at + 997)))
  expect(frames.map((frame) => frame.header.id)).toEqual([1, 2])
  expect(frames[0]!.payload).toEqual(payload)
  expect(frames[1]!.payload.length).toBe(0)
})

test("the host draws a picture exactly as the terminal would, and a broken one is refused without stopping it", async () => {
  const host = createImageHost({ command: imageHostCommand(), idleMs: 60_000 })
  try {
    const png = encodeImagePng(noisy(1600, 400))
    const [drawn, kept] = await Promise.all([host.render(png, 300, 75), host.decode(png)])
    expect(drawn).toEqual(await renderCardImage(png, 300, 75))
    expect({ width: kept.width, height: kept.height }).toEqual(keptSize({ width: 1600, height: 400 }))
    expect(kept.rgba).toEqual((await decodeCardImage(png)).rgba)
    await expect(host.decode(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow("unsupported image format")
    expect(host.broken).toBe(false)
    expect((await host.render(png, 40, 10)).width).toBe(40)
  } finally {
    host.close()
  }
})

test("a host that cannot start is marked broken, so the terminal decodes in its own process", async () => {
  const host = createImageHost({ command: ["/nonexistent/mendcode-image-host"] })
  await expect(host.decode(encodeImagePng(noisy(4, 4)))).rejects.toThrow()
  expect(host.broken).toBe(true)
})

test("a host left idle stops, and the next picture starts it again", async () => {
  const host = createImageHost({ command: imageHostCommand(), idleMs: 50 })
  try {
    const png = encodeImagePng(noisy(20, 10))
    await host.decode(png)
    expect(host.running).toBe(true)
    for (let i = 0; i < 100 && host.running; i++) await Bun.sleep(20)
    expect(host.running).toBe(false)
    expect((await host.decode(png)).width).toBe(20)
  } finally {
    host.close()
  }
})

test("picture sizes come from the header; kinds the decoders refuse are left for decoding to report", () => {
  const png = encodeImagePng(noisy(321, 123))
  expect(imageSize(png)).toEqual({ width: 321, height: 123 })
  expect(imageSize(png.subarray(0, 20))).toBeUndefined()
  const interlaced = new Uint8Array(png)
  interlaced[28] = 1
  expect(imageSize(interlaced)).toBeUndefined()
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00])
  expect(imageSize(gif)).toEqual({ width: 16, height: 32 })
  // SOI, an APP0 segment of 16 bytes, then SOF0 with height 48 and width 64.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0])
  expect(imageSize(jpeg)).toEqual({ width: 64, height: 48 })
  expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined()
})
