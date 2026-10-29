import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { probeCodexQuota, type Transport } from "../src"

/** A stand-in for `codex app-server`: answers each request by method, and records every line MendCode writes. */
function fakeAppServer(answers: Record<string, unknown | (() => never)>) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let done = false
  const written: any[] = []
  let closed = 0
  const transport: Transport = {
    write(line) {
      const message = JSON.parse(line)
      written.push(message)
      if (message.id === undefined) return
      const answer = answers[message.method]
      queue.push(JSON.stringify(answer === undefined ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${message.method}` } } : { jsonrpc: "2.0", id: message.id, result: answer }))
      wake?.()
    },
    lines: (async function* () {
      while (!done || queue.length) {
        if (queue.length) { yield queue.shift()!; continue }
        await new Promise<void>((resolve) => (wake = resolve))
      }
    })(),
    close() { closed += 1; done = true; wake?.() },
    exited: Promise.resolve(0),
  }
  return { transport, written, closed: () => closed }
}

const limits = { rateLimits: { planType: "plus", primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_791_036_000 }, secondary: { usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_791_400_000 } } }

describe("codex quota probe", () => {
  test("reads the windows from account/rateLimits/read and sends nothing to a model", async () => {
    const fake = fakeAppServer({ initialize: { userAgent: "codex" }, "account/rateLimits/read": limits })
    const reported: any[] = []
    let cwd: string | undefined
    await probeCodexQuota({ cwd: "/probe-dir", transportFactory: (input) => { cwd = input.cwd; return fake.transport }, clock: createVirtualClock(7), onQuota: (quota) => reported.push(quota) })
    expect(cwd).toBe("/probe-dir")
    expect(fake.written.map((message) => message.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"])
    // No thread, no turn: the only calls are the handshake and the read.
    expect(fake.written.some((message) => /thread|turn/i.test(message.method))).toBe(false)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ provider: "codex", plan: "plus", windows: [{ label: "5h", usedPercent: 8 }, { label: "7d", usedPercent: 61 }], fetchedAt: 7 })
    expect(fake.closed()).toBeGreaterThanOrEqual(1)
  })

  test("a server that reports no window is a failure, and the process is still stopped", async () => {
    const fake = fakeAppServer({ initialize: {}, "account/rateLimits/read": { rateLimits: null } })
    await expect(probeCodexQuota({ transportFactory: () => fake.transport, onQuota: () => {} })).rejects.toThrow(/no rate limits/)
    expect(fake.closed()).toBeGreaterThanOrEqual(1)
  })

  test("an error from the server is a failure", async () => {
    const fake = fakeAppServer({ initialize: {} })
    await expect(probeCodexQuota({ transportFactory: () => fake.transport, onQuota: () => {} })).rejects.toThrow(/account\/rateLimits\/read/)
    expect(fake.closed()).toBeGreaterThanOrEqual(1)
  })
})
