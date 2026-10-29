import { expect, test } from "bun:test"
import { createPiPeer } from "../src/rpc"
import { GATE_READY, GATE_STATUS_KEY } from "../src/gate"

test("the per-process handshake is delivered intact but its challenge never enters RPC traces", async () => {
  const token = "private-process-challenge"
  const traces: string[] = [], events: unknown[] = []
  const message = { type: "extension_ui_request", method: "setStatus", statusKey: GATE_STATUS_KEY, statusText: `${GATE_READY}:${token}` }
  const peer = createPiPeer({
    trace: (_, line) => traces.push(line), handlers: { onEvent: (event) => events.push(event), onClosed: () => {} },
    transport: {
      write: () => {}, close: () => {}, stderrTail: () => "", exited: Promise.resolve(0),
      lines: (async function* () { yield JSON.stringify(message) })(),
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(events).toEqual([message])
  expect(traces).toHaveLength(1)
  expect(traces[0]).not.toContain(token)
  expect(traces[0]).not.toContain("statusText")
  peer.close()
})

test("pi RPC traces redact credentials in both directions without altering transport data", async () => {
  const secret = "ghp_" + "a".repeat(36)
  const traces: string[] = [], writes: string[] = [], events: unknown[] = []
  const peer = createPiPeer({
    trace: (_, line) => traces.push(line), handlers: { onEvent: (event) => events.push(event), onClosed: () => {} },
    transport: {
      write: (line) => writes.push(line), close: () => {}, stderrTail: () => "", exited: Promise.resolve(0),
      lines: (async function* () { yield JSON.stringify({ type: "message_end", message: secret }) })(),
    },
  })
  peer.send({ type: "extension_ui_response", value: secret })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(traces).toHaveLength(2)
  expect(traces.some((line) => line.includes(secret))).toBe(false)
  expect(writes[0]).toContain(secret)
  expect(JSON.stringify(events)).toContain(secret)
  peer.close()
})

test("pi traces do not retain secrets split across streaming message frames", async () => {
  const secret = "ghp_" + "b".repeat(36)
  const traces: string[] = []
  const peer = createPiPeer({
    trace: (_, line) => traces.push(line), handlers: { onEvent: () => {}, onClosed: () => {} },
    transport: {
      write: () => {}, close: () => {}, stderrTail: () => "", exited: Promise.resolve(0),
      lines: (async function* () {
        for (let i = 0; i < secret.length; i += 4) yield JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: secret.slice(i, i + 4) } })
      })(),
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = traces.map((line) => JSON.parse(line).assistantMessageEvent?.delta ?? "").join("")
  expect(text).not.toContain(secret)
  expect(traces).toHaveLength(Math.ceil(secret.length / 4))
  peer.close()
})
