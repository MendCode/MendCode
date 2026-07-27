import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import * as Log from "@mendcode/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"
import "@/server/event"

const log = Log.create({ service: "server" })
const EVENT_QUEUE_MAX_ITEMS = 512
const EVENT_QUEUE_MAX_BYTES = 8 * 1024 * 1024

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
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
            id: Bus.createID(),
            type: "server.connected",
            properties: {},
          }),
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          if (
            !q.push(
              JSON.stringify({
                id: Bus.createID(),
                type: "server.heartbeat",
                properties: {},
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
          log.info("event disconnected")
        }

        unsub = Bus.subscribeAll((event) => {
          if (!q.push(JSON.stringify(event))) stop()
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

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
    },
  )
