import { existsSync } from "fs"
import net from "node:net"
import path from "path"
import type { Plugin, PluginInput } from "@mendcode/plugin"
import { Global } from "@mendcode/core/global"
import { ServerAuth } from "@/server/auth"

const SOURCE = "herdr:opencode"
const AGENT = "opencode"
const STATE_SOURCE = "mendcode:state"
const STATE_AGENT = "mendcode"
const DISPLAY_SOURCE = "mendcode:display"
const DISPLAY_AGENT = "mendcode"
const OFFICIAL_PLUGIN_FILENAME = "herdr-agent-state.js"

let reportSeq = Date.now() * 1000

export type HerdrState = "idle" | "working" | "blocked"

type HerdrEvent = {
  type?: string
  properties?: Record<string, unknown>
}

export type HerdrPluginState = {
  currentSessionID?: string
  loopWorkflowsByRootSessionID?: Record<string, TrackedLoopWorkflow>
}

type HerdrAction =
  | {
      kind: "report"
      state: HerdrState
      sessionID?: string
      message?: string
      customStatus?: string
    }
  | {
      kind: "session"
      sessionID: string
    }
  | {
      kind: "release"
    }

type TrackedLoopWorkflow = {
  rootSessionID: string
  state: string
  phase?: string
}

type MinimalSessionInfo = {
  id?: string
  parentID?: string
}

const activeLoopWorkflowStates = new Set(["active", "sleeping", "working"])
const blockedLoopWorkflowStates = new Set(["needs_input", "blocked", "failed", "paused"])
const terminalLoopWorkflowStates = new Set(["completed", "stopped"])

function nextReportSeq() {
  reportSeq += 1
  return reportSeq
}

function sessionIDFromProperties(properties: Record<string, unknown> | undefined) {
  return typeof properties?.sessionID === "string" && properties.sessionID ? properties.sessionID : undefined
}

function errorMessageFromProperties(properties: Record<string, unknown> | undefined) {
  const error = properties?.error
  if (!error || typeof error !== "object") return undefined
  if (
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string" &&
    error.data.message.trim()
  ) {
    return error.data.message.trim()
  }
  if ("message" in error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim()
  }
  if ("name" in error && typeof error.name === "string" && error.name.trim()) {
    return error.name.trim()
  }
  return undefined
}

function officialHerdrPluginPath() {
  return path.join(Global.Path.config, "plugins", OFFICIAL_PLUGIN_FILENAME)
}

