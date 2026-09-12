import { Effect, Schema } from "effect"
import type { MessageID, SessionID } from "@/session/schema"
import * as CodeMode from "@/mend/codemode/codemode"
import * as CodeTool from "@/mend/codemode/tool"
import { foregroundTarget, observeAccessibility, performSemanticAction } from "./macos-accessibility"
import { withVisibleComputerAction } from "./macos-overlay"
import type { ComputerObservation, ComputerSessionState, ComputerTarget } from "./types"

const ABSOLUTE_LIFETIME_MS = 10 * 60_000
const IDLE_LIFETIME_MS = 60_000
const captures = new Map<string, { mendcodeSessionID: SessionID; target: ComputerTarget; createdAt: number }>()
const sessions = new Map<string, ComputerSessionState>()

function trimOldest<T>(map: Map<string, T>, limit: number) {
  while (map.size >= limit) map.delete(map.keys().next().value!)
}

export function registerComputerCapture(input: {
  id: string
  mendcodeSessionID: SessionID
  target: ComputerTarget
  createdAt: number
}) {
  trimOldest(captures, 64)
  captures.set(input.id, input)
}

export function inspectComputerCapture(captureID: string, mendcodeSessionID: SessionID) {
  const capture = captures.get(captureID)
  if (!capture || capture.mendcodeSessionID !== mendcodeSessionID || Date.now() - capture.createdAt > 30_000) {
    throw new Error("Bootstrap capture is missing, stale, or belongs to another MendCode session.")
  }
  return capture.target
}

export function startComputerSession(input: {
  mendcodeSessionID: SessionID
  initiatingMessageID: MessageID
  captureID: string
  mode: "observe" | "control"
}) {
  const target = inspectComputerCapture(input.captureID, input.mendcodeSessionID)
  captures.delete(input.captureID)
  const now = Date.now()
  const state: ComputerSessionState = {
    id: crypto.randomUUID(),
    mendcodeSessionID: input.mendcodeSessionID,
    initiatingMessageID: input.initiatingMessageID,
    target,
    mode: input.mode,
    createdAt: now,
    expiresAt: now + ABSOLUTE_LIFETIME_MS,
    lastActiveAt: now,
    revision: 0,
    status: "active",
    consumedNodes: new Set(),
    actionInFlight: false,
    audit: [],
  }
  trimOldest(sessions, 64)
  sessions.set(state.id, state)
  return state
}

export function stopComputerSession(id: string, mendcodeSessionID: SessionID) {
  const state = sessions.get(id)
  if (!state || state.mendcodeSessionID !== mendcodeSessionID) return false
  state.status = "stopped"
  state.observation = undefined
  state.consumedNodes.clear()
  return true
}

function active(id: string, mendcodeSessionID: SessionID) {
  const state = sessions.get(id)
  if (!state || state.mendcodeSessionID !== mendcodeSessionID) throw new Error("ComputerSession was not found in this MendCode session.")
  const now = Date.now()
  if (state.status !== "active" || now > state.expiresAt || now - state.lastActiveAt > IDLE_LIFETIME_MS) {
    state.status = "stopped"
    state.observation = undefined
    throw new Error("ComputerSession expired or stopped. Start a new session from a fresh capture.")
  }
  state.lastActiveAt = now
  return state
}

async function assertTarget(state: ComputerSessionState, signal: AbortSignal) {
  const target = await foregroundTarget(signal)
  if (target.pid !== state.target.pid || target.bundleID !== state.target.bundleID) {
    state.status = "stopped"
    state.observation = undefined
    throw new Error("Computer target changed. No action was performed; start a new session for the foreground app.")
  }
}

export async function observeComputerSession(id: string, mendcodeSessionID: SessionID, signal: AbortSignal) {
  const state = active(id, mendcodeSessionID)
  await assertTarget(state, signal)
  const result = await observeAccessibility(state.target, signal)
  state.revision += 1
  state.consumedNodes.clear()
  const observation: ComputerObservation = {
    revision: state.revision,
    target: state.target,
    nodes: result.nodes,
    truncated: result.truncated,
    observedAt: Date.now(),
  }
  state.observation = observation
  return observation
}

