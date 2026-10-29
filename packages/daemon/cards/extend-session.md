---
summary: extensions that set model or tools, send messages, ask, add flags or MCP
docs: extensions
aliases: set-model, active-tools, send-message, append-entry, extension-events, extension-flags, register-flag, extension-dialogs, virtual-model, register-mcp
---
For: "a command that switches to the big model with high effort", "read-only tools in this session", "when a turn fails, ask the agent why", "count tool calls per session", "a --ticket flag", "ask me before git push", "add the jira MCP server", "a model that uses the cheap one for sub-agents". All in daemon(api) of one extension, written with mendcode_extend; every call answers, none throws.
Session (sessionId is in every event and in a command's ctx):
  await api.setModel(sessionId, "openai:gpt-6-sol", { effort: "high" }) -> { ok } | { ok: false, error }; api.setThinkingLevel(sessionId, "high"); api.getModel(sessionId) -> { model, effort }
  api.setActiveTools(sessionId, ["read", "grep", "glob", "ls"]) narrows the offered tools (null lifts it; never adds one); api.getActiveTools(sessionId)
  await api.sendUserMessage(sessionId, "text", { deliverAs: "steer" }) queues it as the user's message (input hooks and slash commands skip it; 5 a minute)
A model must be in /model on the session's engine; nothing changes approvals, permission mode, budgets or the tier.
Notes and events: api.appendEntry(sessionId, "type", data) keeps a record in the extension's folder, never in the model's context; api.entries(sessionId, "type"). api.events.on("name", (data, { from }) => ...) in daemon(api); api.events.emit("name", data) reaches every extension's listeners.
Flags: api.registerFlag("ticket", { type: "string", description: "issue id" }); api.getFlag("ticket", sessionId). The user types {{program}} --ticket=ABC-12 (a boolean: --name); a flag no extension declares is refused.
Dialogs: await api.ui.confirm(sessionId, "Push", "Let the agent push?", { default: false, timeoutMs: 20000 }); api.ui.select(sessionId, "Env", ["dev", "prod"], { default: "dev" }); api.ui.input(sessionId, "Ticket", { default: "" }). default is required: it answers at once in a headless run or with no terminal open, on timeout (30 s) and on esc. The card never holds the turn. In tool.before skip e.via (derived reads) before asking.
MCP: api.registerMcpServer("jira", { url: "https://jira.example.com/mcp", headers: { authorization: "Bearer ${JIRA_TOKEN}" } }) or { command, args, env }; like an mcp.json entry (${VAR} from the environment), started where MCP is on (full tier).
Virtual model: api.registerVirtualModel({ id: "auto", models: ["openai:gpt-6-sol", "gpt-6-luna"], route: ({ role }) => role === "subagent" ? "gpt-6-luna" : undefined }) lists virtual:auto in /model; each call goes to the model route answers, else the first. User extensions only; route is synchronous.
Check: mendcode_extend list shows flags, mcpServers, virtualModels, events; command runs a command that uses them. Reference: {{program}} docs extensions.