export function shouldEnableHerdrAgentStatePlugin(env = process.env) {
  if (env.HERDR_ENV !== "1") return false
  if (!env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return false
  if (env.MENDCODE_DISABLE_HERDR_REPORTING === "1") return false
  return !existsSync(officialHerdrPluginPath())
}

function statusText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function trackedLoopWorkflowFromProperties(properties: Record<string, unknown> | undefined) {
  const info = properties?.info
  if (!info || typeof info !== "object") return undefined
  const rootSessionID = statusText((info as Record<string, unknown>).rootSessionID)
  const state = statusText((info as Record<string, unknown>).state)
  if (!rootSessionID || !state) return undefined
  return {
    rootSessionID,
    state,
    phase: statusText((info as Record<string, unknown>).phase),
  } satisfies TrackedLoopWorkflow
}

function trackedLoopWorkflowFromItem(item: unknown) {
  if (!item || typeof item !== "object") return undefined
  const rootSessionID = statusText((item as Record<string, unknown>).rootSessionID)
  const state = statusText((item as Record<string, unknown>).state)
  if (!rootSessionID || !state) return undefined
  return {
    rootSessionID,
    state,
    phase: statusText((item as Record<string, unknown>).phase),
  } satisfies TrackedLoopWorkflow
}

function rememberLoopWorkflow(state: HerdrPluginState, workflow: TrackedLoopWorkflow) {
  state.loopWorkflowsByRootSessionID = {
    ...(state.loopWorkflowsByRootSessionID ?? {}),
    [workflow.rootSessionID]: workflow,
  }
}

function loopWorkflowForSession(state: HerdrPluginState, sessionID: string | undefined) {
  if (!sessionID) return undefined
  return state.loopWorkflowsByRootSessionID?.[sessionID]
}

async function refreshLoopWorkflowForSession(input: PluginInput, state: HerdrPluginState, sessionID: string) {
  try {
    const response = await fetch(new URL("/loop", input.serverUrl), {
      headers: {
        accept: "application/json",
        ...(ServerAuth.headers() ?? {}),
      },
    })
    if (!response.ok) return undefined
    const items = await response.json().catch(() => undefined)
    if (!Array.isArray(items)) return undefined
    for (const item of items) {
      const workflow = trackedLoopWorkflowFromItem(item)
      if (!workflow || workflow.rootSessionID !== sessionID) continue
      rememberLoopWorkflow(state, workflow)
      return workflow
    }
  } catch {
    return undefined
  }
}

function loopActionForWorkflow(workflow: TrackedLoopWorkflow, sessionID = workflow.rootSessionID): HerdrAction | undefined {
  const normalized = workflow.state.toLowerCase()
  const phase = workflow.phase?.trim()
  if (activeLoopWorkflowStates.has(normalized)) {
    return {
      kind: "report",
      state: "working",
      sessionID,
      customStatus: phase ? `loop ${phase}` : "loop active",
    }
  }
  if (blockedLoopWorkflowStates.has(normalized)) {
    return {
      kind: "report",
      state: "blocked",
      sessionID,
      customStatus: normalized === "paused" ? "loop paused" : normalized === "failed" ? "loop failed" : "loop blocked",
    }
  }
  if (terminalLoopWorkflowStates.has(normalized)) {
    return {
      kind: "report",
      state: "idle",
      sessionID,
      customStatus: normalized === "completed" ? "loop completed" : "loop stopped",
    }
  }
  return undefined
}

function stateFromSessionStatus(status: unknown): {
  state: HerdrState
  message?: string
  customStatus?: string
} | undefined {
  if (typeof status === "string") {
    switch (status.toLowerCase()) {
      case "idle":
        return { state: "idle" }
      case "retry":
      case "blocked":
        return { state: "blocked" }
      case "active":
      case "busy":
      case "pending":
      case "running":
      case "streaming":
      case "working":
        return { state: "working" }
      default:
        return undefined
    }
  }

  if (!status || typeof status !== "object") return undefined

  const kind = statusText((status as Record<string, unknown>).kind)
  const message = statusText((status as Record<string, unknown>).message)
  switch (statusText((status as Record<string, unknown>).type)?.toLowerCase()) {
    case "idle":
      return { state: "idle" }
    case "busy":
      return {
        state: "working",
        message,
        customStatus: kind === "memory-extract" ? "memory extract" : kind === "mflow-wait" ? "mflow wait" : undefined,
      }
    case "retry":
      return { state: "blocked", message, customStatus: "retry" }
    default:
      return undefined
  }
}

function isIdleAction(action: HerdrAction | undefined) {
  return action?.kind === "report" && action.state === "idle"
}

async function childSessions(client: PluginInput["client"], sessionID: string) {
  try {
    const children = client.session.children as unknown as (input: { sessionID: string }) => Promise<{ data?: MinimalSessionInfo[] }>
    const response = await children({
      sessionID,
    })
    return response.data ?? []
  } catch {
    return []
  }
}

async function activeChildState(client: PluginInput["client"], sessionID: string) {
  const children = await childSessions(client, sessionID)
  if (children.length === 0) return undefined

  try {
    const statuses = (await client.session.status()).data ?? {}
    for (const child of children) {
      const childID = typeof child.id === "string" ? child.id : undefined
      if (!childID) continue
      const reported = stateFromSessionStatus(statuses[childID])
      if (reported?.state === "blocked" || reported?.state === "working") return { state: "working" as const }
    }
  } catch {
    return undefined
  }
}

async function selectedChildSessionID(client: PluginInput["client"], parentSessionID: string, eventSessionID: string) {
  const children = await childSessions(client, parentSessionID)
  return children.some((child) => child.id === eventSessionID) ? eventSessionID : undefined
}

async function isRootSession(client: PluginInput["client"], sessionID: string) {
  try {
    const get = client.session.get as unknown as (input: { sessionID: string }) => Promise<{ data?: MinimalSessionInfo }>
    const response = await get({
      sessionID,
    })
    return !response.data?.parentID
  } catch {
    return true
  }
}

async function shouldHandleHookSession(client: PluginInput["client"], state: HerdrPluginState, sessionID: string) {
  if (state.currentSessionID) return sessionID === state.currentSessionID
  return isRootSession(client, sessionID)
}

export function herdrActionForEvent(event: HerdrEvent, state?: HerdrPluginState): HerdrAction | undefined {
  const type = event?.type
  const properties = event?.properties
  const sessionID = sessionIDFromProperties(properties)
  const rememberSession = () => {
    if (sessionID && state) state.currentSessionID = sessionID
    return sessionID
  }

  switch (type) {
    case "tui.session.select": {
      const trackedSessionID = rememberSession()
      return trackedSessionID ? { kind: "session", sessionID: trackedSessionID } : undefined
    }
    case "session.created":
    case "session.updated": {
      const trackedSessionID = rememberSession()
      return trackedSessionID ? { kind: "session", sessionID: trackedSessionID } : undefined
    }
    case "session.status": {
      const trackedSessionID = rememberSession()
      const reported = stateFromSessionStatus(properties?.status)
      if (!reported) return trackedSessionID ? { kind: "session", sessionID: trackedSessionID } : undefined
      return {
        kind: "report",
        ...reported,
        sessionID: trackedSessionID,
      }
    }
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
    case "plan_review.replied":
    case "session.compacted":
      return { kind: "report", state: "working", sessionID: rememberSession() }
    case "permission.asked":
      return { kind: "report", state: "blocked", sessionID: rememberSession(), customStatus: "needs approval" }
    case "question.asked":
      return { kind: "report", state: "blocked", sessionID: rememberSession(), customStatus: "needs input" }
    case "plan_review.asked":
      return { kind: "report", state: "blocked", sessionID: rememberSession(), customStatus: "plan pending" }
    case "session.error":
      if (!rememberSession()) return undefined
      return {
        kind: "report",
        state: "blocked",
        sessionID: state?.currentSessionID,
        message: errorMessageFromProperties(properties),
        customStatus: "error",
      }
    case "session.idle":
      return { kind: "report", state: "idle", sessionID: rememberSession() }
    case "session.deleted":
      if (!sessionID) return undefined
      if (state?.currentSessionID && state.currentSessionID !== sessionID) return undefined
      if (state) state.currentSessionID = undefined
      return { kind: "release" }
    case "server.instance.disposed":
      if (state) state.currentSessionID = undefined
      return { kind: "release" }
    default:
      return undefined
  }
}

type RequestParams = {
  state?: HerdrState
  message?: string
  custom_status?: string
  agent_session_id?: string
}

type RequestIdentity = {
  source: string
  agent: string
}

const OFFICIAL_IDENTITY: RequestIdentity = {
  source: SOURCE,
  agent: AGENT,
}

const STATE_IDENTITY: RequestIdentity = {
  source: STATE_SOURCE,
  agent: STATE_AGENT,
}

function socketRequest(
  method: "pane.report_agent" | "pane.report_agent_session" | "pane.report_metadata" | "pane.release_agent",
  params: Record<string, unknown>,
  identity = OFFICIAL_IDENTITY,
) {
  const paneID = process.env.HERDR_PANE_ID
  const socketPath = process.env.HERDR_SOCKET_PATH

  if (!paneID || !socketPath) return Promise.resolve()

  const requestID = `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`
  const request = {
    id: requestID,
    method,
    params: {
      pane_id: paneID,
      source: identity.source,
      agent: identity.agent,
      seq: nextReportSeq(),
      ...params,
    },
  }

  return new Promise<void>((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(`${JSON.stringify(request)}\n`)
    })

    const finish = () => {
      client.destroy()
      resolve()
    }

    client.setTimeout(500, finish)
    client.on("data", finish)
    client.on("error", finish)
    client.on("end", finish)
    client.on("close", resolve)
  })
}

