---
summary: permission modes, approvals, allow and deny rules, the OS sandbox
docs: permissions, sandbox
aliases: permission, approvals, approval, sandbox, trust, security
---
Every tool call is read, write or execute. Modes (per session; the default for new sessions is the defaultPermission setting):
  ask: asks for writes and commands | edits: runs edits, asks for commands | smart: runs low-risk calls by fixed rules, asks about the rest | full: runs unless a deny rule matches | plan: read-only until a plan is approved
Reads of .env files ask in every mode. "For this session" approves that tool for the session. Deny rules always win. A denied call is the user's decision: adapt, never retry it. Package changes need an approval card even in full.
Smart mode runs reads, edits inside the project, and allow-listed commands (ls, cat, grep, read-only git, the project's own test and build commands, and mendcode docs [--search] words on its own line). It asks for destructive commands, secrets paths, .git and .mendcode paths, anything outside the project, network, loops, unlisted commands and $ or backtick expansion; it refuses rm -r of / or ~ and similar outright. Every prompt says why it asks.

Change (your shell's change commands and --approve are refused in all modes; when the user asks, propose it with mendcode_settings, e.g. {"defaultPermission":"edits"}, saved on their Apply):
  shift+tab or the permission picker changes the current session; {{program}} control-plane permissions status
  {{program}} control-plane permissions set-default approval|smart|full_access|ask|edits|full     new sessions
  {{program}} control-plane permissions set-reviewer-role <model role>     optional reviewer of uncertain smart calls (off by default)
Rules and allow list are daemon settings in the user's /settings: [[setting:permission]] (ordered tool and path rules, ask/deny/allow) and [[setting:permissionAllow]] (command prefixes such as ["make test","git commit"]; they never override a risk rule or the forbidden list). Remote clients cannot.
Sandbox (opt-in, shell commands of the model run inside an OS sandbox; approvals still apply): /sandbox off | read-only | workspace-write, /sandbox network on|off, /sandbox allow <abs path>. Setting [[setting:sandbox]]: { "mode": "workspace-write", "network": "off", "writableRoots": [] }.
Trust: a project's tools, hooks, MCP servers, agents and extensions run only after the user trusts the directory in /tools or /trust. Never widen permissions, the sandbox or trust unless the user asked for that exact change.
A rejection ends the turn unless the experimental flag continue_loop_on_deny is on. The user's commands: /permissions lists grants and modes, /approve allows one retry of a call that was denied (you may suggest it, never assume it). Extra settings: [[setting:additionalDirectories]] (outside folders that count as the workspace: no external-directory ask, writable in the sandbox); [[setting:smartSandboxTrust]] (smart mode runs unknown shell commands without asking only when the sandbox is on with network off); [[setting:engineSafetyPrompts]] (Claude Code still asks when its own safety check flags a command in full access); [[setting:permissionReviewerRole]].
