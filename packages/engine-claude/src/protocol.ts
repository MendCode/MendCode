import { EARLY_TOOL_CHARS, INPUT_PROGRESS_CHARS, partialToolArgs, toolInputProgress as inputProgress, type ItemId, type PermissionMode, type ReasoningEffort } from "@mendcode/protocol"
import type { EngineEvent, GlobalEventDraft } from "@mendcode/kernel"

/**
 * The Claude Code CLI's stream-json protocol, as the official Agent SDK speaks it (captured live from 2.1.285):
 * JSONL on stdin/stdout, `control_request`/`control_response` for initialize, tool permission, interrupt, mode and
 * model changes, and `stream_event` wrapping the Messages API stream. Everything here is pure.
 */

export const MAX_TEXT = 60 * 1024
const WEEK_MINUTES = 7 * 24 * 60

export type QuotaDraft = Extract<GlobalEventDraft, { type: "quota.snapshot" }>
export type ClaudeMessage = Record<string, any>

/** Claude Code's own permission modes; `bypassPermissions` also needs `--allow-dangerously-skip-permissions`. */
export type ClaudePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan"

const PERMISSION: Record<PermissionMode, ClaudePermissionMode> = { ask: "default", edits: "acceptEdits", full: "bypassPermissions", plan: "plan", smart: "default" }

export function claudePermissionMode(mode: PermissionMode): ClaudePermissionMode {
  return PERMISSION[mode]
}

/** Claude Code takes low…max; MendCode's `minimal` maps to its lowest level. */
export function claudeEffort(effort: ReasoningEffort | undefined): string | undefined {
  if (!effort) return undefined
  return effort === "minimal" ? "low" : effort
}

export function clip(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text
}

/**
 * Arguments for one long-lived Claude Code process that serves one MendCode session. Claude Code omits the text of the
 * model's thinking unless asked, so `--thinking-display summarized` is what makes `thinking_delta` carry words; `thinkingDisplay: false`
 * leaves the flag out for a `claude` that does not know it.
 */
export function claudeArgs(input: { model?: string | undefined; effort?: ReasoningEffort | undefined; fast?: boolean | undefined; permission: PermissionMode; resume?: string | undefined; thinkingDisplay?: boolean | undefined; appendSystem?: string | undefined }): string[] {
  const permission = claudePermissionMode(input.permission)
  const effort = claudeEffort(input.effort)
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    permission,
    // Only makes `bypassPermissions` reachable, so switching to full mid-session needs no restart; the mode decides.
    "--allow-dangerously-skip-permissions",
    ...(input.model ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
    // Fast mode is a setting Claude Code reads at start; passed this way it holds for this process only and is never saved.
    ...(input.fast ? ["--settings", JSON.stringify({ fastMode: true })] : []),
    ...(input.thinkingDisplay === false ? [] : ["--thinking-display", "summarized"]),
    // Added after Claude Code's own system prompt, which stays whole.
    ...(input.appendSystem ? ["--append-system-prompt", input.appendSystem] : []),
    ...(input.resume ? [`--resume=${input.resume}`] : []),
  ]
}

export function controlRequest(requestId: string, request: Record<string, unknown>) {
  return JSON.stringify({ type: "control_request", request_id: requestId, request })
}

export function controlResponse(requestId: string, response: Record<string, unknown>) {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })
}

export function userMessage(content: Array<Record<string, unknown>>, uuid?: string) {
  return JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", ...(uuid ? { uuid } : {}) })
}

const WINDOW_LABEL: Record<string, { label: string; minutes: number }> = { five_hour: { label: "5h", minutes: 300 }, seven_day: { label: "7d", minutes: WEEK_MINUTES } }

/**
 * A `rate_limit_event` as a quota snapshot. `unifiedWindows` carries every window as a 0–1 utilization with an
 * epoch-seconds reset; without it only the named window (`rateLimitType`) is known.
 */
