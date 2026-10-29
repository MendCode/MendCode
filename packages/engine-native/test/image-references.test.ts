import { expect, test } from "bun:test"
import type { BlobRef } from "@mendcode/protocol"
import type { ModelMessage } from "../src/provider"
import { recentImageReferences } from "../src/image-references"

const ref = (id: string, mime = "image/png"): BlobRef => ({ sha256: id.repeat(64), mime, bytes: 10 })
test("recent references deduplicate session blobs and retain chronological order", async () => {
  const a = ref("a"), b = ref("b"), c = ref("c")
  const messages: ModelMessage[] = [{ role: "user", content: "old", attachments: [a] }, { role: "user", content: "new", attachments: [b, c, ref("d", "application/pdf")] }, { role: "user", content: "reused", attachments: [c] }]
  const reads: string[] = []
  const result = await recentImageReferences(messages, 2, async (r) => { reads.push(r.sha256); return new Uint8Array([1]) })
  expect(reads).toEqual([b.sha256, c.sha256])
  expect(result).toHaveLength(2)
  expect(await recentImageReferences(messages, 1)).toEqual([])
})
test("oversized references are refused without reading their bytes", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "image", attachments: [{ ...ref("a"), bytes: 51 * 1024 * 1024 }] }]
  let reads = 0
  await expect(recentImageReferences(messages, 1, async () => { reads++; return new Uint8Array() })).rejects.toThrow("50 MB")
  expect(reads).toBe(0)
})
