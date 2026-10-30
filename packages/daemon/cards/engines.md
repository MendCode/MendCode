---
summary: run a session on Claude Code, pi or an ACP agent; the thread bridge
docs: claude-code, pi-engine, acp-engine, thread-mcp, optional-engines
aliases: engine, claude-code, pi, acp, external-agent, gemini, codex-acp, subscription, bridge, thread-mcp, delegate-task
---
For: "use my Claude Code / pi / Gemini CLI as the model", "add an ACP agent", "let Claude Code call a MendCode sub-agent". An engine is who runs the turn; tier, prompt mode and permission mode are separate.

Pick the model in /model and that session's turns go to the engine behind it; native MendCode tools, memory and prompts are then NOT in play, the engine's own are. What stays MendCode's: the transcript, approvals (its permission modes map onto the engine's), esc to stop, the sessions list.

Claude Code: the models claude-fable, claude-opus, claude-sonnet, claude-haiku show in /model only when `claude --version` answers on the daemon's PATH (MENDCODE_CLAUDE_BIN names the binary, MENDCODE_CLAUDE=0 hides them). Those are aliases for the newest of each family; a full id of a family (claude-haiku-5-5, claude-opus-5-5, a dated id) pins the session to that model, anything else is an unknown model. It uses its own login and its own CLAUDE.md, skills, hooks and MCP servers; MendCode never reads its credentials. [[setting:ownLogins]] (new installs) changes only ChatGPT: /connect chatgpt, never Codex's login. One claude process per session (stops after 10 idle min). "Always" approvals last the session. The 5h and 7d windows show in /usage; no cost is shown (subscription).

pi (feature pi, tier full, permit: off until opted in): create <data dir>/pi.json ({} is enough) or the user's /tier pi on. Models come from pi; the sign-in is inside pi, with pi's own login command. --safe-mode turns it off. Nothing starts until a turn is sent on a pi model.

ACP agents (Gemini CLI, Zed's adapters, codex-acp and others): the user's /acp page (a adds, e edits, d removes, r refreshes), the setting [[setting:acpAgents]] or <data dir>/acp-agents.json { "name": { "command", "args", "env" } }; the model is acp:<name>, plus acp:<name>/<model> per model the agent offered on its first turn (kept in <data dir>/acp-models.json). OpenCode's free models: /connect → OpenCode (free) adds `opencode acp`. Full tier: /tier acp_registry on adds an offline catalog (c on /acp; never installs or probes). Remote clients cannot edit agents or run their turns.

Thread bridge (feature thread_mcp, tier full): lets Claude Code, Codex or an ACP agent call MendCode sub-agents. Off by default, one opt-in each: the user runs /tier thread_mcp on claude|codex|acp:<name> ([[setting:threadMcp]]); new turns get delegate_task, whose task_id + model moves a child to another model with its history.

On this machine: read "On this machine now". An engine model missing from /model is almost always the binary not on the daemon's PATH, not logged in, or the feature off; `{{program}} models` shows the catalog.

Not possible: mixing an engine's tools into a native turn, using Codex or Claude credentials from MendCode, an engine that was withdrawn (OpenCode, Cursor SDK: removed, not coming back without an official protocol). Docs do not describe a Codex engine setup; say so rather than guess.
