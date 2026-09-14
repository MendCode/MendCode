import { describe, expect, test } from "bun:test"
import { createShutdown } from "../../../src/cli/cmd/serve-shutdown"

describe("shared serve shutdown", () => {
  test("terminates a shutdown whose listener never settles without clearing ownership", async () => {
    const exits: number[] = []
    const calls: string[] = []
    const shutdown = createShutdown({
      stopListener: () => new Promise<void>(() => undefined),
      disposeInstances: async () => {
        calls.push("instances")
      },
      closeDatabase: () => {
        calls.push("database")
      },
      clearState: async () => {
        calls.push("state")
      },
      shutdownTimeoutMs: 5,
      exit: (code) => {
        exits.push(code)
      },
    })

    const result = await Promise.race([
      shutdown().then(
        () => "resolved",
        () => "failed",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 100)),
    ])

    expect(result).toBe("failed")
    expect(exits).toEqual([1])
    expect(calls).toEqual([])
  })

  test("closes the database before relinquishing discovery and exits once", async () => {
    const calls: string[] = []
    const shutdown = createShutdown({
      stopListener: async () => {
        calls.push("listener")
      },
      disposeInstances: async () => {
        calls.push("instances")
      },
      closeDatabase: () => {
        calls.push("database")
      },
      clearState: async () => {
        calls.push("state")
      },
      exit: (code) => {
        calls.push(`exit:${code}`)
      },
    })

    await Promise.all([shutdown(), shutdown()])

    expect(calls).toEqual(["listener", "instances", "database", "state", "exit:0"])
  })

  test("exits on listener failure without claiming the database was released", async () => {
    const calls: string[] = []
    const shutdown = createShutdown({
      stopListener: async () => {
        calls.push("listener")
        throw new Error("failed")
      },
      disposeInstances: async () => {
        calls.push("instances")
      },
      closeDatabase: () => {
        calls.push("database")
      },
      clearState: async () => {
        calls.push("state")
      },
      exit: (code) => {
        calls.push(`exit:${code}`)
      },
    })

    await expect(shutdown()).rejects.toThrow("failed")

    expect(calls).toEqual(["listener", "exit:1"])
  })

  test("retains discovery on timeout and does not release it if late cleanup settles", async () => {
    const calls: string[] = []
    let finish: () => void = () => undefined
    const shutdown = createShutdown({
      stopListener: async () => {
        calls.push("listener")
      },
      disposeInstances: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
      closeDatabase: () => {
        calls.push("database")
      },
      clearState: async () => {
        calls.push("state")
      },
      shutdownTimeoutMs: 5,
      exit: (code) => {
        calls.push(`exit:${code}`)
      },
    })

    await expect(shutdown()).rejects.toThrow("timed out during instances")
    finish()
    await new Promise((resolve) => setTimeout(resolve, 1))

    expect(calls).toEqual(["listener", "exit:1"])
  })

  for (const stage of ["database", "state"] as const) {
    test(`bounds a stalled ${stage} cleanup too`, async () => {
      const exits: number[] = []
      const shutdown = createShutdown({
        stopListener: async () => {},
        disposeInstances: async () => {},
        closeDatabase: () => (stage === "database" ? new Promise<void>(() => undefined) : undefined),
        clearState: () => (stage === "state" ? new Promise<void>(() => undefined) : Promise.resolve()),
        shutdownTimeoutMs: 5,
        exit: (code) => {
          exits.push(code)
        },
      })
      await expect(shutdown()).rejects.toThrow(`timed out during ${stage}`)
      expect(exits).toEqual([1])
    })
  }
})
