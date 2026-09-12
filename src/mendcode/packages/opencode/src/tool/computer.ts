import { Effect, Schema } from "effect"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { Global } from "@mendcode/core/global"
import * as Tool from "./tool"
import {
  executeComputerCode,
  inspectComputerCapture,
  observeComputerSession,
  registerComputerCapture,
  runLegacyComputerKey,
  startComputerSession,
  stopComputerSession,
} from "@/computer/runtime"
import { foregroundTarget, runNativeComputerCommand } from "@/computer/macos-accessibility"
import { assertComputerCaptureSafe } from "@/computer/macos-overlay"
import type { MessageV2 } from "@/session/message-v2"
import type { MessageID } from "@/session/schema"

export const nativeComputerCommand = runNativeComputerCommand

const Parameters = Schema.Struct({
  region: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
  ).annotate({ description: "Optional crop in native screen points; cannot be combined with windowID." }),
  windowID: Schema.optional(Schema.Number).annotate({
    description: "Optional known macOS window ID; omit to capture the main display.",
  }),
})

export const ComputerCaptureTool = Tool.define(
  "computer_capture",
  Effect.succeed({
    description:
      "Take and immediately view a native screenshot on macOS. Captures the main display or a known window ID, returns a PNG attachment plus an absolute file path for read. Resizes the preview to at most 1600 pixels. A fresh full-display capture can bootstrap an explicitly approved ComputerSession. Requires OS Screen Recording permission; does not grant it automatically. Other operating systems are currently unsupported.",
    parameters: Parameters,
    execute: (args: typeof Parameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (process.platform !== "darwin")
          throw new Error(
            "Native computer capture is currently supported only on macOS. Use a configured computer/browser MCP service on this platform.",
          )
        assertComputerCaptureSafe()
        if (args.windowID !== undefined && (!Number.isSafeInteger(args.windowID) || args.windowID <= 0))
          throw new Error("windowID must be a positive integer")
        if (
          args.region &&
          (args.windowID !== undefined ||
            !Object.values(args.region).every(Number.isSafeInteger) ||
            args.region.width < 1 ||
            args.region.height < 1 ||
            args.region.width > 16384 ||
            args.region.height > 16384)
        )
          throw new Error("Use an integer crop with positive dimensions up to 16384, or a window ID, not both")
        yield* ctx.ask({
          permission: "computer_capture",
          patterns: [args.windowID ? `window:${args.windowID}` : "main-display"],
          always: ["*"],
          metadata: { surface: args.windowID ?? "main-display" },
        })
        const directory = path.join(Global.Path.cache, "computer", ctx.sessionID)
        const id = crypto.randomUUID()
        const filePath = path.join(directory, `${id}.png`)
        let observedTarget: Awaited<ReturnType<typeof foregroundTarget>> | undefined
        yield* Effect.promise(async () => {
          const displays = await runNativeComputerCommand(
            ["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"],
            ctx.abort,
          ).catch(() => "{}")
          const displayCount = (JSON.parse(displays).SPDisplaysDataType ?? []).reduce(
            (sum: number, gpu: { spdisplays_ndrvs?: unknown[] }) => sum + (gpu.spdisplays_ndrvs?.length ?? 0),
            0,
          )
          if (args.windowID === undefined && !args.region && displayCount === 1) {
            observedTarget = await foregroundTarget(ctx.abort).catch(() => undefined)
          }
          await mkdir(directory, { recursive: true, mode: 0o700 })
          if ((await readdir(directory)).filter((name) => name.endsWith(".png")).length >= 64)
            throw new Error(
              "This session reached its 64 screenshot artifact limit. Archive or remove its cached captures before continuing.",
            )
          await runNativeComputerCommand(
            [
              "/usr/sbin/screencapture",
              "-x",
              ...(args.region
                ? ["-R", `${args.region.x},${args.region.y},${args.region.width},${args.region.height}`]
                : args.windowID
                  ? ["-l", String(args.windowID)]
                  : ["-m"]),
              filePath,
            ],
            ctx.abort,
          )
          await runNativeComputerCommand(["/usr/bin/sips", "-Z", "1600", filePath], ctx.abort)
          if (observedTarget) {
            const after = await foregroundTarget(ctx.abort).catch(() => undefined)
            if (after?.pid !== observedTarget.pid || after.bundleID !== observedTarget.bundleID) observedTarget = undefined
          }
        })
        const bytes = yield* Effect.promise(() => readFile(filePath))
        if (
          bytes.length < 24 ||
          bytes.length > 8 * 1024 * 1024 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("Capture did not produce a bounded PNG")
        const width = bytes.readUInt32BE(16)
        const height = bytes.readUInt32BE(20)
        if (observedTarget) {
          registerComputerCapture({ id, mendcodeSessionID: ctx.sessionID, target: observedTarget, createdAt: Date.now() })
        }
        const metadata = {
          keyboardControlAvailable: observedTarget !== undefined,
          computerSessionBootstrapAvailable: observedTarget !== undefined,
          captureID: id,
          filePath,
          width,
          height,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          capturedAt: Date.now(),
          resized: true,
        }
        const previous = ctx.messages
          .flatMap((message) => message.parts)
          .find(
            (part) =>
              part.type === "tool" &&
              part.tool === "computer_capture" &&
              part.state.status === "completed" &&
              !part.state.time.compacted &&
              part.state.metadata.sha256 === metadata.sha256 &&
              part.state.attachments?.length &&
              !part.metadata?.codeMode,
          )
        return {
          title: "Computer screenshot",
          output: JSON.stringify({
            ...metadata,
            unchangedFrom: previous?.id,
            coordinates: "Preview pixels; do not assume these match desktop control coordinates.",
          }),
          metadata,
          attachments: previous
            ? []
            : [
                {
                  type: "file" as const,
                  mime: "image/png",
                  url: `data:image/png;base64,${bytes.toString("base64")}`,
                  filename: `${id}.png`,
                },
              ],
        }
      }).pipe(Effect.orDie),
  }),
)

