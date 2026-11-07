import { expect, test } from "bun:test"
import { PROTOCOL_VERSION } from "@mendcode/protocol"
import { createClient } from "../src"

test("a non-reconnecting client settles status polls sent after transport closure", async () => {
  let end = () => {}
  let closed!: () => void
  const disconnected = new Promise<void>((resolve) => { closed = resolve })
  const received: string[] = []
  const client = createClient({
    name: "drain-poll", reconnect: false,
    onConnection: (state) => { if (state === "closed") closed() },
    loopback: () => (write, finish) => {
      end = finish
      return {
        close() {},
        receive(data) {
          for (const line of new TextDecoder().decode(data).trim().split("\n")) {
            const frame = JSON.parse(line)
            received.push(frame.body.type)
            write(new TextEncoder().encode(JSON.stringify({ v: PROTOCOL_VERSION, kind: "ack", id: frame.body.id, result: {} }) + "\n"))
          }
        },
      }
    },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await client.connect()
    end()
    await disconnected
    // The drain sleeps between polls: no request is in flight when the transport closes.
    const reply = await Promise.race([
      client.send({ type: "daemon.status" }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("disconnected status poll hung")), 1000) }),
    ])
    expect(reply).toMatchObject({ ok: false, error: { message: "[CLIENT]: connection closed" } })
    expect(received).toEqual(["hello"])
    expect(client.unanswered).toBe(0)
  } finally {
    clearTimeout(timer)
    client.close()
  }
})
