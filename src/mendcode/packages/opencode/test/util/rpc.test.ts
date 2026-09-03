import { describe, expect, test } from "bun:test"
import { Rpc } from "../../src/util/rpc"

type Endpoint = {
  postMessage: (data: string) => void
  onmessage: ((this: Worker, event: MessageEvent) => unknown) | null
  addEventListener: (type: string, listener: (event: Event | ErrorEvent) => void) => void
}

function endpoint(reply: (request: { id: number; method: string }) => string): Endpoint {
  const target: Endpoint = {
    onmessage: null,
    addEventListener() {},
    postMessage(data) {
      const request = JSON.parse(data)
      queueMicrotask(() => target.onmessage?.call({} as Worker, { data: reply(request) } as MessageEvent))
    },
  }
  return target
}

describe("RPC client", () => {
  test("rejects a request when the worker reports an execution error", async () => {
    const target = endpoint((request) =>
      JSON.stringify({ type: "rpc.error", id: request.id, error: `failed ${request.method}` }),
    )
    const client = Rpc.client<{ explode: (input: null) => Promise<never> }>(target)

    await expect(client.call("explode", null)).rejects.toThrow("failed explode")
  })

  test("rejects pending requests when the worker emits malformed JSON", async () => {
    const target = endpoint(() => "not-json")
    const client = Rpc.client<{ broken: (input: null) => Promise<never> }>(target)

    await expect(client.call("broken", null)).rejects.toThrow("malformed response")
  })

  test("rejects synchronously when posting to the worker fails", async () => {
    const target = endpoint(() => "")
    target.postMessage = () => {
      throw new Error("worker is closed")
    }
    const client = Rpc.client<{ closed: (input: null) => Promise<never> }>(target)

    await expect(client.call("closed", null)).rejects.toThrow("worker is closed")
  })

  test("rejects pending requests when the worker is terminated", async () => {
    const target = endpoint(() => "")
    target.postMessage = () => {}
    const client = Rpc.client<{ pending: (input: null) => Promise<never> }>(target)
    const pending = client.call("pending", null)

    client.close()

    await expect(pending).rejects.toThrow("worker terminated")
  })
})