const KEY_CODES = { tab: 48, escape: 53, enter: 36, space: 49, left: 123, right: 124, down: 125, up: 126 } as const
const ControlParameters = Schema.Struct({
  captureID: Schema.String,
  key: Schema.Literals(["tab", "escape", "enter", "space", "left", "right", "down", "up"]),
})

export const ComputerKeyTool = Tool.define(
  "computer_key",
  Effect.succeed({
    description:
      "Press one navigation key in the app observed by a recent computer_capture. macOS only; requires Accessibility permission and displays the MendCode cursor indicator before mutation. Supply its captureID, valid for 30 seconds in this session and one action. Fails if foreground app changed or was not observed; never activates another app. Capture again after each action.",
    parameters: ControlParameters,
    execute: (args: typeof ControlParameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (process.platform !== "darwin")
          throw new Error(
            "Native computer control is currently supported only on macOS. Use a configured computer/browser MCP service on this platform.",
          )
        yield* ctx.ask({
          permission: "computer_control",
          patterns: [`capture:${args.captureID}`],
          always: [`capture:${args.captureID}`],
          metadata: { captureID: args.captureID, key: args.key },
        })
        yield* Effect.promise(() =>
          runLegacyComputerKey({
            captureID: args.captureID,
            mendcodeSessionID: ctx.sessionID,
            keyCode: KEY_CODES[args.key],
            signal: ctx.abort,
          }),
        )
        return {
          title: "Computer key",
          output: `Pressed ${args.key}. Capture a new screenshot to inspect the result.`,
          metadata: { captureID: args.captureID, key: args.key },
        }
      }).pipe(Effect.orDie),
  }),
)

const SessionParameters = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("start"),
    mode: Schema.Literals(["observe", "control"]),
    bootstrapCaptureID: Schema.String,
  }),
  Schema.Struct({ action: Schema.Literal("stop"), computerSessionID: Schema.String }),
])

type ComputerSessionMetadata = {
  computerSessionID: string
  stopped: boolean
  target: Awaited<ReturnType<typeof foregroundTarget>> | null
  mode: "observe" | "control" | null
}

function currentRealUserMessage(ctx: Tool.Context): MessageV2.User {
  const assistant = ctx.messages.find(
    (message) => message.info.role === "assistant" && message.info.id === ctx.messageID,
  )
  const parentID = assistant?.info.role === "assistant" ? assistant.info.parentID : undefined
  const message = ctx.messages.find(
    (candidate) => candidate.info.role === "user" && candidate.info.id === parentID,
  )
  if (!message || message.info.role !== "user") {
    throw new Error("Computer Use requires the current explicit user message; background or detached activation is blocked.")
  }
  const explicit = message.parts.some(
    (part) =>
      part.type === "text" &&
      !part.synthetic &&
      part.metadata?.kind !== "peer_message" &&
      part.metadata?.kind !== "peer_response" &&
      part.text.trim().length > 0,
  )
  if (!explicit) throw new Error("Computer Use cannot be activated from a synthetic or peer-delivered message.")
  return message.info
}

