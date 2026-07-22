import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@mendcode/core/flag/flag"
import { SharedServer } from "./tui/shared-server"

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
    if (process.env.MENDCODE_SHARED_SERVER_STATE_FILE) {
      const credentials = SharedServer.credentials()
      yield* Effect.promise(() =>
        SharedServer.writeState({
          version: 1,
          pid: process.pid,
          url: server.url.toString(),
          username: credentials.username,
          password: credentials.password,
          startedAt: new Date().toISOString(),
        }),
      )
    }
    console.log(`MendCode runtime server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
