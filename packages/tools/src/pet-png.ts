import { deflateSync } from "node:zlib"
import type { PetImage } from "./pet-decode"

export function validateImage(image: PetImage) {
  if (![image.width, image.height].every((side) => Number.isInteger(side) && side > 0 && side <= 4096)) throw new RangeError("Invalid image dimensions")
  if (image.rgba.length !== image.width * image.height * 4) throw new RangeError("RGBA size does not match dimensions")
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array) {
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 4, "ascii")
  out.set(body, 8)
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4)
  return out
}

export function encodeImagePng(image: PetImage): Uint8Array {
  validateImage(image)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  const stride = image.width * 4
  const pixels = new Uint8Array((stride + 1) * image.height)
  for (let row = 0; row < image.height; row++) pixels.set(image.rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", new Uint8Array())])
}
