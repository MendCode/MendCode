---
summary: long commands, servers, watchers and interactive programs in the background
docs: interactive-tools, async-tools, pty, tool-discovery
aliases: bg-shell, jobs, daemonize, dev-server, watcher, detach, shell-session, pty, sleep
---
For: "start the dev server and tell me when it is ready", "run the build while you keep going", "watch this log", "run a REPL / installer that asks questions", "what is still running".

Background shell commands:
  shell {command, background: true}: returns a task id at once and keeps running. Approvals as for a foreground command; its timeout (120 s, at most 600 s) does not apply.
  shell_output {id, waitMs?, until?}: new output since the last read, status and exit code; waitMs (at most 30000) waits for output or exit; until: "exit" waits for the end only (120 s, at most 600 s); no id lists this session's tasks. task_status {id} peeks at the end without moving the read position. Binary output is one line with its size.
  shell_monitor {id, match?, stop?}: pushes output lines that contain any of up to 8 texts (case-insensitive substrings, no regex; every line when none) as messages in 2 s batches of at most 20 lines. For "ready or errors": match ["ready","error"]; it ends when the task exits, on stop, or after 30 messages.
  shell_kill {id}: SIGTERM, SIGKILL after 2 s; no exit message follows.
  When a task ends on its own you get one message with the end of its output (not if shell_output already showed its exit): after your next tool result in the running turn, or in a new turn if your answer ended first (always with a non-native engine). Keep working; use until: "exit" only when nothing else can be done first. Do not poll or sleep.
Limits: 8 running tasks across all sessions; 256,000 characters kept per task (older output scrolls out; the next read says how much); a task running after 6 hours is stopped; 32 finished tasks stay readable. A session only sees and stops its own tasks.

Programs that ask questions or need a terminal (installers, REPLs, debuggers, ssh): shell_session {action: start|write|read|resize|signal|kill|list}. macOS and Linux only; at most 4 per chat and 8 in all; idle 15 minutes stops it, 2 hours at most; a bare shell (bash, zsh with no script) is refused: use shell per command.

Read-only jobs: with the user's experimental.async_tools on, tool_start {tool: read|grep|glob|webfetch}, tool_status, tool_wait, tool_cancel run them while you continue (4 active, 8 queued per session); question_start/question_status do the same for questions (experimental.async_questions). Shell and writes cannot.

After the user cancels a turn, notices of tasks that end arrive with the user's next message; the chat shows them as one line, ctrl+s sends them now.

User: Jobs dock (ctrl+t); /ps stops tasks (read: killed (user)); /bg detaches the session ({{program}} docs subagents).

Not available: a task that outlives the daemon (a stop or restart ends it); auto-restart of a task; input to a plain background task (use shell_session); live output on the user's screen other than the dock and the transcript card.

Check: shell_output shows running or the exit code. A server that should listen: confirm with a request or its log, not the task id.
