import { expect, test } from "bun:test"
import { connectPatiently, isTransientConnectError } from "../src/connect-patiently"

function fakeClients(failures: Error[]) {
  const built: Array<{ closed: boolean }> = []
  const build = () => {
    const failure = failures[built.length]
    const client = { closed: false, connect: async () => { if (failure) throw failure }, close: () => void (client.closed = true) }
    built.push(client)
    return client
  }
  return { built, build }
}

test("a daemon that misses the handshake deadline while the computer is busy is asked again with a new client, not a crash", async () => {
  const { built, build } = fakeClients([new Error("[CLIENT]: [CLIENT]: no reply to hello within 15000 ms"), new Error("[CLIENT]: connection timeout")])
  const waits: number[] = []
  const client = await connectPatiently({ build, onWait: (attempt) => void waits.push(attempt), delayMs: () => 1 })
  expect(client).toBe(built[2]!)
  expect(waits).toEqual([1, 2])
  // The clients that failed are closed; the one that connected stays open.
  expect(built.map((entry) => entry.closed)).toEqual([true, true, false])
})

test("a refusal that waiting cannot fix (an older build, a wrong secret) fails at once", async () => {
  const refusal = new Error("[CLIENT]: daemon rejected hello: older build")
  const { built, build } = fakeClients([refusal])
  await expect(connectPatiently({ build, delayMs: () => 1 })).rejects.toBe(refusal)
  expect(built).toHaveLength(1)
  expect(isTransientConnectError(new Error("[CLIENT]: local daemon refused the endpoint secret"))).toBe(false)
})

test("a daemon that never answers still fails after the last attempt, with its own error", async () => {
  const timeout = new Error("[CLIENT]: no reply to hello within 15000 ms")
  const { built, build } = fakeClients(Array.from({ length: 10 }, () => timeout))
  await expect(connectPatiently({ build, attempts: 3, delayMs: () => 1 })).rejects.toBe(timeout)
  expect(built).toHaveLength(3)
})