export function claudeQuota(info: any, fetchedAt: number): QuotaDraft | undefined {
  if (!info || typeof info !== "object") return undefined
  const raw: Record<string, { utilization?: number; resetsAt?: number }> =
    info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : typeof info.rateLimitType === "string" ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {}
  const windows = Object.entries(raw)
    .filter(([, window]) => window && typeof window.utilization === "number")
    .slice(0, 8)
    .map(([id, window]) => {
      const known = WINDOW_LABEL[id]
      return {
        id: id.slice(0, 64),
        label: (known?.label ?? id.replace(/_/g, " ")).slice(0, 32),
        usedPercent: Math.min(100, Math.max(0, Math.round(window.utilization! * 1000) / 10)),
        ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt * 1000 } : {}),
        ...(known ? { windowMinutes: known.minutes } : id.startsWith("seven_day") ? { windowMinutes: WEEK_MINUTES } : {}),
      }
    })
  if (windows.length === 0) return undefined
  const status = info.status === "rejected" ? "rejected" : info.status === "allowed_warning" ? "warning" : "allowed"
  return { type: "quota.snapshot", provider: "claude", windows, status, fetchedAt, source: "claude code rate_limit_event" }
}

function shortPath(value: unknown) {
  return typeof value === "string" ? value : ""
}

/** A one-line title for a Claude Code tool call, from its complete input. */
export function claudeToolTitle(name: string, input: Record<string, any> | undefined): string {
  const args = input ?? {}
  // MendCode's own tool names and `name: detail` shape, so the terminal draws each card as it draws its own (an edit's diff, a
  // command's output, a read's lines) instead of as an unknown tool.
  const titled = (tool: string, detail: unknown) => {
    const text = String(detail ?? "").split("\n")[0]!.trim()
    return text ? `${tool}: ${text}` : tool
  }
  switch (name) {
    case "Bash":
      return titled("shell", args.command)
    case "Read":
      return titled("read", shortPath(args.file_path))
    case "Write":
      return titled("write", shortPath(args.file_path))
    case "Edit":
    case "MultiEdit":
      return titled("edit", shortPath(args.file_path))
    case "NotebookEdit":
      return titled("notebook_edit", shortPath(args.notebook_path))
    case "Glob":
      return titled("glob", args.pattern)
    case "Grep":
      return titled("grep", args.pattern)
    case "WebFetch":
      return titled("webfetch", args.url)
    case "WebSearch":
      return titled("web_search", args.query)
    case "Skill":
      return titled("skill", args.skill)
    case "Task":
    case "Agent":
      return `agent ${String(args.description ?? args.subagent_type ?? "")}`.trim()
    default:
      return name
  }
}

/** Which MendCode permission class a Claude Code tool belongs to, for the approval card. */
export function claudeToolPermission(name: string): "read" | "write" | "execute" {
  if (name === "Write" || name === "Edit" || name === "NotebookEdit" || name === "MultiEdit") return "write"
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "WebSearch" || name === "WebFetch" || name === "TodoWrite") return "read"
  return "execute"
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n")
}

type OpenBlock = { kind: "text" | "reasoning" | "tool"; itemId?: ItemId; text: string; toolUseId?: string; name?: string; json: string; /** Wordless thinking deltas seen (`SILENT_THINKING_EVERY`). */ silent?: number; /** Input characters when the card last heard how much is written. */ told?: number }

/** One empty delta per this many wordless thinking deltas: enough for a client to see the model is alive, few enough to store. */
const SILENT_THINKING_EVERY = 20
/** Agent calls wait for their whole input: their card needs the agent's name and whether it runs in the background. */
const WHOLE_INPUT_TOOLS = new Set(["Agent", "Task"])

/**
 * The unified diff of a Claude Code Edit or MultiEdit (`tool_use_result.structuredPatch`: hunks with their start lines and ` `/`-`/`+`
 * lines), the text MendCode's own edit tool returns, so the card draws it the same way. A Write's result (it has a `type`) and a
 * result with no hunks give nothing.
 */
