import { Effect, Schema } from "effect"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { Global } from "@mendcode/core/global"
import * as Tool from "./tool"

export async function nativeComputerCommand(command: string[], signal: AbortSignal) {
  signal.throwIfAborted()
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const stop = () => child.kill()
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  const timeout = setTimeout(stop, 15000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    signal.throwIfAborted()
    if (code !== 0) throw new Error(`Native computer operation failed: ${stderr.slice(0, 1200)}. Check macOS Screen Recording or Accessibility permissions for the terminal running MendCode.`)
    return stdout.trim()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", stop)
  }
}

const Parameters = Schema.Struct({
  region: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number })).annotate({ description: "Optional crop in native screen points; cannot be combined with windowID." }),
  windowID: Schema.optional(Schema.Number).annotate({ description: "Optional known macOS window ID; omit to capture the main display." }),
})

export const ComputerCaptureTool = Tool.define("computer_capture", Effect.succeed({
  description: "Take and immediately view a native screenshot on macOS. Captures the main display or a known window ID, returns a PNG attachment plus an absolute file path for read. Resizes the preview to at most 1600 pixels. Requires OS Screen Recording permission; does not grant it automatically. Other operating systems are currently unsupported.",
  parameters: Parameters,
  execute: (args: typeof Parameters.Type, ctx: Tool.Context) => Effect.gen(function* () {
    if (process.platform !== "darwin") throw new Error("Native computer capture is currently supported only on macOS. Use a configured computer/browser MCP service on this platform.")
    if (args.windowID !== undefined && (!Number.isSafeInteger(args.windowID) || args.windowID <= 0)) throw new Error("windowID must be a positive integer")
    if (args.region && (args.windowID !== undefined || !Object.values(args.region).every(Number.isSafeInteger) || args.region.width < 1 || args.region.height < 1 || args.region.width > 16384 || args.region.height > 16384)) throw new Error("Use an integer crop with positive dimensions up to 16384, or a window ID, not both")
    yield* ctx.ask({ permission: "computer_capture", patterns: [args.windowID ? `window:${args.windowID}` : "main-display"], always: ["*"], metadata: { surface: args.windowID ?? "main-display" } })
    const directory = path.join(Global.Path.cache, "computer", ctx.sessionID)
    const id = crypto.randomUUID()
    const filePath = path.join(directory, `${id}.png`)
    let observedPID: number | undefined
    yield* Effect.promise(async () => {
      const displays = await nativeComputerCommand(["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"], ctx.abort).catch(() => "{}")
      const displayCount = (JSON.parse(displays).SPDisplaysDataType ?? []).reduce((sum: number, gpu: { spdisplays_ndrvs?: unknown[] }) => sum + (gpu.spdisplays_ndrvs?.length ?? 0), 0)
      if (args.windowID === undefined && !args.region && displayCount === 1) {
        const value = await nativeComputerCommand(["/usr/bin/osascript", "-e", FRONTMOST], ctx.abort).catch(() => "")
        if (/^\d+$/.test(value)) observedPID = Number(value)
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await readdir(directory)).filter((name) => name.endsWith(".png")).length >= 64) throw new Error("This session reached its 64 screenshot artifact limit. Archive or remove its cached captures before continuing.")
      await nativeComputerCommand(["/usr/sbin/screencapture", "-x", ...(args.region ? ["-R", `${args.region.x},${args.region.y},${args.region.width},${args.region.height}`] : args.windowID ? ["-l", String(args.windowID)] : ["-m"]), filePath], ctx.abort)
      await nativeComputerCommand(["/usr/bin/sips", "-Z", "1600", filePath], ctx.abort)
      if (observedPID !== undefined) {
        const after = await nativeComputerCommand(["/usr/bin/osascript", "-e", FRONTMOST], ctx.abort).catch(() => "")
        if (String(observedPID) !== after) observedPID = undefined
      }
    })
    const bytes = yield* Effect.promise(() => readFile(filePath))
    if (bytes.length < 24 || bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Capture did not produce a bounded PNG")
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (observedPID !== undefined) {
      if (snapshots.size >= 64) snapshots.delete(snapshots.keys().next().value!)
      snapshots.set(id, { sessionID: ctx.sessionID, pid: observedPID, time: Date.now() })
    }
    const metadata = { keyboardControlAvailable: observedPID !== undefined, captureID: id, filePath, width, height, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: Date.now(), resized: true }
    const previous = ctx.messages.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "computer_capture" && part.state.status === "completed" && !part.state.time.compacted && part.state.metadata.sha256 === metadata.sha256 && part.state.attachments?.length && !part.metadata?.codeMode)
    return {
      title: "Computer screenshot", output: JSON.stringify({ ...metadata, unchangedFrom: previous?.id, coordinates: "Preview pixels; do not assume these match desktop control coordinates." }), metadata,
      attachments: previous ? [] : [{ type: "file" as const, mime: "image/png", url: `data:image/png;base64,${bytes.toString("base64")}`, filename: `${id}.png` }],
    }
  }).pipe(Effect.orDie),
}))

