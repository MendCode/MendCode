import { expect, test } from "bun:test"
import { createBlobReads } from "../src/blob-reads"

const blob = (size: number, seed: number) => Buffer.from(new Uint8Array(size).map((_, i) => (i * seed) & 255))

test("a blob read chunk by chunk is read from disk once and let go after its last chunk", () => {
  const files = new Map([["a", blob(250, 7)]])
  let reads = 0
  const blobs = createBlobReads({ read: (sha) => { reads++; return files.get(sha)! } })
  const parts = [blobs.chunk("a", 0, 100), blobs.chunk("a", 100, 100), blobs.chunk("a", 200, 100)]
  expect(Buffer.concat(parts)).toEqual(files.get("a")!)
  expect(reads).toBe(1)
  expect(blobs.size).toBe(0)
})

test("a blob that fits one chunk is never held; several read at once are held up to the limit", () => {
  const files = new Map(["a", "b", "c"].map((sha, i) => [sha, blob(300, i + 3)]))
  let reads = 0
  const blobs = createBlobReads({ read: (sha) => { reads++; return files.get(sha)! }, keep: 2 })
  expect(blobs.chunk("a", 0, 500).length).toBe(300)
  expect(blobs.size).toBe(0)
  for (const sha of ["a", "b", "c"]) blobs.chunk(sha, 0, 100)
  expect(blobs.size).toBe(2)
  // "a" was dropped to stay within two: its next chunk reads the file again, and is still right.
  expect(blobs.chunk("a", 100, 100)).toEqual(files.get("a")!.subarray(100, 200))
  expect(reads).toBe(5)
})

test("a read abandoned halfway is let go after the quiet time", async () => {
  const blobs = createBlobReads({ read: () => blob(300, 5), ttlMs: 20 })
  blobs.chunk("a", 0, 100)
  expect(blobs.size).toBe(1)
  await Bun.sleep(60)
  expect(blobs.size).toBe(0)
})