export function claudeEditPatch(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || "type" in result) return undefined
  const hunks = (result as { structuredPatch?: unknown }).structuredPatch
  if (!Array.isArray(hunks) || !hunks.length) return undefined
  const rows: string[] = []
  for (const hunk of hunks) {
    if (!hunk || typeof hunk !== "object" || !Array.isArray(hunk.lines)) return undefined
    const { oldStart, oldLines, newStart, newLines } = hunk as Record<string, unknown>
    if (![oldStart, oldLines, newStart, newLines].every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) return undefined
    rows.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...hunk.lines.map((line: unknown) => String(line)))
  }
  return rows.join("\n")
}

/**
 * Turns the messages of one turn into engine events. Text and thinking stream as items (a thinking item opens with its
 * block, a text item with its first text); a tool call appears once
 * its input is complete (so its title is right) and completes with its `tool_result`.
 *
 * A sub-agent (Claude Code's Agent tool) is a thread of its own: its call is a tool item marked `subagent` (with the agent's type
 * and whether it runs in the background), and what it does are items marked `agentParent` with that call's item id, in the order
 * Claude Code reports them: the prompt it was given (a user message), each tool it calls, and its report when it ends (an agent
 * message marked `agentEnd`, with its tool count, tokens and duration). Clients show the thread under the call and leave it out
 * of the main conversation. A sub-agent that ends after its turn did (a background one) is not reported.
 */
