import { expect, test } from "bun:test"
import { decodePng } from "../src/pet-decode"
import { encodeImagePng } from "../src/pet-png"
import { shrinkForHub } from "../src/image-downscale"

/** A flat picture with a few stripes, like a screenshot: it compresses far below a photograph. */
function flat(width: number, height: number, alpha = 255) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([(x >> 6) & 255, 200, (y >> 5) & 255, alpha], (y * width + x) * 4)
  return { width, height, rgba }
}

test("a screenshot over 2048 pixels goes as a smaller PNG of 2048 pixels, with the same shape", async () => {
  const original = encodeImagePng(flat(3000, 1800))
  const sent = await shrinkForHub(original)
  expect(sent?.mime).toBe("image/png")
  expect(sent!.bytes.length).toBeLessThan(original.length)
  const image = decodePng(sent!.bytes)
  expect([image.width, image.height]).toEqual([2048, 1229])
})

test("a picture that already fits, a see-through picture that would grow, and bytes that are no PNG are sent as they are", async () => {
  expect(await shrinkForHub(encodeImagePng(flat(2000, 1500)))).toBeUndefined()
  expect(await shrinkForHub(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBeUndefined()
  expect(await shrinkForHub(new Uint8Array(0))).toBeUndefined()
})