const KEY_CODES = { tab: 48, escape: 53, enter: 36, space: 49, left: 123, right: 124, down: 125, up: 126 } as const
const ControlParameters = Schema.Struct({
  captureID: Schema.String,
  key: Schema.Literals(["tab", "escape", "enter", "space", "left", "right", "down", "up"]),
})
const snapshots = new Map<string, { sessionID: string; pid: number; time: number }>()
const FRONTMOST = 'tell application "System Events" to get unix id of first application process whose frontmost is true'

export const ComputerKeyTool = Tool.define("computer_key", Effect.succeed({
  description: "Press one navigation key in the app observed by a recent computer_capture. macOS only; requires Accessibility permission. Supply its captureID, valid for 30 seconds in this session and one action. Fails if foreground app changed or was not observed; never activates another app. Capture again after each action. Pointer control and arbitrary text entry are not supported.",
  parameters: ControlParameters,
  execute: (args: typeof ControlParameters.Type, ctx: Tool.Context) => Effect.gen(function* () {
    if (process.platform !== "darwin") throw new Error("Native computer control is currently supported only on macOS. Use a configured computer/browser MCP service on this platform.")
    const snapshot = snapshots.get(args.captureID)
    if (!snapshot || snapshot.sessionID !== ctx.sessionID || Date.now() - snapshot.time > 30000) throw new Error("Capture is missing or stale. Take a new screenshot before controlling the app.")
    yield* ctx.ask({ permission: "computer_control", patterns: [`process:${snapshot.pid}`], always: [`process:${snapshot.pid}`], metadata: { captureID: args.captureID, key: args.key, processID: snapshot.pid } })
    if (Date.now() - snapshot.time > 30000) throw new Error("Capture expired while waiting for permission. Capture again.")
    // Permission waits can overlap. Consume only the exact observation that was approved.
    if (snapshots.get(args.captureID) !== snapshot) throw new Error("Capture was already consumed. Take a new screenshot before controlling the app.")
    snapshots.delete(args.captureID)
    yield* Effect.promise(() => nativeComputerCommand(["/usr/bin/osascript", "-e", `on run argv
      tell application "System Events"
        set targetID to (item 1 of argv) as integer
        set currentID to unix id of first application process whose frontmost is true
        if currentID is not targetID then error "Foreground application changed; capture again"
        tell first application process whose unix id is targetID
          key code ((item 2 of argv) as integer)
        end tell
      end tell
    end run`, String(snapshot.pid), String(KEY_CODES[args.key])], ctx.abort))
    return { title: "Computer key", output: `Pressed ${args.key}. Capture a new screenshot to inspect the result.`, metadata: { captureID: args.captureID, key: args.key } }
  }).pipe(Effect.orDie),
}))