export function createTurnMapper(input: { newItemId(): ItemId; emit(event: EngineEvent): void; model: string; /** Tools the daemon runs and draws itself: no item here. */ ownTools?: string | undefined; /** Every tool call of the main agent, with its arguments. */ onTool?(name: string, args: Record<string, any> | undefined): void }) {
  const own = (name: unknown) => !!input.ownTools && String(name).startsWith(input.ownTools)
  const blocks = new Map<number, OpenBlock>()
  const tools = new Map<string, ItemId>()
  /** Agent calls of this turn by their tool-use id, kept past their result: a background agent goes on after it. */
  const agents = new Map<string, ItemId>()
  /** Agent calls drawn before their input was whole: the agent and background flag the input ended with, sent again when the call completes. */
  const lateAgentMeta = new Map<ItemId, { subagent: true; agent: string; background: boolean; tool: string }>()
  /** Background agents of this turn still running, by tool-use id: they report after the turn ends. */
  const backgroundAgents = new Set<string>()
  /** Tools a sub-agent called, by tool-use id. */
  const agentTools = new Map<string, ItemId>()
  /** The last text each sub-agent wrote, by its call's item: the report it ends with repeats it, and is then not drawn twice. */
  const agentLastText = new Map<ItemId, string>()
  let model = input.model
  /** The latest main-thread model call: Claude Code's `result` sums every call and sub-agent, so only this one says how full the context is. */
  let lastCall: { id: string; prompt: number; output: number } | undefined

  /**
   * Every model call of the turn, the main thread's and its sub-agents', by message id: what a turn spent when it ends without
   * Claude Code's `result` (cancelled, the process gone, the stream idle). A 9.8-hour turn that was cancelled recorded no usage at all.
   */
  const spent = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; model: string | undefined }>()
  /** Whether the `result` message reported the turn's usage (then the per-call sums are not sent). */
  let reported = false
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)

  /** A call's figures arrive more than once (start, delta, whole message): each field keeps its largest value, never a sum. */
  function noteSpend(id: unknown, usage: any, callModel?: unknown) {
    if (typeof id !== "string" || !id || !usage || typeof usage !== "object") return
    const was = spent.get(id)
    spent.set(id, {
      input: Math.max(was?.input ?? 0, count(usage.input_tokens)),
      output: Math.max(was?.output ?? 0, count(usage.output_tokens)),
      cacheRead: Math.max(was?.cacheRead ?? 0, count(usage.cache_read_input_tokens)),
      cacheWrite: Math.max(was?.cacheWrite ?? 0, count(usage.cache_creation_input_tokens)),
      model: typeof callModel === "string" ? callModel : was?.model,
    })
  }

  /** One call's usage arrives up to three times (`message_start`, `message_delta`, the whole `assistant` message), each repeating the same call: the figures are set, never added. */
  function noteCall(id: unknown, usage: any, callModel?: unknown) {
    noteSpend(id, usage, callModel)
    if (!usage || typeof usage !== "object") return
    const prompt = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens)
    const output = count(usage.output_tokens)
    const callId = typeof id === "string" ? id : ""
    lastCall = lastCall && callId && lastCall.id === callId ? { id: callId, prompt: Math.max(lastCall.prompt, prompt), output: Math.max(lastCall.output, output) } : { id: callId, prompt, output }
  }

  function start(kind: "text" | "reasoning") {
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: kind === "text" ? "agent_message" : "reasoning" })
    return itemId
  }

  function onStreamEvent(event: any) {
    const index = typeof event?.index === "number" ? event.index : -1
    if (event?.type === "message_start") {
      blocks.clear()
      if (typeof event.message?.model === "string") model = event.message.model
      noteCall(event.message?.id, event.message?.usage, event.message?.model)
      return
    }
    if (event?.type === "message_delta") {
      if (lastCall) noteCall(lastCall.id, { output_tokens: event.usage?.output_tokens })
      return
    }
    if (event?.type === "content_block_start") {
      const block = event.content_block ?? {}
      if (block.type === "text") blocks.set(index, { kind: "text", text: "", json: "" })
      // Claude Code may stream a thinking block without its text (`thinking_delta` with "" and `estimated_tokens`): the item
      // starts with the block, as pi and Codex do, so clients know the model is thinking; one that ends empty draws no card.
      else if (block.type === "thinking") blocks.set(index, { kind: "reasoning", itemId: start("reasoning"), text: "", json: "" })
      else if (block.type === "tool_use" || block.type === "server_tool_use") blocks.set(index, { kind: "tool", text: "", json: "", toolUseId: String(block.id ?? ""), name: String(block.name ?? "tool") })
      return
    }
    const open = blocks.get(index)
    if (!open) return
    if (event.type === "content_block_delta") {
      const delta = event.delta ?? {}
      const text = open.kind === "text" && delta.type === "text_delta" ? delta.text : open.kind === "reasoning" && delta.type === "thinking_delta" ? delta.thinking : undefined
      if (typeof text === "string" && text) {
        open.itemId ??= start(open.kind as "text" | "reasoning")
        open.text += text
        input.emit({ type: "item.delta", itemId: open.itemId, text: text.slice(0, MAX_TEXT) })
      } else if (open.kind === "reasoning" && open.itemId && delta.type === "thinking_delta" && (open.silent = (open.silent ?? 0) + 1) % SILENT_THINKING_EVERY === 0) {
        // Thinking that carries no words (`estimated_tokens` only) is still the model at work: an empty delta now and then says so.
        input.emit({ type: "item.delta", itemId: open.itemId, text: "" })
      } else if (open.kind === "tool" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        open.json += delta.partial_json
        // Nothing else is sent while the model writes a long input (an agent's prompt is often the longest), and a client would call that
        // silence a stall. An agent call starts with what its input says so far; the rest of its card comes when the call completes.
        if (!open.itemId && open.json.length >= EARLY_TOOL_CHARS && !own(open.name)) {
          open.itemId = input.newItemId()
          if (open.toolUseId) tools.set(open.toolUseId, open.itemId)
          const partial = partialToolArgs(open.json)
          const agentCall = WHOLE_INPUT_TOOLS.has(open.name ?? "")
          input.emit({ type: "item.started", itemId: open.itemId, kind: "tool_call", meta: { tool: claudeToolTitle(open.name ?? "tool", partial).slice(0, 200), ...(agentCall ? { subagent: true, ...(partial.subagent_type ? { agent: partial.subagent_type.slice(0, 60) } : {}), background: /"run_in_background"\s*:\s*true/.test(open.json) } : {}) } })
        }
        // The card says how much the model has written, so a long write reads as writing and not as a tool that hangs.
        if (open.itemId && (open.told === undefined || open.json.length - open.told >= INPUT_PROGRESS_CHARS)) {
          open.told = open.json.length
          input.emit({ type: "item.delta", itemId: open.itemId, text: "", input: inputProgress(open.json) })
        }
      }
      return
    }
    if (event.type === "content_block_stop") {
      blocks.delete(index)
      if (open.kind === "tool" && own(open.name)) return
      if (open.kind === "tool") {
        let args: Record<string, any> | undefined
        try {
          args = open.json ? JSON.parse(open.json) : {}
        } catch {
          args = undefined
        }
        input.onTool?.(open.name ?? "tool", args)
        if (open.itemId) input.emit({ type: "item.delta", itemId: open.itemId, text: "", input: { ...inputProgress(open.json), done: true } })
        const itemId = open.itemId ?? input.newItemId()
        if (open.toolUseId) tools.set(open.toolUseId, itemId)
        const agent = open.name === "Agent" || open.name === "Task"
        if (agent && open.toolUseId) agents.set(open.toolUseId, itemId)
        if (agent && open.toolUseId && args?.run_in_background === true) backgroundAgents.add(open.toolUseId)
        // An agent call started early may have had only part of its input (a long prompt before the description): its whole title comes with its end.
        if (agent && open.itemId) lateAgentMeta.set(itemId, { subagent: true, agent: String(args?.subagent_type ?? "general-purpose").slice(0, 60), background: args?.run_in_background === true, tool: claudeToolTitle(open.name ?? "tool", args).slice(0, 200) })
        if (!open.itemId) input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: claudeToolTitle(open.name ?? "tool", args).slice(0, 200), ...(agent ? { subagent: true, agent: String(args?.subagent_type ?? "general-purpose").slice(0, 60), background: args?.run_in_background === true } : {}) } })
        return
      }
      if (open.itemId) input.emit({ type: "item.completed", itemId: open.itemId, status: "ok", text: clip(open.text) })
    }
  }

  function onToolResults(content: unknown, toolUseResult?: unknown) {
    if (!Array.isArray(content)) return
    // An edit's result says only that the file was updated; the diff it made comes beside it, for the one result of its message.
    const patch = content.filter((part) => part?.type === "tool_result").length === 1 ? claudeEditPatch(toolUseResult) : undefined
    for (const part of content) {
      if (part?.type !== "tool_result") continue
      const itemId = tools.get(String(part.tool_use_id))
      if (!itemId) continue
      tools.delete(String(part.tool_use_id))
      const late = lateAgentMeta.get(itemId)
      lateAgentMeta.delete(itemId)
      // A background agent's result is Claude Code's note to its model (ids and how to message it), not something to show.
      const text = !part.is_error && backgroundAgents.has(String(part.tool_use_id)) ? "running in the background" : !part.is_error && patch ? patch : toolResultText(part.content)
      input.emit({ type: "item.completed", itemId, status: part.is_error ? "error" : "ok", text: clip(text), ...(late ? { meta: late } : {}) })
    }
  }

  /**
   * What a sub-agent sends: its thinking, its text, the tools it calls and their results, each as an item of its thread, so the
   * thread opened in the chat moves as the agent works. Claude Code sends a sub-agent's messages whole, not streamed. Its model
   * rides on each item (`agentModel`) for the thread's header.
   */
  function onAgentMessage(message: ClaudeMessage, parent: ItemId) {
    if (message.type === "assistant") noteSpend(message.message?.id, message.message?.usage, message.message?.model)
    const content = message.message?.content
    if (!Array.isArray(content)) return
    const agentModel = typeof message.message?.model === "string" ? { agentModel: message.message.model.slice(0, 120) } : {}
    const said = (kind: "agent_message" | "reasoning", text: string) => {
      const itemId = input.newItemId()
      input.emit({ type: "item.started", itemId, kind, meta: { agentParent: parent, ...agentModel } })
      input.emit({ type: "item.completed", itemId, status: "ok", text: clip(text), meta: { agentParent: parent } })
    }
    for (const part of content) {
      if (message.type === "assistant" && part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) said("reasoning", part.thinking)
      else if (message.type === "assistant" && part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        said("agent_message", part.text)
        agentLastText.set(parent, part.text.trim())
      } else if (message.type === "assistant" && part?.type === "tool_use" && typeof part.id === "string" && !agentTools.has(part.id) && !own(part.name)) {
        const itemId = input.newItemId()
        agentTools.set(part.id, itemId)
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: claudeToolTitle(String(part.name ?? "tool"), part.input && typeof part.input === "object" ? part.input : undefined).slice(0, 200), agentParent: parent, ...agentModel } })
      } else if (message.type === "user" && part?.type === "tool_result") {
        const itemId = agentTools.get(String(part.tool_use_id))
        if (!itemId) continue
        agentTools.delete(String(part.tool_use_id))
        input.emit({ type: "item.completed", itemId, status: part.is_error ? "error" : "ok", text: clip(toolResultText(part.content)), meta: { agentParent: parent } })
      }
    }
  }

  /** Claude Code's notices about a sub-agent: it started (with the prompt it was given) and it ended (with its report and totals). */
  function onTaskNotice(message: ClaudeMessage) {
    const parent = agents.get(String(message.tool_use_id))
    if (!parent) return
    if (message.subtype === "task_started" && typeof message.prompt === "string") {
      const itemId = input.newItemId()
      input.emit({ type: "item.started", itemId, kind: "user_message", meta: { agentParent: parent } })
      input.emit({ type: "item.completed", itemId, status: "ok", text: clip(message.prompt), meta: { agentParent: parent } })
    } else if (message.subtype === "task_notification") {
      backgroundAgents.delete(String(message.tool_use_id))
      const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
      const failed = message.status !== "completed"
      const itemId = input.newItemId()
      const meta = { agentParent: parent, agentEnd: true, toolCalls: count(message.usage?.tool_uses), tokens: count(message.usage?.total_tokens), durationMs: count(message.usage?.duration_ms) }
      const summary = typeof message.summary === "string" ? message.summary : ""
      // The report is usually the agent's last text, already in its thread: the end then carries the totals only.
      const repeated = summary.trim() !== "" && summary.trim() === agentLastText.get(parent)
      agentLastText.delete(parent)
      input.emit({ type: "item.started", itemId, kind: "agent_message", meta: { agentParent: parent } })
      input.emit({ type: "item.completed", itemId, status: failed ? "error" : "ok", text: repeated ? "" : clip(summary), meta })
    }
  }

  /**
   * Usage of the whole turn from the `result` message (sums over every call and sub-agent, so the counts are true
   * totals; the subscription has no per-token charge, so no cost). `context` is not one of those sums: it is the last
   * main-thread call's prompt plus its answer, clamped to the window Claude Code reports and marked when it had to be.
   */
  function usage(result: ClaudeMessage): EngineEvent | undefined {
    const raw = result.usage
    if (!raw || typeof raw !== "object") return undefined
    const modelName = Object.keys(result.modelUsage ?? {})[0] ?? model
    const reported = result.modelUsage?.[modelName]?.contextWindow
    const contextWindow = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : undefined
    const measured = lastCall ? lastCall.prompt + lastCall.output : undefined
    const clamped = measured !== undefined && contextWindow !== undefined && measured > contextWindow
    return {
      type: "usage",
      provider: "claude",
      model: modelName,
      input: Number(raw.input_tokens ?? 0),
      output: Number(raw.output_tokens ?? 0),
      reasoning: Number(raw.output_tokens_details?.thinking_tokens ?? 0),
      cacheRead: Number(raw.cache_read_input_tokens ?? 0),
      cacheWrite: Number(raw.cache_creation_input_tokens ?? 0),
      ...(measured !== undefined ? { context: clamped ? contextWindow! : Math.round(measured) } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(clamped ? { contextApprox: true as const } : {}),
    }
  }

  /** What the turn's calls reported, summed, for a turn that ends without `result`; `partial` marks it as counted from the calls. */
  function spentUsage(): EngineEvent | undefined {
    if (reported || !spent.size) return undefined
    const calls = [...spent.values()]
    const total = (field: "input" | "output" | "cacheRead" | "cacheWrite") => calls.reduce((sum, call) => sum + call[field], 0)
    return { type: "usage", provider: "claude", model: model ?? calls.find((call) => call.model)?.model ?? "claude", input: total("input"), output: total("output"), reasoning: 0, cacheRead: total("cacheRead"), cacheWrite: total("cacheWrite"), partial: true }
  }

  /** Closes what the turn left open: tool calls without a result end interrupted (or error), streamed text ends ok. */
  function finish(status: "ok" | "interrupted" | "error") {
    for (const open of blocks.values()) if (open.itemId) input.emit({ type: "item.completed", itemId: open.itemId, status: status === "ok" ? "ok" : "interrupted", text: clip(open.text) })
    blocks.clear()
    for (const itemId of tools.values()) input.emit({ type: "item.completed", itemId, status: status === "error" ? "error" : "interrupted" })
    tools.clear()
    for (const itemId of agentTools.values()) input.emit({ type: "item.completed", itemId, status: status === "error" ? "error" : "interrupted" })
    agentTools.clear()
    const partial = spentUsage()
    if (partial) { reported = true; input.emit(partial) }
  }

  return {
    /** True while an agent this turn started in the background still runs. */
    hasBackgroundAgents: () => backgroundAgents.size > 0,
    /** True for a record of one of this turn's agents: something it did, or Claude Code's notice that it started or ended. */
    owns(message: ClaudeMessage): boolean {
      if (message.parent_tool_use_id) return agents.has(String(message.parent_tool_use_id))
      return message.type === "system" && (message.subtype === "task_started" || message.subtype === "task_notification") && agents.has(String(message.tool_use_id))
    },
    /** Feeds one message; returns the `result` message when the turn ended. */
    accept(message: ClaudeMessage): ClaudeMessage | undefined {
      if (message.type === "system" && (message.subtype === "task_started" || message.subtype === "task_notification")) return void onTaskNotice(message)
      if (message.parent_tool_use_id) {
        const parent = agents.get(String(message.parent_tool_use_id))
        if (parent) onAgentMessage(message, parent)
        return undefined
      }
      if (message.type === "stream_event") onStreamEvent(message.event)
      else if (message.type === "assistant") noteCall(message.message?.id, message.message?.usage, message.message?.model)
      else if (message.type === "user") onToolResults(message.message?.content, message.tool_use_result)
      else if (message.type === "result") {
        const event = usage(message)
        if (event) { reported = true; input.emit(event) }
        return message
      }
      return undefined
    },
    finish,
  }
}

