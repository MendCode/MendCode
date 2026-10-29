import path from "node:path"
import type { DaemonExtensionAPI, SessionChange } from "@mendcode/extension-api"
import type { ExtensionRecord } from "./types"

/** What the daemon lets extensions do to a session; every method checks and answers, none throws. */
export type ExtensionSessionPort = {
  directory(sessionId: string): string | undefined
  model(sessionId: string): { model: string; effort?: string } | undefined
  /** The same checks as `/model`: a model of the catalog, on the engine the session already runs, with an effort it lists. */
  setModel(sessionId: string, choice: { model: string; effort?: string }): Promise<SessionChange>
  activeTools(sessionId: string): readonly string[] | undefined
  /** Answers why the limit cannot apply (a session another engine runs), else stores it. */
  setActiveTools(sessionId: string, tools: readonly string[] | undefined): string | void
  /** Queues a user message (`steer`: to the running turn where it can take it), with pasted-secret masking like a typed one. */
  submit(sessionId: string, text: string, delivery: "queue" | "steer"): Promise<SessionChange>
}

const TOOL_PATTERN = /^[A-Za-z0-9_*:.-]{1,100}$/
const MAX_TEXT = 64_000
/** `sendUserMessage`: messages one extension may queue in one session per window. */
const SEND_LIMIT = 5
const SEND_WINDOW_MS = 60_000

type SessionApi = Pick<DaemonExtensionAPI, "getModel" | "setModel" | "setThinkingLevel" | "getActiveTools" | "setActiveTools" | "sendUserMessage">

/**
 * The session half of an extension's API. A user extension may act on any session; a project extension only on sessions of the
 * project it was loaded for. Nothing here reaches permissions, approvals, budgets or the tier: the port only does what `/model`,
 * a narrower tool list and a typed message do.
 */
export function createSessionApi(input: { record: ExtensionRecord; port: ExtensionSessionPort | undefined; fail(message: string): void; now(): number }): SessionApi {
  const { record, port } = input
  const sends = new Map<string, number[]>()
  const refuse = (error: string): SessionChange => { input.fail(error); return { ok: false, error } }
  function owner(sessionId: unknown, what: string): string | undefined {
    if (!port) return `${what}: sessions are not available in this daemon`
    const directory = typeof sessionId === "string" ? port.directory(sessionId) : undefined
    if (!directory) return `${what}: unknown session`
    if (record.layer === "project" && record.scopeDir !== undefined && path.resolve(directory) !== path.resolve(record.scopeDir)) return `${what}: a project extension acts only on its project's sessions`
    return undefined
  }
  return {
    getModel(sessionId) {
      return owner(sessionId, "getModel") ? undefined : port!.model(sessionId)
    },
    async setModel(sessionId, model, options) {
      const problem = owner(sessionId, "setModel")
      if (problem) return refuse(problem)
      if (typeof model !== "string" || !model.trim() || model.length > 100) return refuse("setModel: a model id from /model")
      if (options?.effort !== undefined && typeof options.effort !== "string") return refuse("setModel: effort is a string")
      const answer = await port!.setModel(sessionId, { model, ...(options?.effort ? { effort: options.effort } : {}) })
      if (!answer.ok) input.fail(answer.error)
      return answer
    },
    async setThinkingLevel(sessionId, effort) {
      const problem = owner(sessionId, "setThinkingLevel")
      if (problem) return refuse(problem)
      const current = port!.model(sessionId)
      if (!current) return refuse("setThinkingLevel: the session has no model")
      if (typeof effort !== "string" || !effort) return refuse("setThinkingLevel: an effort the model lists (low, medium, high…)")
      const answer = await port!.setModel(sessionId, { model: current.model, effort })
      if (!answer.ok) input.fail(answer.error)
      return answer
    },
    getActiveTools(sessionId) {
      if (owner(sessionId, "getActiveTools")) return undefined
      const tools = port!.activeTools(sessionId)
      return tools ? [...tools] : undefined
    },
    setActiveTools(sessionId, tools) {
      const problem = owner(sessionId, "setActiveTools")
      if (problem) return refuse(problem)
      if (tools !== null && (!Array.isArray(tools) || tools.length > 200 || tools.some((name) => typeof name !== "string" || !TOOL_PATTERN.test(name)))) return refuse("setActiveTools: tool names (or patterns like mcp__*), at most 200, or null")
      const refused = port!.setActiveTools(sessionId, tools === null ? undefined : [...new Set(tools)])
      return refused ? refuse(`setActiveTools: ${refused}`) : { ok: true }
    },
    async sendUserMessage(sessionId, text, options) {
      const problem = owner(sessionId, "sendUserMessage")
      if (problem) return refuse(problem)
      if (typeof text !== "string" || !text.trim()) return refuse("sendUserMessage: text is a non-empty string")
      if (options?.deliverAs !== undefined && options.deliverAs !== "followUp" && options.deliverAs !== "steer") return refuse("sendUserMessage: deliverAs is followUp or steer")
      // A turn.end handler that answers every turn with a message would run turns forever: the window stops it.
      const now = input.now()
      const recent = (sends.get(sessionId) ?? []).filter((at) => now - at < SEND_WINDOW_MS)
      if (recent.length >= SEND_LIMIT) { sends.set(sessionId, recent); return refuse(`sendUserMessage: at most ${SEND_LIMIT} messages per session per minute`) }
      recent.push(now)
      sends.set(sessionId, recent)
      const answer = await port!.submit(sessionId, text.slice(0, MAX_TEXT), options?.deliverAs === "steer" ? "steer" : "queue")
      if (!answer.ok) input.fail(answer.error)
      return answer
    },
  }
}
