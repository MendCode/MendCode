import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@mendcode/core/flag/flag"
import { SharedServer } from "./tui/shared-server"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@mendcode/core/util/log"

const log = Log.create({ service: "cli.serve" })
const INSTANCE_DISPOSE_TIMEOUT_MS = 10_000

export function createShutdown(input: {
  stopListener: () => Promise<void>
  disposeInstances: () => Promise<void>
  clearState: () => Promise<void>
  disposeTimeoutMs?: number
}) {
  let shutdown: Promise<void> | undefined
  return () =>
    (shutdown ??= input
      .stopListener()
      .catch((error) => {
        log.warn("shared server listener cleanup failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .then(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          input.disposeInstances().catch((error) => {
            log.warn("shared server instance cleanup failed", {
              error: error instanceof Error ? error.message : String(error),
            })
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              log.warn("shared server instance cleanup timed out")
              resolve()
            }, input.disposeTimeoutMs ?? INSTANCE_DISPOSE_TIMEOUT_MS)
            timer.unref()
          }),
        ])
        if (timer) clearTimeout(timer)
      })
      .then(input.clearState)
      .then(() => undefined))
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless MendCode runtime server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* Effect.promise(() => resolveNetworkOptions(args))
    const server = yield* Effect.promise(() => Server.listen(opts))
    const shared = Boolean(process.env.MENDCODE_SHARED_SERVER_STATE_FILE)
    if (shared) {
      const credentials = SharedServer.credentials()
      yield* Effect.promise(() =>
        SharedServer.writeState({
          version: 1,
          pid: process.pid,
          url: server.url.toString(),
          username: credentials.username,
          password: credentials.password,
          startedAt: new Date().toISOString(),
          runtimeID: process.env.MENDCODE_SHARED_SERVER_RUNTIME_ID || "unknown",
        }),
      )
    }
    console.log(`MendCode runtime server listening on http://${server.hostname}:${server.port}`)

    const store = yield* InstanceStore.Service
    const controller = new AbortController()
    let resolveSignal: (() => void) | undefined
    const signal = new Promise<void>((resolve) => {
      resolveSignal = resolve
    })
    const onSignal = () => resolveSignal?.()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)

    const stop = createShutdown({
      stopListener: () => server.stop(true),
      disposeInstances: () => Effect.runPromise(store.disposeAll()),
      clearState: async () => {
        if (shared) await SharedServer.clearStateIfOwned(process.pid)
      },
    })

    try {
      const idle = shared
        ? SharedServer.waitForClientLeases({ pid: process.pid, stop, signal: controller.signal })
        : new Promise<void>(() => undefined)
      yield* Effect.raceFirst(
        Effect.promise(() => idle),
        Effect.promise(() => signal),
      )
      yield* Effect.promise(stop)
    } finally {
      controller.abort()
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      yield* Effect.promise(stop)
    }
  }),
})
