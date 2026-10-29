import { SessionNotesInput, SessionRecallReadInput, SessionRecallSearchInput } from "@mendcode/protocol"
import { defineTool, fail, type Tool, type ToolContext } from "@mendcode/tools"

function result(name: string, context: ToolContext, run: (port: NonNullable<ToolContext["recall"]>) => unknown) {
  if (!context.recall) return fail({ title: name, message: "Session recall is not available here" })
  try { return { output: JSON.stringify(run(context.recall)), truncated: false, title: name === "session_notes" ? "Session notes" : name === "session_search" ? "Search session history" : "Read session history", isError: false } }
  catch (error) { return fail({ title: name, message: error instanceof Error ? error.message : String(error) }) }
}

export const SESSION_RECALL_TOOLS = [
  defineTool({
    name: "session_search",
    description: "Search one bounded page of historical messages, including before compaction. Follow next_cursor for older pages, even when this page has no matches. Only the current session or linked descendants in this project. Reasoning is never returned.",
    permission: "read",
    args: SessionRecallSearchInput,
    execute: async (input, context) => result("session_search", context, (port) => port.search(input)),
  }),
  defineTool({
    name: "session_read",
    description: "Read one bounded page of session history, including before compaction. Only the current session or linked descendants in this project. message_id reads one message in 16,000-character chunks; follow next_offset. Each message has `at`, when it was sent (local time with offset). Reasoning is never returned.",
    permission: "read",
    args: SessionRecallReadInput,
    execute: async (input, context) => result("session_read", context, (port) => port.read(input)),
  }),
  defineTool({
    name: "session_notes",
    description: "Read or replace this session's working notes across compaction. Read first; write requires the current version to prevent lost updates. At most 16,000 characters. Read a specific version to recover earlier notes. Never writes global memory or accesses the user's private project scratchpad.",
    permission: "write",
    args: SessionNotesInput,
    execute: async (input, context) => result("session_notes", context, (port) => port.notes(input)),
  }),
]

export const SESSION_RECALL_TOOL_NAMES = new Set(SESSION_RECALL_TOOLS.map((tool) => tool.name))

export function sessionRecallPermission(tool: Tool, args: unknown): Tool {
  if (tool !== SESSION_RECALL_TOOLS[2]) return tool
  const input = SessionNotesInput.safeParse(args)
  return input.success && input.data.action === "read" ? { ...tool, permission: "read" } : tool
}
