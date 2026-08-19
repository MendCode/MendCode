import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { probeRuntime } from "./dev-rearm"

const VERSION = "0.1.31"
const PROJECT = "/tmp/mendcode-dev-rearm-smoke-project"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

async function main() {
  let mode: "ready" | "empty-session" | "empty-provider" | "no-default" = "ready"
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    switch (request.url?.split("?")[0]) {
      case "/global/health":
        return json(response, { healthy: true, version: VERSION, channel: "local" })
      case "/path":
        return json(response, {
          home: "/tmp",
          state: "/tmp/state",
          config: "/tmp/config",
          worktree: PROJECT,
          directory: PROJECT,
        })
      case "/session":
        return json(response, mode === "empty-session" ? [] : [{ id: "session-smoke" }])
      case "/provider":
        return json(
          response,
          mode === "empty-provider"
            ? { all: [], default: {}, connected: [] }
            : {
                all: [{ id: "fake-local", models: { "fake-model": {} } }],
                default: mode === "no-default" ? {} : { "fake-local": "fake-model" },
                connected: [],
              },
        )
      default:
        return json(response, { error: "not found" }, 404)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object", "smoke server did not bind")

  const state = {
    version: 1,
    pid: process.pid,
    url: `http://127.0.0.1:${address.port}/`,
    username: "mendcode",
    password: "smoke-password",
    startedAt: new Date().toISOString(),
    runtimeID: "smoke-runtime",
  }
  const ready = await probeRuntime(state, PROJECT, VERSION)
  assert(ready.ok, `expected ready runtime, got ${ready.reason ?? "unknown"}`)
  assert(ready.sessions?.length === 1, "ready smoke did not observe session data")
  assert(ready.providers?.all?.length === 1, "ready smoke did not observe provider data")

  mode = "empty-session"
  const emptySession = await probeRuntime(state, PROJECT, VERSION)
  assert(
    !emptySession.ok && emptySession.reason?.includes("session endpoint returned 0"),
    "empty /session passed the gate",
  )

  mode = "empty-provider"
  const emptyProvider = await probeRuntime(state, PROJECT, VERSION)
  assert(
    !emptyProvider.ok && emptyProvider.reason?.includes("provider endpoint returned 0"),
    "empty /provider passed the gate",
  )

  mode = "no-default"
  const noDefault = await probeRuntime(state, PROJECT, VERSION)
  assert(!noDefault.ok && noDefault.reason?.includes("no default model"), "provider without a default passed the gate")

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  const offline = await probeRuntime(state, PROJECT, VERSION)
  assert(!offline.ok, "offline server passed the readiness gate")
  console.log(
    "PASS dev-rearm smoke: health + InstanceContext + non-empty session/provider gates reject offline/empty state",
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FAIL dev-rearm smoke: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
