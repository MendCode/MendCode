import { describe, expect, test } from "bun:test"
import { createShutdown } from "../../../src/cli/cmd/serve"

describe("shared serve shutdown", () => {
  test("stops the listener, disposes instances, and clears state once", async () => {
    const calls: string[] = []
    const shutdown = createShutdown({
      stopListener: async () => {
        calls.push("listener")
      },
      disposeInstances: async () => {
        calls.push("instances")
      },
      clearState: async () => {
        calls.push("state")
      },
    })

    await Promise.all([shutdown(), shutdown()])

    expect(calls).toEqual(["listener", "instances", "state"])
  })

  test("continues cleanup when listener shutdown fails", async () => {
    const calls: string[] = []
    const shutdown = createShutdown({
      stopListener: async () => {
        calls.push("listener")
        throw new Error("failed")
      },
      disposeInstances: async () => {
        calls.push("instances")
      },
      clearState: async () => {
        calls.push("state")
      },
    })

    await shutdown()

    expect(calls).toEqual(["listener", "instances", "state"])
  })

  test("clears owned state after instance cleanup times out", async () => {
    const calls: string[] = []
    const shutdown = createShutdown({
      stopListener: async () => {
        calls.push("listener")
      },
      disposeInstances: () => new Promise<void>(() => undefined),
      clearState: async () => {
        calls.push("state")
      },
      disposeTimeoutMs: 5,
    })

    await shutdown()

    expect(calls).toEqual(["listener", "state"])
  })
})