/** The turn's outcome from its `result` message: an interrupt is not an error. */
export function resultOutcome(result: ClaudeMessage): { status: "ok" } | { status: "error"; code: string; message: string } {
  if (result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools") return { status: "ok" }
  if (result.subtype === "success" && !result.is_error) return { status: "ok" }
  const errors = Array.isArray(result.errors) ? result.errors.filter((error: unknown) => typeof error === "string" && error).join("\n") : ""
  const message = errors || (typeof result.result === "string" && result.result) || String(result.subtype ?? "error")
  return { status: "error", code: "claude_turn_failed", message: `[CLAUDE]: ${message.slice(0, 2000)}` }
}

/**
 * A tool call that changes which MCP servers Claude Code has: `claude mcp add|remove…` in a command, or a write to an MCP
 * configuration file. Claude Code reads its servers when its process starts, so the process is started again after such a turn.
 */
export function changesMcpServers(name: string, args: Record<string, any> | undefined) {
  if (!args) return false
  if (name === "Bash") return /\bclaude\s+mcp\s+(add|add-json|add-from-claude-desktop|remove|reset-project-choices)\b/.test(String(args.command ?? ""))
  if (name === "Write" || name === "Edit" || name === "MultiEdit") return /(^|\/)(\.mcp\.json|\.claude\.json)$/.test(String(args.file_path ?? ""))
  return false
}

/** Said after Claude Code's own prompt, so the model does not tell the user to open a new session after adding a server. */
export const MCP_RELOAD_NOTE = "MCP servers: after you add, change or remove one (`claude mcp add`, `.mcp.json`), this app restarts Claude Code when the turn ends and keeps the conversation. The server's tools are there on the user's next message; say so instead of asking for a new session."
