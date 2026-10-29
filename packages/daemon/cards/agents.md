---
summary: custom agents (prompt, model, tools, permission) and the default one
docs: agents, advanced-config
aliases: agent, custom-agent, reviewer, personas
---
An agent is a markdown file: <data dir>/agents/<name>.md or <project>/.mendcode/agents/<name>.md (project agents do nothing until the user trusts the project in /tools; .claude/agents is read too, as data). The body (up to 16,000 characters) is added to the system prompt.
  ---
  name: reviewer            # default: the file name; lowercase letters, digits, _ and -
  description: Reviews a diff without touching it   # required, up to 300 characters
  mode: primary             # primary | subagent | all (default all)
  model: gpt-6-sol          # optional: a catalog model id (see {{program}} models)
  effort: high              # optional: minimal | low | medium | high | xhigh
  tools: [read, grep, glob] # optional allow list; a trailing * matches a prefix (mcp__github__*)
  deny: [shell]             # optional, applied after the allow list
  permission: ask           # optional cap: plan | ask | smart | edits | full
  ---
  You review code. Read what changed, run nothing, edit nothing. Report findings as a list.
Other fields: temperature, top_p, variant, steps (last model call has no tools), hidden (not in the picker), disable, color (hex or a theme role).
Primary agents are what the user switches between (/agent, agent.next in {{program}} docs key-actions); sub-agents are what the task tool starts, or what @name mentions: running, continuing and stopping them is {{program}} docs subagents. build and plan can be overridden by a file of the same name. A new session starts as the [[setting:default_agent]] setting (the user's /settings; a project may set its own with [[setting:defaultAgent]]), build when unset or unknown. Agent files apply to the native engine only: sessions on Claude Code or Codex models ignore them.
Without a file, the daemon setting [[setting:agent]] (a map by agent name) overrides fields of an agent. Manage from the CLI: {{program}} agent list | create | debug. The user sees all agents and problems in /agents and /doctor.