export const ComputerSessionTool = Tool.define(
  "computer_session",
  Effect.succeed({
    description:
      "Start or stop a short-lived ComputerSession for an exact app observed by a fresh computer_capture. Start is allowed only from the current real user request and requires dedicated exact-target activation approval; discovery and full-access mode are not activation authority.",
    parameters: SessionParameters,
    execute: (args: typeof SessionParameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (args.action === "stop") {
          const stopped = stopComputerSession(args.computerSessionID, ctx.sessionID)
          const metadata: ComputerSessionMetadata = {
            computerSessionID: args.computerSessionID,
            stopped,
            target: null,
            mode: null,
          }
          return {
            title: "MendCode Computer",
            output: stopped ? "ComputerSession stopped." : "ComputerSession was already stopped.",
            metadata,
          }
        }
        const initiating = currentRealUserMessage(ctx)
        const target = inspectComputerCapture(args.bootstrapCaptureID, ctx.sessionID)
        const pattern = `target:${target.bundleID}:pid:${target.pid}:mode:${args.mode}`
        const requestText = ctx.messages
          .find((message) => message.info.id === initiating.id)
          ?.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
          .join(" ")
          .slice(0, 240)
        yield* ctx.ask({
          permission: "computer_activation",
          patterns: [pattern],
          always: [pattern],
          metadata: {
            title: "MendCode Computer",
            bootstrapCaptureID: args.bootstrapCaptureID,
            target,
            mode: args.mode,
            initiatingMessageID: initiating.id,
            request: requestText,
          },
        })
        const state = startComputerSession({
          mendcodeSessionID: ctx.sessionID,
          initiatingMessageID: initiating.id as MessageID,
          captureID: args.bootstrapCaptureID,
          mode: args.mode,
        })
        const metadata: ComputerSessionMetadata = {
          computerSessionID: state.id,
          stopped: false,
          target: state.target,
          mode: state.mode,
        }
        return {
          title: "MendCode Computer",
          output: JSON.stringify({
            computerSessionID: state.id,
            target: state.target,
            mode: state.mode,
            expiresAt: state.expiresAt,
            idleExpirySeconds: 60,
          }),
          metadata,
        }
      }).pipe(Effect.orDie),
  }),
)

const ObserveParameters = Schema.Struct({
  computerSessionID: Schema.String,
  screenshot: Schema.optional(Schema.Boolean).annotate({
    description: "When true, follow this semantic observation with computer_capture for visual evidence.",
  }),
})

export const ComputerObserveTool = Tool.define(
  "computer_observe",
  Effect.succeed({
    description:
      "Return a bounded, revisioned accessibility snapshot for an active exact-target ComputerSession. Secure values are redacted. Semantic observation is the default; request computer_capture separately only when screenshot fallback is needed.",
    parameters: ObserveParameters,
    execute: (args: typeof ObserveParameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const observation = yield* Effect.promise(() =>
          observeComputerSession(args.computerSessionID, ctx.sessionID, ctx.abort),
        )
        return {
          title: "Computer semantic observation",
          output: JSON.stringify({
            ...observation,
            ...(args.screenshot ? { screenshotFallback: "Call computer_capture now; the action indicator is not present during capture." } : {}),
          }),
          metadata: {
            computerSessionID: args.computerSessionID,
            revision: observation.revision,
            nodeCount: observation.nodes.length,
            truncated: observation.truncated,
          },
        }
      }).pipe(Effect.orDie),
  }),
)

const CodeParameters = Schema.Struct({
  computerSessionID: Schema.String,
  code: Schema.String.annotate({
    description:
      "Confined JavaScript subset using tools.observe({}), tools.press({revision,nodeID}), and tools.setValue({revision,nodeID,value}). No process, filesystem, network, imports, or persistent heap.",
  }),
})

export const ComputerCodeTool = Tool.define(
  "computer_code",
  Effect.succeed({
    description:
      "Run up to eight semantic ComputerSession operations in a 20-second confined program. Each mutating binding rechecks exact foreground target, revision, secure-field policy, and the visible cursor indicator host-side.",
    parameters: CodeParameters,
    execute: (args: typeof CodeParameters.Type, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "computer_control",
          patterns: [`session:${args.computerSessionID}`],
          always: [`session:${args.computerSessionID}`],
          metadata: { computerSessionID: args.computerSessionID, boundedActions: 8 },
        })
        const result = yield* Effect.promise(() =>
          executeComputerCode({
            id: args.computerSessionID,
            mendcodeSessionID: ctx.sessionID,
            code: args.code,
            signal: ctx.abort,
          }),
        )
        return {
          title: "Computer code",
          output: JSON.stringify(result),
          metadata: { computerSessionID: args.computerSessionID, ok: result.ok, toolCalls: result.toolCalls.length },
        }
      }).pipe(Effect.orDie),
  }),
)
