import { describe, expect, test } from "bun:test"
import { chunkBuffers } from "../src/chunk-buffers"
import { sseData } from "../src/openai-responses"

type Detachable = ArrayBuffer & { detached: boolean }

describe("chunk buffers", () => {
  test("a fetched stream's read buffers are released once the reader has moved past them, and every event still arrives", async () => {
    const encoder = new TextEncoder()
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(new ReadableStream({
        async pull(controller) {
          for (let i = 0; i < 12; i++) { controller.enqueue(encoder.encode(`data: {"n":${i}}\n\n`)); await Bun.sleep(5) }
          controller.close()
        },
      }), { headers: { "content-type": "text/event-stream" } }),
    })
    try {
      const response = await fetch(`http://localhost:${server.port}/`)
      const seen: Array<{ buffer: Detachable; oversized: boolean }> = []
      const tee = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { seen.push({ buffer: chunk.buffer as Detachable, oversized: chunk.buffer.byteLength >= 64 * 1024 && chunk.byteLength * 4 <= chunk.buffer.byteLength }); controller.enqueue(chunk) } }))
      const events: string[] = []
      for await (const data of sseData(tee, new AbortController().signal)) events.push(data)
      expect(events).toEqual(Array.from({ length: 12 }, (_, i) => `{"n":${i}}`))
      expect(seen.length).toBeGreaterThan(1)
      expect(seen.filter((each) => each.oversized && !each.buffer.detached)).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("an oversized read buffer is detached when the next chunk comes in another one, and the last one when the reader is done", () => {
    const buffers = chunkBuffers()
    const first = new Uint8Array(new ArrayBuffer(256 * 1024), 0, 40)
    const second = new Uint8Array(new ArrayBuffer(256 * 1024), 0, 40)
    buffers.read(first)
    expect((first.buffer as Detachable).detached).toBe(false)
    buffers.read(second)
    expect((first.buffer as Detachable).detached).toBe(true)
    expect((second.buffer as Detachable).detached).toBe(false)
    buffers.done()
    expect((second.buffer as Detachable).detached).toBe(true)
  })

  test("bytes a caller still holds, sized to what they carry, are never detached", () => {
    const buffers = chunkBuffers()
    const owned = new TextEncoder().encode("data: {}\n\n")
    const large = new Uint8Array(128 * 1024)
    buffers.read(owned)
    buffers.read(large)
    buffers.read(new Uint8Array(8))
    buffers.done()
    expect((owned.buffer as Detachable).detached).toBe(false)
    expect((large.buffer as Detachable).detached).toBe(false)
    expect(new TextDecoder().decode(owned)).toBe("data: {}\n\n")
  })

  test("chunks that share one read buffer keep it until the reader leaves it", () => {
    const buffers = chunkBuffers()
    const shared = new ArrayBuffer(256 * 1024)
    buffers.read(new Uint8Array(shared, 0, 10))
    buffers.read(new Uint8Array(shared, 10, 10))
    expect((shared as Detachable).detached).toBe(false)
    buffers.done()
    expect((shared as Detachable).detached).toBe(true)
  })
})
