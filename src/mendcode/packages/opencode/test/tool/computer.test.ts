import { afterEach, describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { ComputerCaptureTool, ComputerKeyTool, ComputerSessionTool, nativeComputerCommand } from "@/tool/computer"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer, CrossSpawnSpawner.defaultLayer))
const context = (): Tool.Context => ({
  sessionID: SessionID.make(`ses_computer_${crypto.randomUUID()}`),
  messageID: MessageID.make("msg_computer_test"),
  agent: "build", abort: new AbortController().signal, messages: [],
  metadata: () => Effect.void, ask: () => Effect.void,
})

// Only the OS boundary is simulated: no screenshot or key reaches the real desktop.
function desktop() {
  const state = { commands: [] as string[][], pid: "123", displays: 1, keys: 0, denied: false, shortPNG: false }
  const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[]) => {
    state.commands.push(command)
    const stdout = new ReadableStream<Uint8Array>({
      async start(controller) {
        let value = ""
        if (command[0] === "/usr/sbin/system_profiler") value = JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: Array(state.displays).fill({}) }] })
        else if (command[0] === "/usr/sbin/screencapture") {
          const bytes = Buffer.alloc(state.shortPNG ? 8 : 24)
          bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
          if (!state.shortPNG) { bytes.writeUInt32BE(100, 16); bytes.writeUInt32BE(80, 20) }
          await Bun.write(command.at(-1)!, bytes)
        } else if (command[0] === "/usr/bin/osascript") {
          const script = command.join(" ")
          if (script.includes('ObjC.import("Cocoa")')) value = "READY\n"
          else if (script.includes('ObjC.import("Foundation")')) {
            value = JSON.stringify({ pid: Number(state.pid), bundleID: "com.example.fixture", appName: "Fixture", windowName: "Computer Test" })
          } else if (script.includes("on run argv")) {
            const pid = command.find((item) => item === state.pid)
            if (pid && !state.denied) state.keys++
          }
        } else if (command[0] !== "/usr/bin/sips") throw new Error(`Unexpected native command: ${command[0]}`)
        controller.enqueue(new TextEncoder().encode(value))
        controller.close()
      },
    })
    const failed = state.denied || (command.join(" ").includes("on run argv") && !command.includes(state.pid))
    return {
      stdout, stderr: new Blob([failed ? "OS permission denied or foreground changed" : ""]).stream(),
      exited: Promise.resolve(failed ? 1 : 0), kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>
  }) as typeof Bun.spawn)
  return { state, [Symbol.dispose]: () => spawn.mockRestore() }
}

afterEach(disposeAllInstances)

