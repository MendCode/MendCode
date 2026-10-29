import { TOOL_SEARCH_NAME } from "./tool-discovery"

/**
 * What another harness (Claude Code) already does itself: files, shell, search, questions, plans, sub-agents, skills and its own
 * tool search. These stay its own, so the model has one way to do each; every other native tool is offered to it. MendCode's
 * `webfetch` and `websearch` are offered too: the other harness refuses some sites (Claude Code will not fetch reddit.com) or
 * has no search, and MendCode's run from this machine with the user's own search key or ChatGPT login.
 */
const HARNESS_OWN = new Set([
  "read", "write", "edit", "apply_patch", "notebook_edit", "glob", "grep", "ls",
  "shell", "shell_output", "shell_kill", "shell_monitor", "shell_session", "sleep",
  "task", "task_status", "web_search", "question", "todo", "skill",
  "plan_submit", "plan_review", "plan_exit", "snip", "reasoning_auto", "structured_output", TOOL_SEARCH_NAME,
])

/** MendCode's own MCP servers are not passed on: the other harness has its own MCP configuration, and a server in both would list twice. */
export const hostable = (name: string) => !HARNESS_OWN.has(name) && !name.startsWith("mcp__") && !name.startsWith("mcp_resource_")
