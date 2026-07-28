import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus, matchesGlobalEventDirectory } from "@/bus/global"
import { Bus } from "@/bus"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "@/util/queue"
import { Installation } from "@/installation"
import * as Log from "@mendcode/core/util/log"
import { lazy } from "../../util/lazy"
import { Config } from "@/config/config"
import { errors } from "../error"
import { disposeAllInstancesAndEmitGlobalDisposed } from "../global-lifecycle"
import "@/mend/memory/dream-events"
import "@/mend/memory/workspace-events"
import { processMemoryUsage } from "@/util/process-memory"

const log = Log.create({ service: "server" })
const EVENT_QUEUE_MAX_ITEMS = 512
const EVENT_QUEUE_MAX_BYTES = 8 * 1024 * 1024

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<string | null>({
      maxItems: EVENT_QUEUE_MAX_ITEMS,
      maxBytes: EVENT_QUEUE_MAX_BYTES,
      sizeOf: (value) => (typeof value === "string" ? Buffer.byteLength(value) : 0),
    })
    let unsub: () => void = () => undefined
    let done = false

    q.push(
      JSON.stringify({
        payload: {
          id: Bus.createID(),
          type: "server.connected",
          properties: {},
        },
      }),
    )

    // Send heartbeat every 10s to prevent stalled proxy streams.
    const heartbeat = setInterval(() => {
      if (
        !q.push(
          JSON.stringify({
            payload: {
              id: Bus.createID(),
              type: "server.heartbeat",
              properties: {},
            },
          }),
        )
      )
        stop()
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.close(null)
      log.info("global event disconnected")
    }

    unsub = subscribe(q)

    stream.onAbort(stop)

    try {
      for await (const data of q) {
        if (data === null) return
        await stream.writeSSE({ data })
      }
    } finally {
      stop()
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the MendCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string(), channel: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.displayVersion(), channel: Installation.channel() })
      },
    )
    .get(
      "/diagnostics/memory",
      describeRoute({
        summary: "Get process memory usage",
        description: "Get a manually requested, read-only memory sample for the current server process.",
        operationId: "global.diagnostics.memory",
        responses: {
          200: {
            description: "Current process memory usage",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    pid: z.number(),
                    role: z.string(),
                    rss: z.number(),
                    heapTotal: z.number(),
                    heapUsed: z.number(),
                    external: z.number(),
                    arrayBuffers: z.number(),
                    uptimeSeconds: z.number(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(processMemoryUsage("server"))
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the MendCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: z.union([...BusEvent.payloads(), ...SyncEvent.payloads()]),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        const directory = c.req.query("directory") || undefined

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            if (!matchesGlobalEventDirectory(event, directory)) return
            if (!q.push(JSON.stringify(event))) q.close(null)
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global MendCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global MendCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        const result = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.updateGlobal(config)))
        if (result.changed) {
          void AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })).catch(
            () => undefined,
          )
        }
        return c.json(result.info)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all MendCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await AppRuntime.runPromise(disposeAllInstancesAndEmitGlobalDisposed())
        return c.json(true)
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade MendCode runtime",
        description: "Upgrade the MendCode runtime to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const result = await AppRuntime.runPromise(
          Installation.Service.use((svc) =>
            Effect.gen(function* () {
              const method = yield* svc.method()
              if (method === "unknown") {
                return { success: false as const, status: 400 as const, error: "Unknown installation method" }
              }

              const target = c.req.valid("json").target || (yield* svc.latest(method))
              const result = yield* Effect.catch(
                svc.upgrade(method, target).pipe(Effect.as({ success: true as const, version: target })),
                (err) =>
                  Effect.succeed({
                    success: false as const,
                    status: 500 as const,
                    error: err instanceof Error ? err.message : String(err),
                  }),
              )
              if (!result.success) return result
              return { ...result, status: 200 as const }
            }),
          ),
        )
        if (!result.success) {
          return c.json({ success: false, error: result.error }, result.status)
        }
        const target = result.version
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Installation.Event.Updated.type,
            properties: { version: target },
          },
        })
        return c.json({ success: true, version: target })
      },
    ),
)
