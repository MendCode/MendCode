import { expect, test } from "bun:test"
import { packDeltaLengths, unpackDeltaLengths } from "../src/delta-lengths"

test("length blocks reproduce split UTF-16 surrogates, empty chunks, seq gaps and clock reversal", () => {
  const chunks = ["a\ud83d", "\ude80", "", "\ud800", "x🚀"]
  const entries = chunks.map((text, i) => [4 + i * 2, 1700000000000 - i, text, null, null, null])
  const packed = packDeltaLengths(JSON.stringify(entries), chunks.join(""))!
  expect(packed).toBeDefined()
  expect(unpackDeltaLengths(packed, chunks.join(""))).toEqual(entries.map(e => [e[0], e[1], e[2]] as [number, number, string]))
  expect(unpackDeltaLengths(packed, chunks.join("")).filter(e => e[0] < 8).map(e => e[2])).toEqual(chunks.slice(0, 2))
})

test("different final text and input or compressed deltas retain the old block", () => {
  for (const entry of [[1, 1, "a", null, null, null], [1, 1, "ab", {}, null, null], [1, 1, "ab", null, 2, null], [1, 1, "ab", null, null, "ref"]]) {
    expect(packDeltaLengths(JSON.stringify([entry]), "ab")).toBeUndefined()
  }
})

const stream = (lengths: number[], at = (i: number) => 1700000000000 + Math.floor(i / 9)) => {
  const chunks = lengths.map((n, i) => String.fromCharCode(97 + (i % 26)).repeat(n))
  const entries = chunks.map((text, i) => [10 + i, at(i), text, null, null, null])
  return { chunks, entries, packed: packDeltaLengths(JSON.stringify(entries), chunks.join(""))! }
}

test("a steady stream is written as columns and reads back exactly", () => {
  const { chunks, entries, packed } = stream(Array.from({ length: 60 }, () => 3), () => 1700000000000)
  expect(Array.from(packed.slice(0, 4))).toEqual([0x4d, 0x44, 0x4c, 2])
  expect(packed.length).toBeLessThan(30)
  expect(unpackDeltaLengths(packed, chunks.join(""))).toEqual(entries.map(e => [e[0], e[1], e[2]] as [number, number, string]))
})

test("mixed literals and runs, runs longer than one varint byte, zero-length chunks and clock reversals round-trip", () => {
  const lengths = [1, 5, 2, 7, 7, 7, 7, 7, 0, 0, 0, 4, 9, 9, 3, ...Array.from({ length: 300 }, () => 2), 8, 1]
  const { chunks, entries, packed } = stream(lengths, i => 1700000000000 + (i % 40 === 39 ? -3 : Math.floor(i / 7)))
  expect(unpackDeltaLengths(packed, chunks.join(""))).toEqual(entries.map(e => [e[0], e[1], e[2]] as [number, number, string]))
})

test("an irregular short block keeps whichever form is smaller and both forms decode", () => {
  const lengths = [4, 9, 2]
  const { chunks, entries, packed } = stream(lengths)
  expect(unpackDeltaLengths(packed, chunks.join(""))).toEqual(entries.map(e => [e[0], e[1], e[2]] as [number, number, string]))
  const interleaved = Uint8Array.from([0x4d, 0x44, 0x4c, 1, 3, 10, 0, 4, 1, 0, 9, 1, 0, 2])
  expect(unpackDeltaLengths(interleaved, chunks.join("")).map(e => e[2])).toEqual(chunks)
})

test("a truncated or inconsistent column block is rejected", () => {
  const { chunks, packed } = stream(Array.from({ length: 30 }, () => 3))
  expect(() => unpackDeltaLengths(packed.slice(0, packed.length - 1), chunks.join(""))).toThrow(RangeError)
  expect(() => unpackDeltaLengths(packed, chunks.join("") + "x")).toThrow(RangeError)
  const zeroGroup = Uint8Array.from([0x4d, 0x44, 0x4c, 2, 2, 0, 0, 0])
  expect(() => unpackDeltaLengths(zeroGroup, "ab")).toThrow(RangeError)
})