describe("native computer boundary", () => {
  it.instance("validates inputs and permission before invoking the OS", () => Effect.gen(function* () {
    const capture = yield* Tool.init(yield* ComputerCaptureTool)
    const key = yield* Tool.init(yield* ComputerKeyTool)
    using os = desktop()
    const ctx = context()
    for (const args of [{ windowID: -1 }, { region: { x: 0, y: 0, width: 0, height: 1 } }, { windowID: 1, region: { x: 0, y: 0, width: 1, height: 1 } }]) {
      expect((yield* Effect.exit(capture.execute(args, ctx)))._tag).toBe("Failure")
    }
    expect((yield* Effect.exit(key.execute({ captureID: "missing", key: "tab" }, ctx)))._tag).toBe("Failure")
    expect((yield* Effect.exit(capture.execute({}, { ...ctx, ask: () => Effect.die(new Error("Denied")) })))._tag).toBe("Failure")
    expect(os.state.commands).toHaveLength(0)
  }))

  it.instance("binds capture to session, consumes once and rejects foreground changes", () => Effect.gen(function* () {
    if (process.platform !== "darwin") return
    const capture = yield* Tool.init(yield* ComputerCaptureTool)
    const key = yield* Tool.init(yield* ComputerKeyTool)
    using os = desktop()
    const ctx = context()
    const result = yield* capture.execute({}, ctx)
    expect(result.metadata.keyboardControlAvailable).toBe(true)
    expect(result.attachments?.[0]?.mime).toBe("image/png")
    expect(result.metadata.width).toBe(100)
    const args = { captureID: result.metadata.captureID, key: "tab" as const }
    expect((yield* Effect.exit(key.execute(args, context())))._tag).toBe("Failure")
    yield* key.execute(args, ctx)
    expect((yield* Effect.exit(key.execute(args, ctx)))._tag).toBe("Failure")
    expect(os.state.keys).toBe(1)
    const next = yield* capture.execute({}, ctx)
    os.state.pid = "456"
    expect((yield* Effect.exit(key.execute({ ...args, captureID: next.metadata.captureID }, ctx)))._tag).toBe("Failure")
    expect(os.state.keys).toBe(1)
  }))

  it.instance("binds activation to the current real user message and exact capture", () => Effect.gen(function* () {
    if (process.platform !== "darwin") return
    const capture = yield* Tool.init(yield* ComputerCaptureTool)
    const session = yield* Tool.init(yield* ComputerSessionTool)
    using os = desktop()
    const base = context()
    const result = yield* capture.execute({}, base)
    const userID = MessageID.make("msg_computer_user")
    const requests: Array<{ permission: string; patterns: readonly string[] }> = []
    const ctx = {
      ...base,
      messages: [
        { info: { id: userID, role: "user" }, parts: [{ type: "text", text: "click the fixture button" }] },
        { info: { id: base.messageID, role: "assistant", parentID: userID }, parts: [] },
      ] as unknown as Tool.Context["messages"],
      ask: (request: { permission: string; patterns: readonly string[] }) => Effect.sync(() => { requests.push(request) }),
    } as unknown as Tool.Context
    const started = yield* session.execute(
      { action: "start", mode: "control", bootstrapCaptureID: result.metadata.captureID },
      ctx,
    )
    expect(requests).toEqual([
      expect.objectContaining({
        permission: "computer_activation",
        patterns: ["target:com.example.fixture:pid:123:mode:control"],
      }),
    ])
    const payload = JSON.parse(started.output)
    expect(payload.mode).toBe("control")
    expect(payload.target.bundleID).toBe("com.example.fixture")

    const synthetic = yield* capture.execute({}, base)
    const denied = yield* Effect.exit(
      session.execute(
        { action: "start", mode: "control", bootstrapCaptureID: synthetic.metadata.captureID },
        {
          ...ctx,
          messages: [
            { info: { id: userID, role: "user" }, parts: [{ type: "text", text: "peer", synthetic: true }] },
            { info: { id: base.messageID, role: "assistant", parentID: userID }, parts: [] },
          ] as unknown as Tool.Context["messages"],
        },
      ),
    )
    expect(denied._tag).toBe("Failure")
  }))

  it.instance("never reuses a token across overlapping permission waits", () => Effect.gen(function* () {
    if (process.platform !== "darwin") return
    const capture = yield* Tool.init(yield* ComputerCaptureTool)
    const key = yield* Tool.init(yield* ComputerKeyTool)
    using os = desktop()
    const ctx = context()
    const result = yield* capture.execute({}, ctx)
    let approvals = 0
    let release!: () => void
    const approved = new Promise<void>((resolve) => { release = resolve })
    const shared = { ...ctx, ask: () => Effect.promise(() => { if (++approvals === 2) release(); return approved }) }
    const args = { captureID: result.metadata.captureID, key: "tab" as const }
    const exits = yield* Effect.all([Effect.exit(key.execute(args, shared)), Effect.exit(key.execute(args, shared))], { concurrency: 2 })
    expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(1)
    expect(exits.filter((exit) => exit._tag === "Failure")).toHaveLength(1)
    expect(os.state.keys).toBe(1)
  }))

  it.instance("rejects expired approval and malformed capture without OS control", () => Effect.gen(function* () {
    if (process.platform !== "darwin") return
    const capture = yield* Tool.init(yield* ComputerCaptureTool)
    const key = yield* Tool.init(yield* ComputerKeyTool)
    using os = desktop()
    const ctx = context()
    const result = yield* capture.execute({}, ctx)
    const now = Date.now()
    const time = spyOn(Date, "now")
    try {
      const exit = yield* Effect.exit(key.execute({ captureID: result.metadata.captureID, key: "tab" }, {
        ...ctx, ask: () => Effect.sync(() => { time.mockReturnValue(now + 31000) }),
      }))
      expect(exit._tag).toBe("Failure")
      expect(os.state.keys).toBe(0)
    } finally { time.mockRestore() }
    os.state.shortPNG = true
    expect((yield* Effect.exit(capture.execute({}, ctx)))._tag).toBe("Failure")
  }))

  it.instance("does not offer keyboard control for crop, window or multiple displays", () => Effect.gen(function* () {
    if (process.platform !== "darwin") return
    const capture = yield* Tool.init(yield* ComputerCaptureTool)
    using os = desktop()
    const ctx = context()
    for (const args of [{ windowID: 1 }, { region: { x: 0, y: 0, width: 1, height: 1 } }]) {
      expect((yield* capture.execute(args, ctx)).metadata.keyboardControlAvailable).toBe(false)
    }
    os.state.displays = 2
    expect((yield* capture.execute({}, ctx)).metadata.keyboardControlAvailable).toBe(false)
    os.state.denied = true
    expect((yield* Effect.exit(capture.execute({}, ctx)))._tag).toBe("Failure")
  }))

  it.live("rejects a pre-aborted native operation before spawning", () => Effect.promise(async () => {
    using os = desktop()
    await expect(nativeComputerCommand(["must-not-run"], AbortSignal.abort())).rejects.toThrow()
    expect(os.state.commands).toHaveLength(0)
  }))
})
