import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ComputerSessionInput, ComputerObserveInput, ComputerCodeInput, ComputerNode, ComputerActionInput, type ComputerTarget, type ComputerObservation, type ComputerSessionReport, type SessionId } from "@mendcode/protocol"
import { fail, type ComputerActivation, type ToolResult } from "@mendcode/tools"
import type { ComputerAccessibility, SemanticAction } from "./computer-accessibility"
import { runComputerProgram } from "./computer-program"

type Audit = { action: string; revision: number; nodeID: string; result: "dispatched" | "failed" | "unknown"; at: number }
type State = { id: string; sessionId: SessionId; sourceId: string; target: ComputerTarget; mode: "observe" | "control"; createdAt: number; expiresAt: number; lastActiveAt: number; revision: number; stopped: boolean; busy: boolean; program: boolean; abort: AbortController; observation?: ComputerObservation | undefined; audit: Audit[] }
const same = (a: ComputerTarget, b: ComputerTarget) => a.pid === b.pid && a.bundleID === b.bundleID
const mutations = new Set(["press", "setValue", "click", "typeText", "key", "scroll", "drag"])
const fields: Record<string, string[]> = { press: [], setValue: ["value"], click: ["button", "count"], typeText: ["value"], key: ["key", "modifiers"], scroll: ["direction", "amount"], drag: ["toNodeID"] }

