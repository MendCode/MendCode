import { encodeImagePng } from "../src/pet-png"

export function fixturePng() {
  const width = 64, height = 64, rgba = new Uint8Array(width * height * 4)
  for (let row = 12; row < 52; row++) for (let col = 18; col < 46; col++) rgba.set([103, 174, 221, 255], (row * width + col) * 4)
  return encodeImagePng({ width, height, rgba })
}
