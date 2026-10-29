import { defineTool, type Tool } from "@mendcode/tools"
import { z } from "zod"
import type { ModelMessage, ToolSpec } from "./provider"

export const TOOL_SEARCH_NAME = "tool_search"
export const TOOL_SEARCH_WIRE_NAME = "mendcode_tool_search"
export const MAX_DISCOVERED_TOOLS = 64
export const MAX_SEARCH_BYTES = 24 * 1024

/**
 * The code graph's lookups a coding turn reaches for instead of `grep` and `read`: where a symbol is, who calls it, what a file declares.
 * They are in the catalogue only with the feature `codegraph`, and are then always listed: a model that cannot see them greps and reads
 * whole files, which costs far more than their three short schemas. The map, the impact note and `code_search` stay behind `tool_search`.
 */
const GRAPH_CORE = ["graph_find", "graph_callers", "graph_file_api"] as const

/** v1 primary capabilities, using the native engine's names. MCP, custom and extension tools are secondary. */
const PRIMARY_TOOLS = new Set([
  "shell", "read", "glob", "grep", "ls", "edit", "write", "apply_patch", "task", "task_status",
  "shell_output", "shell_kill", "shell_session", "shell_monitor", "sleep", "notebook_edit", "webfetch", "websearch", "browser", "todo", "skill", "loop", "workflow_start",
  "workflow_status", "review", "sessions", "tell", "memory", "remember", "memory_graph", "image_gen",
  "question", "plan_submit", "plan_review", "plan_exit", "lsp", "diagnostics", "secrets",
  "get_goal", "create_goal", "update_goal", "code", "tool_start", "tool_status", "tool_wait", "tool_cancel",
  "question_async", "session_search", "session_read", "snip", "worktree", "customize_ui", ...GRAPH_CORE, TOOL_SEARCH_NAME,
])

export const isPrimaryTool = (name: string) => PRIMARY_TOOLS.has(name)

/**
 * The lean coding core (feature `lean_tools`, docs/tool-discovery.md): what a coding turn uses, and nothing it pays for on every
 * call without using. Everything else, heavy or rare (workflows, loops, worktrees, memory, sessions, notebooks, LSP, MCP...), is one
 * `tool_search` away and joins the request at its end once discovered. `ls` is not in it: `read` lists a directory too.
 */
const LEAN_CORE = new Set([
  "shell", "read", "glob", "grep", "edit", "write", "apply_patch", "shell_output", "shell_kill", "task", "task_status", "skill", "webfetch", "question",
  "plan_submit", "plan_review", "plan_exit", "code", "snip", "customize_ui", ...GRAPH_CORE, TOOL_SEARCH_NAME,
])

/** File search by name and by content (feature `find_tools`, every tier): without them minimalist's first request fell under the provider's cacheable minimum. */
export const FIND_TOOLS: ReadonlySet<string> = new Set(["glob", "grep"])
/** The user's own screen settings (feature `ui_tool`): listed, a model asked to hide a bar used it 20 times of 20; deferred, 14 of 20. */
export const UI_TOOL = "customize_ui"
/**
 * The tool list up to and including `tool_search`: what every request of a session has in common, since found tools are appended after it.
 * Works on spec lists and on provider bodies (`name`, `function.name`, the Responses wire name and its client-executed `tool_search` entry);
 * a list without `tool_search` is returned whole.
 */
export function withoutDiscovered<T>(tools: readonly T[]): readonly T[] {
  const isSearch = (tool: unknown) => {
    const entry = tool as { type?: unknown; name?: unknown; function?: { name?: unknown } } | null
    const name = entry?.name ?? entry?.function?.name
    return name === TOOL_SEARCH_NAME || name === TOOL_SEARCH_WIRE_NAME || name === undefined && entry?.type === TOOL_SEARCH_NAME
  }
  const at = tools.findIndex(isSearch)
  return at === -1 ? tools : tools.slice(0, at + 1)
}

/** Checklists and goals: worth a place in every request of a long session, not of a one-turn coding task (feature `plan_tools`). */
export const PLAN_TOOLS: ReadonlySet<string> = new Set(["todo", "get_goal", "create_goal", "update_goal"])

/**
 * Tools of the lean core that a turn needs only in a situation: reading or stopping a background command, a sub-agent's status, a web
 * page, a question to the user, the plan-mode tools. With the feature `aux_tools` off (every tier unless the user turns it on) they are
 * not listed in every request: `impliedTools` lists each one as soon as its situation arises, and `tool_search` finds any of them before that.
 */
export const AUX_TOOLS: ReadonlySet<string> = new Set(["shell_output", "shell_kill", "task_status", "webfetch", "question", "plan_submit", "plan_review", "plan_exit"])

/** How the catalogue is cut: which tools are always listed. Derived from the lean, plan, auxiliary, find and screen-settings features by the engine. */
export type CatalogMode = { lean: boolean; planTools: boolean; aux: boolean; find: boolean; ui: boolean }
export const LEGACY_CATALOG: CatalogMode = { lean: false, planTools: true, aux: true, find: true, ui: true }

