---
summary: run a shell command at tool, prompt and session events (hooks.json)
docs: hooks
aliases: hook
---
hooks.json in <data dir> (yours), in a package, or <project>/.mendcode/hooks.json (needs /tools trust). Re-read every turn.
  { "hooks": {
      "PreToolUse": [ { "matcher": "bash|write", "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 10 } ] } ],
      "Stop": [ { "hooks": [ { "command": "npm test --silent" } ] } ] } }
- command is a string (run by /bin/sh -c) or an argv array (./x is relative to the folder holding hooks.json); the cwd is the session's project. timeout is seconds (default 15, max 120); a timed-out hook is killed and ignored.
- matcher is a case-insensitive regex tested against the whole tool name (and, for other events, the source, notification type or compaction trigger); empty or * matches all.
- The hook gets the event as JSON on stdin. Exit 0 continues. Exit 2 blocks where the event can: PreToolUse refuses the call (stderr is the error the model reads), UserPromptSubmit stops the prompt, Stop starts one follow-up turn with stderr (at most 3 in a row), PreCompact cancels the compaction. Stdout of a UserPromptSubmit hook that exits 0 is added to the prompt as context.
Events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStop, SessionStart, SessionEnd, PermissionRequest (can only refuse, never approve), Notification, PreCompact, PostCompact. Tool, permission and compaction events apply to the native engine.
Types: command (default); http (POSTs the same JSON; runs only for URLs matching the allowedHttpHookUrls setting, off by default); prompt.
Hooks run with the user's privileges: write only what the user asked for. Check: the user sees every hook in /hooks; a bad file, unknown event or invalid matcher is listed there as a problem. Hooks in TypeScript: {{program}} docs extensions.
