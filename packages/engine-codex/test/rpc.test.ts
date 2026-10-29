import { expect, test } from "bun:test"
import { createRpc, type Transport } from "../src"

/** A transport whose server lines are pushed by the test; `fail` makes its reader throw. */
function fakeTransport() {
  const queue: Array<string | Error> = []
  let wake: (() => void) | undefined
  let closed = 0
  const written: string[] = []
  const transport: Transport = {
    write: (line) => void written.push(line),
    lines: (async function* () {
      while (true) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve))
        const next = queue.shift()!
        if (next instanceof Error) throw next
        yield next
      }
    })(),
    close: () => void closed++,
    exited: new Promise<number>(() => {}),
  }
  const push = (line: string | Error) => (queue.push(line), wake?.())
  return { transport, push, written, closes: () => closed }
}

test("a line that is valid JSON but no message, or a notification the engine cannot map, leaves the reader answering", async () => {
  const fake = fakeTransport()
  const rpc = createRpc(fake.transport, { notification: () => { throw new Error("unmapped") }, request: async () => ({}) })
  const answer = rpc.request("thread/start")
  fake.push("null")
  fake.push("42")
  fake.push(JSON.stringify({ method: "item/started", params: {} }))
  fake.push(JSON.stringify({ id: 1, result: { ok: true } }))
  expect(await answer).toEqual({ ok: true })
})

test("a reader that fails rejects what waits and stops the process, so its exit ends the turns", async () => {
  const fake = fakeTransport()
  const rpc = createRpc(fake.transport, { notification: () => {}, request: async () => ({}) })
  const answer = rpc.request("thread/start")
  fake.push(new Error("stdout broke"))
  await expect(answer).rejects.toThrow("app-server exited")
  expect(fake.closes()).toBe(1)
})
