import { expect, test } from "bun:test"
import { drain, drainCooperatively, type Steps } from "../src/ui/cooperate"
import { decodeCardImage } from "../src/ui/image-decode"
import { encodeImagePng } from "../src/ui/image-protocol"
import { limitSide, limitSideSteps, resizeRgba, resizeRgbaSteps } from "../src/ui/image-fit"
import { decodePng } from "../../../packages/tools/src/pet-decode"

/** Event-loop turns that ran while `work` was pending. */
async function turnsDuring<T>(work: Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0
  let running = true
  const ticker = (async () => {
    while (running) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      turns++
    }
  })()
  const result = await work
  running = false
  await ticker
  return { result, turns }
}

function gradient(width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([(x * 7 + y) & 255, (x + y * 3) & 255, (x * y) & 255, 255], (y * width + x) * 4)
  return { width, height, rgba }
}

function* busySteps(count: number, millis: number): Steps<number> {
  for (let i = 0; i < count; i++) {
    const until = performance.now() + millis
    while (performance.now() < until) { /* hold the thread, as a decoder row does */ }
    yield
  }
  return count
}

test("cooperative draining serves the event loop between slices and returns the same result as draining at once", async () => {
  const { result, turns } = await turnsDuring(drainCooperatively(busySteps(20, 1), 3))
  expect(result).toBe(20)
  expect(turns).toBeGreaterThanOrEqual(3)
  expect(drain(busySteps(3, 0))).toBe(3)
})

test("scaling by steps gives the pixels of the one-shot resize", () => {
  const source = gradient(97, 61)
  expect(drain(resizeRgbaSteps(source, 40, 25)).rgba).toEqual(resizeRgba(source, 40, 25).rgba)
  expect(drain(limitSideSteps(source, 50)).width).toBe(limitSide(source, 50).width)
})

test("a large PNG attachment decodes with the event loop served meanwhile, to the same pixels as the one-shot path", async () => {
  const bytes = encodeImagePng(gradient(2400, 1600))
  const { result, turns } = await turnsDuring(decodeCardImage(bytes))
  expect(turns).toBeGreaterThanOrEqual(2)
  const expected = limitSide(decodePng(bytes))
  expect([result.width, result.height]).toEqual([expected.width, expected.height])
  expect(result.rgba).toEqual(expected.rgba)
})