async function act(
  state: ComputerSessionState,
  input: { revision: number; nodeID: string; action: "press" | "setValue"; value?: string },
  signal: AbortSignal,
) {
  if (state.mode !== "control") throw new Error("This ComputerSession is observe-only.")
  if (state.actionInFlight) throw new Error("Another ComputerSession action is already running.")
  const observation = state.observation
  if (!observation || observation.revision !== input.revision || state.revision !== input.revision) {
    throw new Error("Semantic observation is stale. Observe again before acting.")
  }
  const node = observation.nodes.find((item) => item.id === input.nodeID)
  if (!node) throw new Error("Semantic node does not belong to the current observation.")
  if (node.secure) throw new Error("Secure fields cannot be controlled by built-in Computer Use.")
  if (state.consumedNodes.has(input.nodeID)) throw new Error("Semantic node action was already consumed.")
  if (!node.actions.includes(input.action)) throw new Error(`Node does not support ${input.action}.`)

  state.actionInFlight = true
  try {
    await assertTarget(state, signal)
    state.consumedNodes.add(input.nodeID)
    await withVisibleComputerAction(signal, () => performSemanticAction(state.target, input, signal))
    state.audit.push({ action: input.action, revision: input.revision, nodeID: input.nodeID, result: "completed", at: Date.now() })
    state.revision += 1
    state.observation = undefined
    return { ok: true, revision: state.revision, action: input.action, nodeID: input.nodeID }
  } catch (error) {
    state.audit.push({ action: input.action, revision: input.revision, nodeID: input.nodeID, result: "failed", at: Date.now() })
    throw error
  } finally {
    state.actionInFlight = false
  }
}

const ObserveInput = Schema.Struct({})
const ObserveOutput = Schema.Unknown
const PressInput = Schema.Struct({ revision: Schema.Number, nodeID: Schema.String })
const SetValueInput = Schema.Struct({ revision: Schema.Number, nodeID: Schema.String, value: Schema.String })
const ActionOutput = Schema.Unknown

export async function executeComputerCode(input: {
  id: string
  mendcodeSessionID: SessionID
  code: string
  signal: AbortSignal
}) {
  if (Buffer.byteLength(input.code, "utf8") > 32 * 1024) throw new Error("Computer code exceeds the 32 KiB limit.")
  const state = active(input.id, input.mendcodeSessionID)
  const runtime = CodeMode.make({
    tools: {
      observe: CodeTool.make({
        description: "Observe the exact foreground target and return a revisioned semantic accessibility snapshot.",
        input: ObserveInput,
        output: ObserveOutput,
        execute: () => Effect.tryPromise(() => observeComputerSession(state.id, input.mendcodeSessionID, input.signal)),
      }),
      press: CodeTool.make({
        description: "Press a semantic node from the current observation revision.",
        input: PressInput,
        output: ActionOutput,
        execute: (args) => Effect.tryPromise(() => act(state, { ...args, action: "press" }, input.signal)),
      }),
      setValue: CodeTool.make({
        description: "Set a non-secure semantic text field value from the current observation revision.",
        input: SetValueInput,
        output: ActionOutput,
        execute: (args) => Effect.tryPromise(() => act(state, { ...args, action: "setValue" }, input.signal)),
      }),
    },
    limits: { timeoutMs: 20_000, maxToolCalls: 8, maxOutputBytes: 64 * 1024 },
  })
  return Effect.runPromise(runtime.execute(input.code))
}

export async function runLegacyComputerKey(input: {
  captureID: string
  mendcodeSessionID: SessionID
  keyCode: number
  signal: AbortSignal
}) {
  const capture = captures.get(input.captureID)
  if (!capture || capture.mendcodeSessionID !== input.mendcodeSessionID || Date.now() - capture.createdAt > 30_000) {
    throw new Error("Capture is missing or stale. Take a new screenshot before controlling the app.")
  }
  captures.delete(input.captureID)
  const target = await foregroundTarget(input.signal)
  if (target.pid !== capture.target.pid || target.bundleID !== capture.target.bundleID) {
    throw new Error("Foreground application changed; capture again.")
  }
  await withVisibleComputerAction(input.signal, () =>
    import("./macos-accessibility").then(({ runNativeComputerCommand }) =>
      runNativeComputerCommand(
        [
          "/usr/bin/osascript",
          "-e",
          'on run argv\ntell application "System Events" to tell first application process whose unix id is (item 1 of argv as integer) to key code (item 2 of argv as integer)\nend run',
          String(target.pid),
          String(input.keyCode),
        ],
        input.signal,
      ),
    ),
  )
}
