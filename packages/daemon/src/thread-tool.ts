import { defineTool, fail, type ToolPermission, type ToolResult } from "@mendcode/tools"
import { z } from "zod"

const ACTIONS = ["list", "stats", "read", "search", "message", "wait", "interrupt", "merge_back", "start"] as const

/**
 * One tool for the project's other local sessions (`threads`, experimental.thread_tools; tier balanced).
 * `list` is a metadata read. `read`, `search` and `wait` open another session's history, so they ask for approval unless the user
 * named that session with `@thread`. `message` and `interrupt` change another session and always ask.
 * Other projects: `list scope=all` (or `directory`) names their sessions, `message` writes to one by its full id and `start` opens a
 * session in another folder. Those two ask the user every time, in every permission mode, and the receiver is never above the sender.
 */
export const threadsTool = defineTool({
  name: "threads",
  tier: "balanced",
  description: [
    "Work with this project's other local sessions. action=list shows them, newest first (id, state if busy, age, title; 10, limit up to 100; query, state, project narrow it; scope=all or directory=<folder>: other projects'); stats gives a session's figures, this one without sessionId (time per turn, day and hour, usage per model, tools, sub-agents, approval waits; no message text, no approval): use it for how long a session worked or what it spent; search finds text in it (follow `more: before=`);",
    "message queues a self-contained plain-text message (its answer returns as a notice); wait blocks up to timeoutSeconds until the session is idle and returns its last answer, without stopping it; interrupt cancels its running turn.",
    "merge_back brings what a fork of this session did since it branched into this session as context for its next message (a fork of this session only; no model call).",
    "list also names this project's chats in other programs (codex:…, claude:…, v1:…): read and search only, each asks the user.",
    "start opens a session in another project's folder (absolute directory) with text as its first message; message and wait take another project's id from list scope=all. Those always ask the user, arrive marked as an agent's, and never reach a session above this one's permission.",
    "Read, search, stats, interrupt, merge_back: this project only; use the id as printed. Reading another session needs approval unless the user attached it with @thread. Reasoning is never shown; secrets stay markers.",
  ].join(" "),
  permission: "write",
  args: z.object({
    action: z.enum(ACTIONS),
    sessionId: z.string().min(4).max(64).optional().describe("Id from list (not needed for list; stats without it is this session)"),
    text: z.string().min(1).max(8_000).optional().describe("message, start: text to send; search: text to find"),
    scope: z.enum(["project", "all"]).optional().describe("list: project (default) or all"),
    directory: z.string().min(1).max(1_024).optional().describe("start: the other project's absolute folder; list: only that folder"),
    title: z.string().min(1).max(120).optional().describe("start: its title"),
    limit: z.number().min(1).optional().describe("list: default 10, max 100; read, search: max 10"),
    query: z.string().min(1).optional().describe("list: title contains"),
    state: z.enum(["busy", "idle"]).optional().describe("list: only busy or idle"),
    project: z.string().min(1).optional().describe("list: folder contains"),
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
  // A message to another project's session, and a session opened there, ask in every mode, full access included: they reach folders and rules this session was not started in.
  approvalFor(args, context) {
    if (args.action === "start") return true
    return args.action === "message" && args.sessionId !== undefined && context?.threads?.projectOf?.(args.sessionId) !== undefined
  },
  refusalFor: (args, context) => (args.action === "message" && args.sessionId ? context?.threads?.refusal?.(args.sessionId) : undefined),
  async preview(args, context) {
    if (args.action === "start") return `${context.threads?.startPlan?.(args.directory ?? "") ?? `Open a new session in ${args.directory ?? "?"}`}\nFirst message, sent as from an agent, not from you:\n${args.text ?? ""}`
    if (args.action === "message") {
      const project = args.sessionId ? context.threads?.projectOf?.(args.sessionId) : undefined
      return `To ${args.sessionId ?? "?"}${project === undefined ? "" : ` in another project (${project})`}:\n${args.text ?? ""}`
    }
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
    const need = (field: "sessionId" | "text" | "directory") => fail({ title, message: `${args.action} needs ${field}` })
    if (args.action !== "list" && args.action !== "stats" && args.action !== "start" && !args.sessionId) return need("sessionId")
    if ((args.action === "message" || args.action === "search" || args.action === "start") && !args.text) return need("text")
    if (args.action === "start" && !args.directory) return need("directory")
    const sessionId = args.sessionId ?? ""
    const text = args.text ?? ""
    // Only a session of another project is addressed as such, which is exactly what `approvalFor` asked the user about.
    const elsewhere = sessionId && port.projectOf?.(sessionId) !== undefined ? { elsewhere: true } : {}
    const result = args.action === "list" ? port.list(args.limit, { scope: args.scope, directory: args.directory, query: args.query, state: args.state, project: args.project })
      : args.action === "start" ? await (port.start?.({ directory: args.directory!, text, title: args.title }) ?? Promise.resolve({ ok: false as const, message: "starting sessions is not available here" }))
      : args.action === "stats" ? port.stats({ sessionId: args.sessionId })
      : args.action === "read" ? await port.read({ sessionId, limit: args.limit, before: args.before })
      : args.action === "search" ? await port.search({ sessionId, query: text, limit: args.limit, before: args.before })
      : args.action === "message" ? await port.message({ sessionId, text, ...elsewhere })
      : args.action === "wait" ? await port.wait({ sessionId, timeoutSeconds: args.timeoutSeconds, signal: context.signal, ...elsewhere })
      : args.action === "merge_back" ? port.mergeBack({ sessionId })
      : await port.interrupt({ sessionId })
    if (!result.ok) return fail({ title, message: result.message })
    return { output: result.output, truncated: false, title, isError: false, meta: { action: args.action } }
  },
})
