import type { CommandType } from "./commands"

/** Explicit read set: new commands are denied to read-only peers until classified here. */
export const READ_ONLY_COMMANDS = [
  "hello", "client.subscribe", "client.unsubscribe", "session.list", "session.events", "session.timeline", "session.history", "skills.list", "skills.load", "session.export",
  "background.list", "usage.query", "usage.waste", "daemon.info", "diagnostics.resources", "models.list", "agents.list",
  "goal.get", "git.branch", "files.search", "storage.report", "context.query",
  "evolution.list",
  "dream.list", "loop.list", "loop.templates", "workflow.list", "workflow.get", "workflow.preview", "commands.list",
  "mcp.status", "tools.list", "themes.list", "recipes.list",
  "providers.list", "secrets.list", "sidebar.get", "session.aside.get", "git.status", "tui.query",
  "plan.review.list",
  "session.agent-command.policy",
  "session.agent-command.list",
  "session.get", "session.inspect", "session.stats",
  "context.recent",
  "session.agent-command.list-by-session",
  "server.health", "server.memory",
  "providers.auth.methods", "providers.auth.status", "providers.auth.plan",
  "release.inspect",
  "daemon.status",
  "trace.query",
] as const satisfies readonly CommandType[]
// Content/config reads (including settings.get's provider headers, permission patterns, command files, memories,
// the scratchpad and working-tree diffs) return stored text unredacted and can expose credentials;
// provider-backed reports can also chmod their config.
// They require a full-access peer even when the command name describes a query:
// changes.query/changes.file return raw working-tree diffs and untracked file contents of any directory, scratchpad.get raw notes.
const reads = new Set<string>(READ_ONLY_COMMANDS)
export const isReadOnlyCommand = (type: CommandType) => reads.has(type)

/** Literal loopback only: hostnames may resolve elsewhere, so they require TLS. */
export const isLoopbackHost = (host: string) => host === "127.0.0.1" || host === "::1"

export function parseRemoteAddress(address: string) {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(address)
  const host = match?.[1] ?? match?.[2]
  const port = Number(match?.[3])
  if (!host || /[\s/]/.test(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("remote address must be host:port (IPv6: [::1]:port)")
  return { hostname: host, port }
}
