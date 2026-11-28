import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { decodePng } from "./pet-decode"
import { isOpaque, resizeRgba } from "./image-resize"
import { encodeImagePng } from "./pet-png"

/** Longest side of a picture sent to a hub: the models shrink pictures to 1568 to 2048 pixels themselves, so more pixels only cost upload time. */
export const HUB_IMAGE_MAX_SIDE = 2048
/** A PNG that takes more bytes per pixel than this is a photograph, not a screenshot (a screenshot's flat areas compress far below it). */
const PHOTO_BYTES_PER_PIXEL = 0.8
const JPEG_QUALITY = 85
const SIPS = "/usr/bin/sips"

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export type HubPicture = { bytes: Uint8Array; mime: "image/png" | "image/jpeg" }

/**
 * What to send a hub for a PNG whose longest side is over `maxSide`, or undefined to send the file as it is (not a PNG this decoder
 * reads, not bigger than `maxSide`, or nothing smaller came out). A screenshot goes as a smaller PNG; an opaque photograph goes as a
 * JPEG of quality 85 where macOS can write one (`sips`), else as a smaller PNG. Only the copy sent changes: the caller keeps the file.
 */
export async function shrinkForHub(bytes: Uint8Array, maxSide = HUB_IMAGE_MAX_SIDE): Promise<HubPicture | undefined> {
  if (!PNG_SIGNATURE.every((byte, at) => bytes[at] === byte)) return undefined
  try {
    const image = decodePng(bytes)
    const longest = Math.max(image.width, image.height)
    if (longest <= maxSide) return undefined
    if (process.platform === "darwin" && bytes.length / (image.width * image.height) > PHOTO_BYTES_PER_PIXEL && isOpaque(image)) {
      const jpeg = await sipsJpeg(bytes, maxSide)
      if (jpeg && jpeg.length < bytes.length) return { bytes: jpeg, mime: "image/jpeg" }
    }
    const factor = maxSide / longest
    const png = encodeImagePng(resizeRgba(image, Math.max(1, Math.round(image.width * factor)), Math.max(1, Math.round(image.height * factor))))
    return png.length < bytes.length ? { bytes: png, mime: "image/png" } : undefined
  } catch {
    return undefined
  }
}

/** The picture shrunk to `maxSide` and written as a JPEG by macOS's own `sips`; undefined when it fails or takes over ten seconds. */
async function sipsJpeg(bytes: Uint8Array, maxSide: number): Promise<Uint8Array | undefined> {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-hub-image-"))
  try {
    const input = path.join(dir, "in.png")
    const output = path.join(dir, "out.jpg")
    writeFileSync(input, bytes, { mode: 0o600 })
    const child = Bun.spawn([SIPS, "-Z", String(maxSide), "-s", "format", "jpeg", "-s", "formatOptions", String(JPEG_QUALITY), input, "--out", output], { stdout: "ignore", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), 10_000)
    const code = await child.exited.finally(() => clearTimeout(timer))
    return code === 0 ? readFileSync(output) : undefined
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
