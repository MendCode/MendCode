import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import { describe, expect, test } from "bun:test"
import { appendGlobalEvent, globalEventRelayPath } from "../../src/bus/global-relay"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"

function waitForRelayedEvent(predicate: (event: GlobalEvent) => boolean) {
  return new Promise<GlobalEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      GlobalBus.off("event", handler)
      reject(new Error("timed out waiting for relayed global event"))
    }, 1_000)
    const handler = (event: GlobalEvent) => {
      if (!predicate(event)) return
      clearTimeout(timeout)
      GlobalBus.off("event", handler)
      resolve(event)
    }
    GlobalBus.on("event", handler)
  })
}

describe("GlobalBus relay", () => {
  test("tails events written by another process source", async () => {
    const event: GlobalEvent = {
      directory: "/tmp/relay-project",
      payload: {
        id: "evt_relay_test",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_relay",
          messageID: "msg_relay",
          partID: "prt_relay",
          field: "text",
          delta: "token",
        },
      },
    }
    const received = waitForRelayedEvent((item) => item.payload?.id === event.payload.id)

    appendFileSync(
      globalEventRelayPath(),
      JSON.stringify({
        source: "other-process",
        sequence: 1,
        time: Date.now(),
        event,
      }) + "\n",
      { mode: 0o600 },
    )

    await expect(received).resolves.toMatchObject(event)
  })

  test("does not persist high-frequency message deltas to disk", () => {
    const event: GlobalEvent = {
      directory: "/tmp/relay-project",
      payload: {
        id: `evt_delta_${Date.now()}`,
        type: "message.part.delta",
        properties: {
          sessionID: "ses_relay",
          messageID: "msg_relay",
          partID: "prt_relay",
          field: "text",
          delta: "token",
        },
      },
    }

    appendGlobalEvent(event)

    const text = existsSync(globalEventRelayPath()) ? readFileSync(globalEventRelayPath(), "utf8") : ""
    expect(text).not.toContain(event.payload.id)
  })

  test("caps the relay file before appending more events", () => {
    const previous = process.env.MENDCODE_GLOBAL_EVENT_RELAY_MAX_BYTES
    process.env.MENDCODE_GLOBAL_EVENT_RELAY_MAX_BYTES = "512"
    try {
      writeFileSync(globalEventRelayPath(), "x".repeat(1024))
      const event: GlobalEvent = {
        directory: "/tmp/relay-project",
        payload: {
          id: `evt_cap_${Date.now()}`,
          type: "server.instance.disposed",
          properties: {
            directory: "/tmp/relay-project",
          },
        },
      }

      appendGlobalEvent(event)

      const text = readFileSync(globalEventRelayPath(), "utf8")
      expect(text).toContain(event.payload.id)
      expect(Buffer.byteLength(text)).toBeLessThan(512)
    } finally {
      if (previous === undefined) delete process.env.MENDCODE_GLOBAL_EVENT_RELAY_MAX_BYTES
      else process.env.MENDCODE_GLOBAL_EVENT_RELAY_MAX_BYTES = previous
    }
  })
})
