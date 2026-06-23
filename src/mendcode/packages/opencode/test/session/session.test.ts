import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "@/session/session"
import { Bus } from "../../src/bus"
import * as Log from "@mendcode/core/util/log"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

function updatePartDelta(input: { sessionID: SessionID; messageID: MessageID; partID: PartID; field: string; delta: string }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePartDelta(input)))
}

function getPart(input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.getPart(input)))
}

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.path).toBe(info.path)
        expect(receivedInfo?.title).toBe(info.title)

        await remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await WithInstance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await remove(info.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})

          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
          // is the mutable domain type. Cast bridges the two — safe because the
          // test only reads the value afterwards.
          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part as MessageV2.Part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("live part delta persistence", () => {
  test(
    "coalesces text deltas into persisted parts for cross-terminal followers",
    async () => {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})
          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "assistant",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            path: { cwd: projectRoot, root: projectRoot },
            summary: false,
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          } as unknown as MessageV2.Info)

          const part = await updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "text",
            text: "",
            time: { start: Date.now() },
          })

          await updatePartDelta({
            sessionID: info.id,
            messageID,
            partID: part.id,
            field: "text",
            delta: "hello",
          })
          await updatePartDelta({
            sessionID: info.id,
            messageID,
            partID: part.id,
            field: "text",
            delta: " world",
          })

          await new Promise((resolve) => setTimeout(resolve, 700))

          const persisted = await getPart({ sessionID: info.id, messageID, partID: part.id })
          if (!persisted || persisted.type !== "text") throw new Error("Expected persisted text part")
          expect(persisted.text).toBe("hello world")

          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )

  test(
    "publishes coalesced part updates for cross-process followers",
    async () => {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})
          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "assistant",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            path: { cwd: projectRoot, root: projectRoot },
            summary: false,
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          } as unknown as MessageV2.Info)

          const part = await updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "text",
            text: "",
            time: { start: Date.now() },
          })

          const received = new Promise<MessageV2.Part>((resolve) => {
            let unsub = () => {}
            unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
              const updated = event.properties.part as MessageV2.Part
              if (updated.id !== part.id) return
              unsub()
              resolve(updated)
            })
          })

          await updatePartDelta({
            sessionID: info.id,
            messageID,
            partID: part.id,
            field: "text",
            delta: "stream",
          })

          const updated = await Promise.race([
            received,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for delta flush")), 1_500)),
          ])
          if (updated.type !== "text") throw new Error("Expected text part update")
          expect(updated.text).toBe("stream")

          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )

  test(
    "final part update wins over pending live delta snapshots",
    async () => {
      await WithInstance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})
          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "assistant",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            path: { cwd: projectRoot, root: projectRoot },
            summary: false,
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          } as unknown as MessageV2.Info)

          const part = await updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "text",
            text: "",
            time: { start: Date.now() },
          })

          await updatePartDelta({
            sessionID: info.id,
            messageID,
            partID: part.id,
            field: "text",
            delta: "partial",
          })

          await updatePart({
            ...part,
            text: "final",
            time: { start: part.time?.start ?? Date.now(), end: Date.now() },
          })
          await new Promise((resolve) => setTimeout(resolve, 700))

          const persisted = await getPart({ sessionID: info.id, messageID, partID: part.id })
          if (!persisted || persisted.type !== "text") throw new Error("Expected persisted text part")
          expect(persisted.text).toBe("final")
          expect(persisted.time?.end).toBeDefined()

          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await WithInstance.provide({
      directory: tmp.path,
      fn: () => create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await remove(info.id)
    }).not.toThrow()

    let missing = false
    await get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })
})