/**
 * The auxiliary tools the conversation already calls for, so nothing that worked with them listed needs a search first: the plan
 * tools while the session is in plan mode, the two that read and stop a background command once one was started, and a sub-agent's
 * status once one was launched.
 */
export function impliedTools(messages: readonly ModelMessage[], plan: boolean): string[] {
  const implied = new Set<string>(plan ? ["plan_submit", "plan_review", "plan_exit"] : [])
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const call of message.toolCalls) {
      if (call.name === "shell" && (call.args as { background?: unknown } | null)?.background === true) { implied.add("shell_output"); implied.add("shell_kill") }
      if (call.name === "task") implied.add("task_status")
    }
  }
  return [...implied]
}

/** Whether `name` is always listed under `mode`; every other tool is deferred behind `tool_search` while discovery is on. */
export function isPrimaryIn(name: string, mode: CatalogMode): boolean {
  if (PLAN_TOOLS.has(name)) return mode.planTools && (mode.lean || PRIMARY_TOOLS.has(name))
  if (mode.lean && (!mode.aux && AUX_TOOLS.has(name) || !mode.find && FIND_TOOLS.has(name) || !mode.ui && name === UI_TOOL)) return false
  return mode.lean ? LEAN_CORE.has(name) : PRIMARY_TOOLS.has(name)
}

/** Callers of the harness itself (the orientation and impact notes) leave no trace that could list a schema. */
const HARNESS_CALL = /^graph_(orientation|impact)_/

/** Only tool history activates schemas; user text, failed searches, harness notes and compacted history cannot. Insertion order is discovery order. */
export function activeToolNames(messages: readonly ModelMessage[], primary: (name: string) => boolean = isPrimaryTool) {
  const active = new Set<string>()
  const add = (name: string) => {
    if (!primary(name) && active.size < MAX_DISCOVERED_TOOLS) active.add(name)
  }
  for (const message of messages) {
    if (message.role !== "tool") continue
    if (HARNESS_CALL.test(message.callId)) continue
    if (message.name !== TOOL_SEARCH_NAME) add(message.name)
    if (!message.isError && (message.name === TOOL_SEARCH_NAME || message.name === "code") && Array.isArray(message.discoveredTools)) {
      for (const name of message.discoveredTools) if (typeof name === "string") add(name)
    }
  }
  return active
}

export function searchTools(catalog: readonly ToolSpec[], query: string, limit = 5, active: ReadonlySet<string> = new Set(), primary: (name: string) => boolean = isPrimaryTool) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 16) ?? []
  const matches = catalog
    .filter((tool) => tool.name !== "invalid" && tool.name !== TOOL_SEARCH_NAME)
    .map((tool) => {
      const name = tool.name.toLowerCase(), description = tool.description.toLowerCase()
      const score = words.reduce((sum, word) => sum + (name === word ? 20 : name.includes(word) ? 8 : description.includes(word) ? 1 : 0), 0)
      return { tool, score }
    })
    .filter(({ score }) => words.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.min(8, Math.max(1, limit)))
  const result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; omitted: number } = { tools: [], omitted: 0 }
  let slots = Math.max(0, MAX_DISCOVERED_TOOLS - active.size)
  for (const { tool } of matches) {
    const needsSlot = !primary(tool.name) && !active.has(tool.name)
    if (needsSlot && slots === 0) { result.omitted++; continue }
    const entry = { name: tool.name, description: tool.description.slice(0, 3000), inputSchema: tool.parameters }
    // Include envelope overhead and multibyte characters, not just the schema's character count.
    const candidate = { tools: [...result.tools, entry], omitted: matches.length - result.tools.length - 1 }
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_SEARCH_BYTES) { result.omitted++; continue }
    result.tools.push(entry)
    if (needsSlot) slots--
  }
  return result
}

/** The host supplies the permission-filtered catalog again at execution time; lookup never invokes a tool. */
export function createToolSearch(catalog: () => readonly ToolSpec[], active: ReadonlySet<string>, primary: (name: string) => boolean = isPrimaryTool): Tool {
  const discovered = new Set(active)
  return defineTool({
    name: TOOL_SEARCH_NAME,
    description: "Find more tools (glob, grep, ls, webfetch, todo, MCP, extensions...) by task, name or keyword; matches become directly callable. Search before assuming one is missing. Finding a tool never grants permission to run it.",
    permission: "read",
    args: z.strictObject({ query: z.string().max(500), limit: z.number().int().min(1).max(8).optional() }),
    async execute({ query, limit }, { signal }) {
      signal.throwIfAborted()
      const result = searchTools(catalog(), query, limit, discovered, primary)
      for (const tool of result.tools) if (!primary(tool.name)) discovered.add(tool.name)
      return { output: JSON.stringify(result), title: "Tool discovery", truncated: false, isError: false, discoveredTools: result.tools.map((tool) => tool.name) }
    },
  })
}