/** Authority and live snapshots are memory-only; transcripts cannot resume them. */
export function createComputerSessions(os: ComputerAccessibility, now: () => number, available: (id: SessionId, signal: AbortSignal) => void, stopping: AbortSignal, consumed: (id: string) => void) {
  const captures = new Map<string, { sessionId: SessionId; target: ComputerTarget; at: number }>()
  const sessions = new Map<string, State>()
  let actionInFlight = false, capturing = 0
  const trim = <T>(map: Map<string, T>) => { while (map.size >= 64) map.delete(map.keys().next().value!) }
  const clear = (state: State) => {
    state.stopped = true; state.observation = undefined; state.abort.abort()
    // The broker keeps window handles per application: releasing them under another live session of the same app ends that session too.
    if (![...sessions.values()].some((other) => other !== state && !other.stopped && now() < other.expiresAt && now() - other.lastActiveAt < 60000 && other.target.pid === state.target.pid)) os.release?.(state.target)
  }
  function bootstrap(id: string, sessionId: SessionId) {
    const capture = captures.get(id)
    if (!capture || capture.sessionId !== sessionId || now() < capture.at || now() - capture.at > 30000) throw new Error("Bootstrap capture is missing, stale, or belongs to another session")
    return capture
  }
  function active(id: string, sessionId: SessionId, signal: AbortSignal) {
    available(sessionId, signal)
    const state = sessions.get(id)
    if (!state || state.sessionId !== sessionId) throw new Error("ComputerSession was not found in this session")
    if (state.stopped || now() < state.createdAt || now() >= state.expiresAt || now() - state.lastActiveAt >= 60000) { clear(state); throw new Error("ComputerSession expired or stopped; start a new session") }
    return state
  }
  /** The session stays bound to its approved process and bundle ID wherever the user is working. `needsFront` names an action that also needs the app in front: it is refused, without ending the session, while another app is. */
  async function target(state: State, signal: AbortSignal, needsFront?: string) {
    const current = await os.identify(state.target, signal)
    if (!current || !same(state.target, current)) { clear(state); throw new Error("Computer target changed; no action was performed. Start a new session") }
    active(state.id, state.sessionId, signal)
    // Refresh labels after navigation without silently switching the selected window.
    if (!state.target.windowID || state.target.windowID === current.windowID) state.target = { ...state.target, ...current }
    if (needsFront && !same(state.target, await os.foreground(signal))) throw new Error(`${needsFront} needs ${state.target.appName || "the app"} in front and another app is in front; no input was sent. observe, press and setValue work while it is in the background. Use them, or ask the user to bring the app forward`)
  }
  async function inputLease<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (actionInFlight || capturing) throw new Error("Another ComputerSession operation is running")
    actionInFlight = true
    try { signal.throwIfAborted(); return await action() } finally { actionInFlight = false }
  }
  async function observe(id: string, sessionId: SessionId, signal: AbortSignal): Promise<ComputerObservation> {
    const state = active(id, sessionId, signal)
    signal = AbortSignal.any([signal, state.abort.signal])
    if (state.busy || actionInFlight || capturing) throw new Error("Another ComputerSession operation is running")
    state.busy = true
    try {
      await target(state, signal)
      const result = await os.observe(state.target, signal)
      await target(state, signal)
      const nodes: ComputerObservation["nodes"] = []
      let bytes = 0, truncated = result.truncated
      const ids = new Set<string>()
      for (const raw of result.nodes) {
        const node = ComputerNode.parse(raw)
        if (ids.has(node.id)) throw new Error("Accessibility snapshot has duplicate node IDs")
        ids.add(node.id)
        if (node.secure || node.role === "AXSecureTextField" || node.states.includes("secure")) { node.secure = true; node.name = ""; delete node.value; node.actions = [] }
        bytes += Buffer.byteLength(JSON.stringify(node))
        if (nodes.length >= 500 || bytes > 60000) { truncated = true; break }
        nodes.push(node)
      }
      state.revision++
      state.lastActiveAt = now()
      state.observation = { revision: state.revision, target: state.target, nodes, truncated, observedAt: now() }
      return structuredClone(state.observation)
    } catch (error) { state.observation = undefined; throw error }
    finally { state.busy = false }
  }
  async function act(id: string, sessionId: SessionId, raw: unknown, action: SemanticAction["action"], signal: AbortSignal) {
    const input = ComputerActionInput.parse(raw)
    for (const key of Object.keys(input)) if (!["revision", "nodeID", ...fields[action]!].includes(key)) throw new Error(`Unexpected ${key} for ${action}`)
    if ((action === "setValue" || action === "typeText") && typeof input.value !== "string" || action === "key" && !input.key || action === "drag" && !input.toNodeID) throw new Error("Invalid native action input")
    const state = active(id, sessionId, signal)
    signal = AbortSignal.any([signal, state.abort.signal])
    if (state.mode !== "control") throw new Error("This ComputerSession is observe-only")
    if (state.busy || actionInFlight || capturing) throw new Error("Another ComputerSession operation is running")
    const observation = state.observation
    if (!observation || observation.revision !== input.revision || state.revision !== input.revision || now() - observation.observedAt > 15000) throw new Error("Semantic observation is stale; observe again before acting")
    const node = observation.nodes.find((node) => node.id === input.nodeID)
    if (!node) throw new Error("Semantic node does not belong to the current observation")
    if (node.secure) throw new Error("Secure fields cannot be controlled")
    if (!node.actions.includes(action)) throw new Error(`Node does not support ${action}`)
    if (input.toNodeID) {
      const destination = observation.nodes.find((node) => node.id === input.toNodeID)
      if (!destination || destination.secure || !destination.actions.includes("drag")) throw new Error("Drag destination is not an actionable non-secure node in this observation")
    }
    // Every action reaches the bound app where it is: AXPress and AXSetValue go to the element, keys, text, pointer events and drags
    // are posted to its process (the helper checks the point against that app's own window, not what is on top of the screen).
    state.busy = true
    state.observation = undefined
    state.revision++
    let dispatched = false
    try {
      return await inputLease(signal, async () => {
        await target(state, signal)
        const semantic: SemanticAction = { ...input, action, role: node.role }
        await os.indicator(signal, async () => { await target(state, signal); dispatched = true; await os.action(state.target, semantic, signal) })
        active(id, sessionId, signal)
        state.lastActiveAt = now()
        state.audit.push({ action, revision: input.revision, nodeID: input.nodeID, result: "dispatched", at: now() })
        return { ok: true, revision: state.revision, action, nodeID: input.nodeID, outcome: "dispatched", verified: false, next: "Observe again and check the intended postcondition; dispatch is not proof of success." }
      })
    } catch (error) { state.audit.push({ action, revision: input.revision, nodeID: input.nodeID, result: dispatched ? "unknown" : "failed", at: now() }); throw error }
    finally { state.busy = false; state.audit = state.audit.slice(-64) }
  }
  async function selectWindow(id: string, sessionId: SessionId, raw: unknown, signal: AbortSignal) {
    const input = z.strictObject({ windowID: z.string().min(1).max(128) }).parse(raw)
    const state = active(id, sessionId, signal)
    signal = AbortSignal.any([signal, state.abort.signal])
    if (state.mode !== "control") throw new Error("Window selection requires control mode")
    if (!os.selectWindow || state.busy) throw new Error("Window selection is unavailable or busy")
    state.busy = true; state.observation = undefined; state.revision++
    try {
      await inputLease(signal, async () => {
        await target(state, signal, "selectWindow")
        await os.indicator(signal, async () => {
          const selected = await os.selectWindow!(state.target, input.windowID, signal)
          if (!same(selected, state.target)) { clear(state); throw new Error("Window selection changed the application") }
          active(id, sessionId, signal)
          state.target = selected
        })
      })
      state.lastActiveAt = now()
      return { target: state.target, revision: state.revision, next: "Observe the selected window before acting." }
    } finally { state.busy = false }
  }
  const result = (title: string, data: unknown, meta: ToolResult["meta"] = {}): ToolResult => ({ title, output: JSON.stringify(data), truncated: false, isError: false, meta })
  async function guarded(title: string, action: () => Promise<ToolResult>): Promise<ToolResult> {
    try { return await action() } catch (error) { return fail({ title, message: error instanceof Error ? error.message : "Computer operation failed" }) }
  }
  return {
    inputLease,
    captureSafe() { if (actionInFlight) throw new Error("Computer capture is blocked while the action indicator is active") },
    beginCapture() { if (actionInFlight) throw new Error("Computer capture is blocked while the action indicator is active"); capturing++ },
    endCapture() { capturing = Math.max(0, capturing - 1) },
    register(id: string, sessionId: SessionId, target: ComputerTarget, at: number) { trim(captures); captures.set(id, { sessionId, target, at }) },
    consume(id: string) { captures.delete(id) },
    port(sessionId: SessionId) {
      return {
        session(raw: ComputerSessionInput, abort: AbortSignal, activation?: ComputerActivation) {
          const signal = AbortSignal.any([abort, stopping])
          return guarded("MendCode Computer", async () => {
            available(sessionId, signal)
            const input = ComputerSessionInput.parse(raw)
            if (input.action === "apps") {
              if (!os.apps) throw new Error("Application discovery is unavailable")
              return result("Computer applications", { computerSessionID: "", stopped: true, target: null, mode: null, apps: await os.apps(signal) } satisfies ComputerSessionReport)
            }
            if (input.action === "stop") {
              const state = sessions.get(input.computerSessionID)
              if (state && state.sessionId !== sessionId) throw new Error("ComputerSession was not found in this session")
              if (state) clear(state)
              return result("MendCode Computer", { computerSessionID: input.computerSessionID, stopped: true, target: null, mode: null } satisfies ComputerSessionReport)
            }
            if (!activation || activation.synthetic || !activation.sourceId || !activation.text.trim()) throw new Error("Computer Use requires the current real user request; synthetic or detached activation is blocked")
            const capture = input.bootstrapCaptureID ? bootstrap(input.bootstrapCaptureID, sessionId) : undefined
            let selected = capture?.target
            if (capture) {
              // The capture proved this process was in front when it was taken; the user may have moved on since, and the same process and bundle ID stay the authority.
              if (!await os.identify(capture.target, signal)) throw new Error("Computer target changed; start from a fresh capture")
            } else {
              if (!os.resolve || !os.activate || !input.bundleID) throw new Error("Explicit application targeting is unavailable")
              selected = await os.resolve(input.bundleID, signal)
              if (selected.bundleID !== input.bundleID) throw new Error("Application identity did not match")
            }
            if (!selected || !await activation.approve(structuredClone(selected), input.mode)) throw new Error("Computer activation denied")
            available(sessionId, signal)
            if (capture) {
              if (bootstrap(input.bootstrapCaptureID!, sessionId) !== capture) throw new Error("Bootstrap capture was consumed")
              if (!await os.identify(capture.target, signal)) throw new Error("Computer target changed during approval")
              available(sessionId, signal)
              bootstrap(input.bootstrapCaptureID!, sessionId)
              captures.delete(input.bootstrapCaptureID!); consumed(input.bootstrapCaptureID!)
            } else {
              const approved = selected
              await inputLease(signal, async () => {
                await os.indicator(signal, async () => {
                  available(sessionId, signal)
                  selected = await os.activate!(approved, signal)
                  if (selected.bundleID !== approved.bundleID || approved.pid > 0 && selected.pid !== approved.pid) throw new Error("Approved application identity changed")
                  available(sessionId, signal)
                })
              })
            }
            const at = now(), id = randomUUID()
            const state: State = { id, sessionId, sourceId: activation.sourceId, target: selected, mode: input.mode, createdAt: at, expiresAt: at + 600000, lastActiveAt: at, revision: 0, stopped: false, busy: false, program: false, abort: new AbortController(), audit: [] }
            while (sessions.size >= 64) { const oldest = sessions.keys().next().value!; clear(sessions.get(oldest)!); sessions.delete(oldest) }
            sessions.set(id, state)
            return result("MendCode Computer", { computerSessionID: id, stopped: false, target: state.target, mode: state.mode, expiresAt: state.expiresAt, idleExpirySeconds: 60 } satisfies ComputerSessionReport, { computerSessionID: id })
          })
        },
        observe(raw: ComputerObserveInput, abort: AbortSignal) {
          const signal = AbortSignal.any([abort, stopping])
          return guarded("Computer semantic observation", async () => {
            const input = ComputerObserveInput.parse(raw)
            const observation = await observe(input.computerSessionID, sessionId, signal)
            return result("Computer semantic observation", { ...observation, ...(input.screenshot ? { screenshotFallback: "Call computer_capture for visual evidence: no arguments for the main display, or region set to the first node's bounds for this window (windowID there is a macOS number, not this session's handle); preview pixels are not control coordinates." } : {}) }, { computerSessionID: input.computerSessionID, revision: observation.revision, nodeCount: observation.nodes.length, truncated: observation.truncated })
          })
        },
        code(raw: ComputerCodeInput, abort: AbortSignal) {
          const signal = AbortSignal.any([abort, stopping])
          return guarded("Computer code", async () => {
            const input = ComputerCodeInput.parse(raw)
            const state = active(input.computerSessionID, sessionId, signal)
            if (state.program) throw new Error("Another computer program is running in this session")
            state.program = true
            const bounded = AbortSignal.any([signal, state.abort.signal, AbortSignal.timeout(30000)])
            try {
              const execute = () => runComputerProgram(input.code, bounded, async (name, args) => {
                active(state.id, sessionId, bounded)
                if (name === "observe") { z.strictObject({}).parse(args); return observe(state.id, sessionId, bounded) }
                if (mutations.has(name)) return act(state.id, sessionId, args, name as SemanticAction["action"], bounded)
                if (name === "selectWindow") return selectWindow(state.id, sessionId, args, bounded)
                if (name === "status") { z.strictObject({}).parse(args); return { target: structuredClone(state.target), mode: state.mode, expiresAt: state.expiresAt, revision: state.revision, audit: structuredClone(state.audit) } }
                if (name === "windows") {
                  z.strictObject({}).parse(args)
                  if (!os.windows) throw new Error("Window discovery is unavailable")
                  await target(state, bounded)
                  return os.windows(state.target, bounded)
                }
                if (name === "waitFor") {
                  const match = z.strictObject({ name: z.string().max(256).optional(), role: z.string().max(256).optional(), value: z.string().max(256).optional(), timeoutMs: z.number().int().min(0).max(10000).default(3000) }).refine((q) => q.name !== undefined || q.role !== undefined || q.value !== undefined, "Specify a name, role or value").parse(args)
                  const deadline = Date.now() + match.timeoutMs
                  do {
                    const observation = await observe(state.id, sessionId, bounded)
                    const node = observation.nodes.find((node) => !node.secure && (match.name === undefined || node.name === match.name) && (match.role === undefined || node.role === match.role) && (match.value === undefined || node.value === match.value))
                    if (node) return { matched: true, node, observation }
                    if (Date.now() >= deadline) return { matched: false, observation }
                    await Bun.sleep(100)
                    bounded.throwIfAborted()
                  } while (true)
                }
                throw new Error("Unknown computer operation")
              })
              const report = state.mode === "control" && os.program ? await os.program(state.target, bounded, execute) : await execute()
              return { ...result("Computer code", report, { computerSessionID: state.id, ok: report.ok, toolCalls: report.toolCalls.length }), isError: !report.ok }
            } finally { state.program = false }
          })
        },
      }
    },
    stop() { for (const state of sessions.values()) clear(state); sessions.clear(); captures.clear(); os.stop?.() },
  }
}
