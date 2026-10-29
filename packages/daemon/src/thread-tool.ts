import { defineTool, fail, type ToolPermission, type ToolResult } from "@mendcode/tools"
import { z } from "zod"

const ACTIONS = ["list", "stats", "read", "search", "message", "wait", "interrupt", "merge_back"] as const

/**
 * One tool for the project's other local sessions (`threads`, experimental.thread_tools; tier balanced).
 * `list` is a metadata read. `read`, `search` and `wait` open another session's history, so they ask for approval unless the user
 * named that session with `@thread`. `message` and `interrupt` change another session and always ask.
 */
export const threadsTool = defineTool({
  name: "threads",
  tier: "balanced",
  description: [
    "Work with this project's other local sessions. action=list shows them (id, title, state); stats gives a session's figures, this one without sessionId (time per turn, day and hour, usage per model, tools, sub-agents, approval waits; no message text, no approval): use it for how long a session worked or what it spent; search finds text in it (follow `more: before=` for older pages);",
    "message queues a self-contained plain-text message (its answer returns as a notice); wait blocks up to timeoutSeconds until the session is idle and returns its last answer, without stopping it; interrupt cancels its running turn.",
    "merge_back brings what a fork of this session did since it branched into this session as context for its next message (a fork of this session only; no model call).",
    "list also names this project's chats in other programs (ids codex:…, claude:…, v1:… for Codex, Claude Code and the previous MendCode): read and search work on them, nothing else, and each one asks the user.",
    "Same project only. Use an exact id from list. Reading another session needs approval unless the user attached it with @thread. Reasoning is never shown and secrets stay as markers.",
  ].join(" "),
  permission: "write",
  args: z.object({
    action: z.enum(ACTIONS),
    sessionId: z.string().min(4).max(64).optional().describe("Exact id from list (not needed for list; stats without it is this session)"),
    text: z.string().min(1).max(8_000).optional().describe("message: the text to send; search: the text to find"),
    limit: z.number().int().min(1).max(10).optional().describe("read, search, list: how many to return"),
    before: z.string().max(100).optional().describe("read, search: the `before=` cursor of the previous page"),
    timeoutSeconds: z.number().int().min(1).max(120).optional().describe("wait: seconds to wait, default 60"),
  }),
  permissionFor(args, context): ToolPermission {
    if (args.action === "list" || args.action === "stats") return "read"
    if (args.action === "read" || args.action === "search" || args.action === "wait") return "read"
    return "write"
  },
  individualApprovalFor(args, context) {
    if (["read", "search", "wait"].includes(args.action) && args.sessionId && context?.threads?.ownTask?.(args.sessionId)) return false
    return ["read", "search", "wait", "merge_back"].includes(args.action) && !(args.sessionId && context?.threads?.granted(args.sessionId))
  },
  async preview(args) {
    if (args.action === "message") return `To ${args.sessionId ?? "?"}:\n${args.text ?? ""}`
    if (args.action === "interrupt") return `Cancel the running turn of ${args.sessionId ?? "?"}`
    if (args.action === "merge_back") return `Read the turns of the fork ${args.sessionId ?? "?"} and bring them into this session as context`
    const other = /^(codex|claude|v1):/.exec(args.sessionId ?? "")?.[1]
    if (other && (args.action === "read" || args.action === "search")) return `Read a chat of this project kept by ${other === "codex" ? "Codex" : other === "claude" ? "Claude Code" : "the previous MendCode"} (${args.sessionId})${args.action === "search" ? ` for ${JSON.stringify(args.text ?? "")}` : ""}`
    if (args.action === "read" || args.action === "search") return `Read the history of ${args.sessionId ?? "?"}${args.action === "search" ? ` for ${JSON.stringify(args.text ?? "")}` : ""}`
    if (args.action === "wait") return `Wait for ${args.sessionId ?? "?"} and read its last answer`
    return undefined
  },
  async execute(args, context): Promise<ToolResult> {
    const port = context.threads
    if (!port) return fail({ title: "threads", message: "threads are not available here" })
    const title = `threads ${args.action}${args.sessionId ? ` ${args.sessionId}` : ""}`
    const need = (field: "sessionId" | "text") => fail({ title, message: `${args.action} needs ${field}` })
    if (args.action !== "list" && args.action !== "stats" && !args.sessionId) return need("sessionId")
    if ((args.action === "message" || args.action === "search") && !args.text) return need("text")
    const sessionId = args.sessionId ?? ""
    const text = args.text ?? ""
    const result = args.action === "list" ? port.list(args.limit)
      : args.action === "stats" ? port.stats({ sessionId: args.sessionId })
      : args.action === "read" ? await port.read({ sessionId, limit: args.limit, before: args.before })
      : args.action === "search" ? await port.search({ sessionId, query: text, limit: args.limit, before: args.before })
      : args.action === "message" ? await port.message({ sessionId, text })
      : args.action === "wait" ? await port.wait({ sessionId, timeoutSeconds: args.timeoutSeconds, signal: context.signal })
      : args.action === "merge_back" ? port.mergeBack({ sessionId })
      : await port.interrupt({ sessionId })
    if (!result.ok) return fail({ title, message: result.message })
    return { output: result.output, truncated: false, title, isError: false, meta: { action: args.action } }
  },
})
