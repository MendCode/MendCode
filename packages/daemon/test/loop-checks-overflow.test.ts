import { expect, spyOn, test } from "bun:test"
import { RUNNER_FULL_OUTPUT_BYTES as LIMIT, runLoopCheck } from "../src/loop-checks"

async function capture(chunks: Uint8Array[]) {
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    pid: 1,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    exited: Promise.resolve(0),
  })) as unknown as typeof Bun.spawn)
  try {
    return await runLoopCheck({ argv: ["fixture"], cwd: process.cwd(), signal: new AbortController().signal, fullOutput: true })
  } finally {
    spawn.mockRestore()
  }
}

test("full output counts decoded bytes, not BOM bytes or a buffered UTF-8 suffix", async () => {
  const prefix = "x".repeat(LIMIT - 2)
  const result = await capture([
    Buffer.from(`\ufeff${prefix}`),
    new Uint8Array([0xe2]),
    new Uint8Array([0x82, 0xac]),
  ])
  expect(result.full).toBe(`${prefix}€`)
  // The final chunk passed the limit, but the runner itself discarded nothing.
  expect(result.fullTruncated).toBe(false)
})

test("full output at the limit is not truncated", async () => {
  const result = await capture([Buffer.from("x".repeat(LIMIT))])
  expect(result.full).toHaveLength(LIMIT)
  expect(result.fullTruncated).toBe(false)
})

test("full output reports overflow only after decoded text is actually discarded", async () => {
  const result = await capture([
    Buffer.from("x".repeat(LIMIT + 1)),
    new Uint8Array([0xe2]),
    new Uint8Array([0x82, 0xac]),
  ])
  expect(result.full).toBe("x".repeat(LIMIT + 1))
  expect(result.fullTruncated).toBe(true)
  expect(result.output.endsWith("€")).toBe(true)
})

test("an unfinished UTF-8 sequence is flushed at end of stream", async () => {
  const result = await capture([new Uint8Array([0xe2])])
  expect(result.full).toBe("\ufffd")
  expect(result.output).toBe("\ufffd")
  expect(result.fullTruncated).toBe(false)
})
