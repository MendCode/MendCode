import { expect, test } from "bun:test"
import { readPipedStdin, STDIN_FIRST_BYTE_MS } from "../src/run-stdin"

const bytes = (text: string) => new TextEncoder().encode(text)

/** A stdin whose writer does what `script` says; `cancelled` tells whether the reader gave it up. */
function pipe(script: (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) {
  const state = { cancelled: false }
  const stream = new ReadableStream<Uint8Array>({ start(controller) { void script(controller) }, cancel() { state.cancelled = true } })
  return { stream, state }
}

test("with a message, a stdin that is open but never written is skipped after the wait", async () => {
  const idle = pipe(() => {})
  const started = performance.now()
  expect(await readPipedStdin({ stream: idle.stream, wait: "first-byte", waitMs: 40 })).toEqual({ text: "", skipped: true })
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(idle.state.cancelled).toBe(true)
})

test("a writer that closes at once, with or without data, is read whole and never counts as skipped", async () => {
  const echo = pipe((controller) => { controller.enqueue(bytes("piped text\n")); controller.close() })
  expect(await readPipedStdin({ stream: echo.stream, wait: "first-byte", waitMs: 40 })).toEqual({ text: "piped text\n", skipped: false })
  const empty = pipe((controller) => controller.close())
  expect(await readPipedStdin({ stream: empty.stream, wait: "first-byte", waitMs: 40 })).toEqual({ text: "", skipped: false })
})

test("once the first byte arrived, a slow producer is read to its end, well past the wait", async () => {
  const slow = pipe(async (controller) => {
    controller.enqueue(bytes("a"))
    for (const part of ["b", "c", "d"]) { await Bun.sleep(60); controller.enqueue(bytes(part)) }
    controller.close()
  })
  expect(await readPipedStdin({ stream: slow.stream, wait: "first-byte", waitMs: 40 })).toEqual({ text: "abcd", skipped: false })
})

test("a multi-byte character split across chunks survives", async () => {
  const [head, tail] = [bytes("é").slice(0, 1), bytes("é").slice(1)]
  const split = pipe((controller) => { controller.enqueue(head); controller.enqueue(tail); controller.close() })
  expect((await readPipedStdin({ stream: split.stream, wait: "first-byte", waitMs: 40 })).text).toBe("é")
})

test("without a message (or with -) stdin is the prompt: the read waits past the first-byte limit", async () => {
  const late = pipe(async (controller) => { await Bun.sleep(120); controller.enqueue(bytes("late prompt")); controller.close() })
  expect(await readPipedStdin({ stream: late.stream, wait: "end", waitMs: 40 })).toEqual({ text: "late prompt", skipped: false })
})

test("the default wait is one second", () => {
  expect(STDIN_FIRST_BYTE_MS).toBe(1_000)
})
