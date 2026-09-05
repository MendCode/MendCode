import { Config } from "@/config/config"
import {
  GlobalBus,
  matchesGlobalEventDirectory,
  type GlobalEvent as GlobalBusEvent,
} from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import * as Log from "@mendcode/core/util/log"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { processMemoryUsage } from "@/util/process-memory"
import { SharedServer } from "@/cli/cmd/tui/shared-server"
import { reportUpgradePhase, reportUpgradeOutcome } from "@/server/upgrade-progress"
import { readChannel, writeChannel } from "@/installation/release-channel"

const log = Log.create({ service: "server" })
const HTTPAPI_EVENT_BUFFER_SIZE = 512

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse(directory?: string) {
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => {
      // A stalled HTTP client may miss intermediate deltas, but it must not
      // retain an unbounded queue. The TUI reconciles durable state after its
      // reconnect handshake, so dropping here is safe and bounded.
      if (matchesGlobalEventDirectory(event, directory)) Queue.offerUnsafe(queue, event)
    }
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  }, { bufferSize: HTTPAPI_EVENT_BUFFER_SIZE, strategy: "dropping" })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: Bus.createID(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: Installation.displayVersion(), channel: Installation.channel() }
    })

    const memory = Effect.fn("GlobalHttpApi.memory")(function* () {
      const sharedServer = yield* Effect.promise(() => SharedServer.diagnostics())
      return {
        ...processMemoryUsage("server"),
        ...(sharedServer ? { sharedServer } : {}),
      }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const directory = new URL(request.url, "http://localhost").searchParams.get("directory") ?? undefined
      return eventResponse(directory)
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target, (phase, progress) => reportUpgradePhase(target, phase, progress)).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err.stderr || "Update failed",
            },
          }),
        ),
      )
      reportUpgradeOutcome(target, result.body.success ? undefined : result.body.error)
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("releaseChannelGet", () => Effect.promise(async () => ({ channel: await readChannel() })))
      .handle("releaseChannelSet", ({ payload }) => Effect.promise(async () => ({ channel: await writeChannel(payload.channel) })))
      .handle("health", health)
      .handle("memory", memory)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