function request(method: "pane.report_agent" | "pane.report_agent_session" | "pane.release_agent", params: RequestParams) {
  return socketRequest(method, params)
}

function requestState(method: "pane.report_agent" | "pane.release_agent", params: RequestParams) {
  return socketRequest(method, params, STATE_IDENTITY)
}

function reportDisplayAgent() {
  return socketRequest("pane.report_metadata", {
    source: DISPLAY_SOURCE,
    display_agent: DISPLAY_AGENT,
  })
}

async function reportInitialAgentPresence() {
  await requestState("pane.report_agent", { state: "idle" })
  await reportDisplayAgent()
}

async function syncSelectedSessionStatus(input: PluginInput, state: HerdrPluginState, sessionID: string) {
  try {
    const client = input.client
    const activeChild = await activeChildState(client, sessionID)
    if (activeChild) {
      await applyHerdrAction({
        kind: "report",
        ...activeChild,
        sessionID,
      })
      return
    }
    const loopAction = loopWorkflowForSession(state, sessionID)
    const refreshedLoop = loopAction ?? (await refreshLoopWorkflowForSession(input, state, sessionID))
    if (refreshedLoop) {
      const reported = loopActionForWorkflow(refreshedLoop, sessionID)
      if (reported) {
        await applyHerdrAction(reported)
        return
      }
    }
    const response = await client.session.status()
    const reported = stateFromSessionStatus(response.data?.[sessionID]) ?? {
      state: "idle" as const,
    }
    await applyHerdrAction({
      kind: "report",
      ...reported,
      sessionID,
    })
  } catch {
    // Ignore sync failures here; live session events still update Herdr.
  }
}

