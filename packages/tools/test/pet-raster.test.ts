import { expect, test } from "bun:test"
import { encodeImagePng } from "../src/pet-png"
import { decodePng } from "../src/pet-decode"
import { petAtlas, petFrame, petScale, pingPong, validatePetFrame } from "../src/pet-raster"
import { PET_CORE_STATES } from "../../protocol/src/pet-data"

import { fixturePng } from "./pet-fixture"

test("crop, integer nearest-neighbour, fixed palette and alpha are deterministic", () => {
  const image = petFrame(fixturePng())
  expect(image).toEqual(petFrame(fixturePng()))
  expect(image.width).toBe(32)
  expect(image.height).toBe(32)
  validatePetFrame(image)
  const colors = new Set(Array.from({ length: 1024 }, (_, index) => [...image.rgba.slice(index * 4, index * 4 + 4)].join(",")))
  expect(colors).toEqual(new Set(["0,0,0,0", "109,182,255,255"]))
  expect(decodePng(encodeImagePng(image))).toEqual(image)
})

test("invalid, empty, opaque and wrong-sized frames are refused", () => {
  expect(() => petFrame(new Uint8Array([1]))).toThrow("signature")
  expect(() => petFrame(encodeImagePng({ width: 32, height: 32, rgba: new Uint8Array(4096) }))).toThrow("empty")
  expect(() => petFrame(encodeImagePng({ width: 32, height: 32, rgba: new Uint8Array(4096).fill(255) }))).toThrow("transparent")
  expect(() => validatePetFrame({ width: 1, height: 1, rgba: new Uint8Array(4) })).toThrow("32x32")
  const image = petFrame(fixturePng())
  image.rgba[3] = 100
  expect(() => validatePetFrame(image)).toThrow("binary")
  expect(() => petAtlas({ idle: image })).toThrow("Missing")
})

test("atlas matches installed format and missing optional states use idle", () => {
  const image = petFrame(fixturePng())
  const frames = Object.fromEntries(PET_CORE_STATES.map((state) => [state, image]))
  const atlas = decodePng(petAtlas(frames))
  expect([atlas.width, atlas.height]).toEqual([256, 288])
  for (let line = 0; line < 32; line++) expect(atlas.rgba.slice((3 * 32 + line) * 256 * 4, ((3 * 32 + line) * 256 + 32) * 4)).toEqual(image.rgba.slice(line * 128, (line + 1) * 128))
})

test("states drawn at the reference's scale keep the character's size; a pose too big for it still fits", () => {
  // A 120 px tall figure on a 256 px canvas, and the same figure drawn smaller (60 px) in another state.
  const figure = (size: number) => {
    const rgba = new Uint8Array(256 * 256 * 4)
    for (let y = 256 - size; y < 256; y++) for (let x = 100; x < 100 + size / 2; x++) rgba.set([255, 0, 0, 255], (y * 256 + x) * 4)
    return encodeImagePng({ width: 256, height: 256, rgba })
  }
  const height = (image: { rgba: Uint8Array }) => new Set(Array.from({ length: 1024 }, (_, i) => i).filter((i) => image.rgba[i * 4 + 3] === 255).map((i) => Math.floor(i / 32))).size
  const scale = petScale(figure(120))
  expect(height(petFrame(figure(120), scale))).toBe(30)
  expect(height(petFrame(figure(60), scale))).toBe(15)
  // Fitted on its own, the small state would grow back to the frame's height.
  expect(height(petFrame(figure(60)))).toBe(30)
  expect(height(petFrame(figure(240), scale))).toBeLessThanOrEqual(30)
})

test("a state's frames play there and back across its row, so the loop never jumps", () => {
  expect(Array.from({ length: 8 }, (_, col) => pingPong(col, 3))).toEqual([0, 1, 2, 1, 0, 1, 2, 1])
  expect(Array.from({ length: 6 }, (_, col) => pingPong(col, 1))).toEqual([0, 0, 0, 0, 0, 0])
  const still = petFrame(fixturePng())
  const moved = { ...still, rgba: still.rgba.slice() }
  const opaque = Array.from({ length: 1024 }, (_, i) => i).find((i) => still.rgba[i * 4 + 3] === 255)!
  moved.rgba.set([0, 0, 0, 0], opaque * 4)
  const atlas = decodePng(petAtlas({ idle: [still, moved], running: still, waiting: still, review: still, failed: still }))
  const cell = (row: number, col: number) => Buffer.from(Array.from({ length: 32 }, (_, line) => [...atlas.rgba.subarray(((row * 32 + line) * atlas.width + col * 32) * 4, ((row * 32 + line) * atlas.width + col * 32 + 32) * 4)]).flat()).toString("hex")
  expect(cell(0, 0)).not.toBe(cell(0, 1))
  expect(cell(0, 0)).toBe(cell(0, 2))
})
