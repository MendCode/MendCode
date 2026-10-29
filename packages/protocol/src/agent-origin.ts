import type { CommandType } from "./commands"

/**
 * What a client started by a session's own shell (an "agent-origin" client) may ask the daemon. It is a guard against a
 * model, or text steering it, raising its own authority through MendCode's front doors; it is not a sandbox against code
 * that writes the data directory itself (docs/permissions.md). Zod-free: the terminal client classifies before it sends.
 *
 * Three classes. `open`: reads and what changes nothing a session could not already do. `capped`: session work, allowed
 * only within the calling session's own permission mode (see `packages/daemon/src/agent-origin.ts`). Everything else is
 * `owner`: only the user, from their own terminal or the TUI. A command absent from both lists is `owner`, so a new
 * command is refused to agent-origin clients until it is classified here.
 */
export const AGENT_OPEN_COMMANDS = [
  "hello", "client.subscribe", "client.unsubscribe", "trace.configure", "app.log",
  // sessions and their history
  "session.list", "session.get", "session.inspect", "session.stats", "session.events", "session.timeline", "session.history", "session.export", "session.search",
  "session.tree", "session.children", "session.changes", "session.savings", "session.recall.search", "session.recall.read", "session.aside.get",
  "session.background.list", "session.agent-view.metadata.list", "session.agent-view.metadata.get", "session.share.get", "session.rest.read",
  "session.agent-command.list", "session.agent-command.list-by-session", "session.agent-command.policy",
  "queue.list", "task.list", "task.status", "background.list", "continuity.list", "continuity.get", "continuity.wait", "interaction.list", "plan.review.list",
  "goal.get", "draft.get", "draft.list", "prompt.history", "scratchpad.get", "backlog.get", "attachment.read",
  // configuration, as it stands
  "settings.get", "permissions.list", "permissions.status", "permissions.history", "privacy.get", "env.list", "secrets.list", "sandbox.status",
  "models.list", "models.config.get", "agents.list", "recipes.list", "providers.list", "providers.catalog", "providers.auth.methods", "providers.auth.status",
  "providers.auth.plan", "providers.auth.metadata", "plugins.auth-methods", "plugins.metadata", "acp.registry", "reasoning.status", "cache.status",
  "budget.status", "budget.doctor", "setup.status", "setup.plan", "setup.doctor", "release.inspect", "compound.get", "channels.status",
  "prompt.status", "prompt.sources", "prompt.build", "themes.list", "theme.validate", "tui.query", "sidebar.get", "status.watch", "console.get",
  "console.listOrgs", "console.accounts", "server.config.get", "tsm.query", "ide.query", "mflow.query",
  // tools, extensions, packages, MCP
  "tools.list", "skills.list", "skills.load", "commands.list", "commands.discover", "commands.expand", "extensions.list", "extensions.report", "hooks.list",
  "packages.list", "packages.search", "packages.show", "packages.sources", "packages.assets", "mcp.status", "mcp.catalog", "mcp.resources.list",
  "mcp.resource.read", "mcp.prompts.list", "mcp.prompt.get", "formatter.status", "lsp.query",
  // memory, loops, workflows: reading
  "memory.list", "memory.search", "memory.graph", "memory.categories", "memory.workspaces", "memory.browse", "memory.sharing.status",
  "memory.assistant.get", "memory.extraction.list", "evolution.list", "dream.list",
  "loop.list", "loop.templates", "loop.snapshot", "loop.events", "loop.artifacts", "loop.receipt", "loop.export",
  "workflow.list", "workflow.get", "workflow.preview", "workflow.definitions", "workflow.revision.get", "workflow.events", "workflow.artifacts",
  "workflow.receipt", "workflow.export",
  // the project and the machine
  "git.status", "git.branch", "git.pr.view", "codegraph.overview", "files.search", "files.query", "file.view", "file.rest.read", "changes.query",
  "changes.file", "review.query", "context.query", "context.recent", "system.query", "storage.report", "storage.worktrees", "worktree.query",
  "workspace.query", "usage.query", "usage.waste", "usage.weather.query", "diagnostics.resources", "diagnostics.snapshot", "daemon.info", "daemon.status",
  "daemon.logs", "server.health", "server.memory", "trace.query", "debug.query", "db.query", "pty.shells", "pty.list", "pty.get",
] as const satisfies readonly CommandType[]

/** Session work an agent-origin client may do only inside its own authority; the daemon checks each against the calling session. */
export const AGENT_CAPPED_COMMANDS = [
  "session.create", "session.fork", "user.submit", "commands.execute", "turn.cancel", "request.resolve",
  "queue.promote", "queue.remove", "queue.reorder", "queue.edit", "queue.steer",
  "session.permission.set", "session.run.configure", "session.model.set", "session.agent.set",
  "attachment.add", "attachment.put", "attachment.paste",
  "session.delete", "session.archive", "session.rename",
] as const satisfies readonly CommandType[]

export type AgentCommandClass = "open" | "capped" | "owner"

const open = new Set<string>(AGENT_OPEN_COMMANDS)
const capped = new Set<string>(AGENT_CAPPED_COMMANDS)
export const agentCommandClass = (type: string): AgentCommandClass => (open.has(type) ? "open" : capped.has(type) ? "capped" : "owner")

/** Authority order of the permission modes: a session never hands out more than its own. */
const RANK: Record<string, number> = { plan: 0, ask: 1, edits: 2, smart: 3, full: 4 }
export const permissionRank = (mode: string | undefined) => RANK[mode ?? "ask"] ?? RANK.ask!
/** The mode to use when `wanted` is above `ceiling`. */
export const capPermission = <Mode extends string>(wanted: Mode, ceiling: Mode): Mode => (permissionRank(wanted) > permissionRank(ceiling) ? ceiling : wanted)

/** The variable every shell a session starts carries: the data directory of the daemon it runs under. */
export const AGENT_SHELL_ENV = "MENDCODE_AGENT_SHELL"
/**
 * The hard file-size limit (512-byte blocks) those shells also get. A process can lower a hard limit and never raise it,
 * so the mark survives `env -u`, a new session and a double fork. 512 PiB: no real file reaches it.
 */
export const AGENT_SHELL_FILE_BLOCKS = 1_125_899_906_842_624

/** `hello` capabilities. `origin:agent`: the client found the session's variable in its environment. `limit:N`: its hard file-size limit in bytes, when it has one. */
export const AGENT_ORIGIN_CAPABILITY = "origin:agent"
export const AGENT_LIMIT_CAPABILITY = "limit:"

/** One wording for every layer, so the model reads the same thing wherever it is stopped. */
export function agentRefusal({ what, ask }: { what: string; ask?: string | undefined }) {
  return `refused: ${what}. A session cannot change permissions, global settings or another session's authority from its own shell; only the user can. Do not look for another way in the shell. Ask the user to ${ask ?? "run it from their own terminal, or to change it in the TUI (/settings, /permissions)"}. For a daemon setting you may instead propose the exact change with the mendcode_settings tool (find it with tool_search); the user approves it on a card.`
}