async function reportCurrentSessionStatus(
  client: PluginInput["client"],
  state: HerdrPluginState,
  sessionID: string,
  fallback: HerdrState,
) {
  try {
    const activeChild = await activeChildState(client, sessionID)
    if (activeChild) {
      await applyHerdrAction({
        kind: "report",
        ...activeChild,
        sessionID,
      })
      return
    }
    const loopAction = loopWorkflowForSession(state, sessionID)
    if (loopAction) {
      const reported = loopActionForWorkflow(loopAction, sessionID)
      if (reported) {
        await applyHerdrAction(reported)
        return
      }
    }
    const response = await client.session.status()
    const reported = stateFromSessionStatus(response.data?.[sessionID]) ?? {
      state: fallback,
    }
    await applyHerdrAction({
      kind: "report",
      ...reported,
      sessionID,
    })
  } catch {
    await applyHerdrAction({
      kind: "report",
      state: fallback,
      sessionID,
    })
  }
}

async function herdrActionForPluginEvent(
  client: PluginInput["client"],
  event: HerdrEvent,
  state: HerdrPluginState,
) {
  const type = event?.type
  if (type === "loop.workflow.updated") {
    const workflow = trackedLoopWorkflowFromProperties(event.properties)
    if (!workflow) return undefined
    rememberLoopWorkflow(state, workflow)
    if (workflow.rootSessionID !== state.currentSessionID) return undefined
    return loopActionForWorkflow(workflow)
  }

  const eventSessionID = sessionIDFromProperties(event.properties)
  const currentSessionID = state.currentSessionID

  if (type === "tui.session.select") return herdrActionForEvent(event, state)

  if (
    currentSessionID &&
    eventSessionID &&
    eventSessionID !== currentSessionID
  ) {
    const childID = await selectedChildSessionID(client, currentSessionID, eventSessionID)
    if (childID) {
      if (type === "session.created" || type === "session.updated") {
        return { kind: "report" as const, state: "working" as const, sessionID: currentSessionID }
      }
      if (type === "session.status") {
        const reported = stateFromSessionStatus(event.properties?.status)
        if (!reported || reported.state === "idle") return undefined
        return { kind: "report" as const, state: "working" as const, sessionID: currentSessionID }
      }
    }
    return undefined
  }

  if (!currentSessionID && eventSessionID && !(await isRootSession(client, eventSessionID))) {
    return undefined
  }

  const action = herdrActionForEvent(event, state)
  if (action?.kind === "report") {
    const loopWorkflow = loopWorkflowForSession(state, action.sessionID)
    if (loopWorkflow && isIdleAction(action)) {
      const loopAction = loopActionForWorkflow(loopWorkflow, action.sessionID)
      if (loopAction) return loopAction
    }
    if (isIdleAction(action) && action.sessionID) {
      const activeChild = await activeChildState(client, action.sessionID)
      if (activeChild) return { kind: "report" as const, ...activeChild, sessionID: action.sessionID }
    }
  }
  return action
}

async function applyHerdrAction(action: HerdrAction | undefined) {
  if (!action) return
  if (action.kind === "release") {
    await requestState("pane.release_agent", {})
    await request("pane.release_agent", {})
    return
  }
  await reportDisplayAgent()
  if (action.kind === "session") {
    await request("pane.report_agent_session", { agent_session_id: action.sessionID })
    return
  }

  await requestState("pane.report_agent", {
    state: action.state,
    message: action.message,
    custom_status: action.customStatus,
  })
  if (action.sessionID) {
    await request("pane.report_agent_session", { agent_session_id: action.sessionID })
  }
}

export const HerdrAgentStatePlugin: Plugin = async (input) => {
  if (!shouldEnableHerdrAgentStatePlugin()) return {}

  const state: HerdrPluginState = {}
  await reportInitialAgentPresence()

  return {
    "chat.message": async ({ sessionID }) => {
      if (!(await shouldHandleHookSession(input.client, state, sessionID))) return
      state.currentSessionID = sessionID
      await applyHerdrAction({
        kind: "session",
        sessionID,
      })
      await applyHerdrAction({
        kind: "report",
        state: "working",
        sessionID,
      })
    },
    "tool.execute.before": async ({ sessionID }) => {
      if (!(await shouldHandleHookSession(input.client, state, sessionID))) return
      state.currentSessionID = sessionID
      await applyHerdrAction({
        kind: "report",
        state: "working",
        sessionID,
      })
    },
    "tool.execute.after": async ({ sessionID }) => {
      if (!(await shouldHandleHookSession(input.client, state, sessionID))) return
      state.currentSessionID = sessionID
      await reportCurrentSessionStatus(input.client, state, sessionID, "idle")
    },
    event: async ({ event }) => {
      const herdrEvent = event as HerdrEvent
      await applyHerdrAction(await herdrActionForPluginEvent(input.client, herdrEvent, state))
      if (herdrEvent.type !== "tui.session.select") return
      const sessionID = sessionIDFromProperties(herdrEvent.properties)
      if (!sessionID) return
      await syncSelectedSessionStatus(input, state, sessionID)
    },
  }
}
