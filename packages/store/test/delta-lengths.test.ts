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
