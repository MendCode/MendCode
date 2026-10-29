---
summary: run MendCode headless: scripts, CI, JSON output, GitHub, editors, HTTP
docs: automation, github, embedding, server-rest, session-rest, project-rest, interaction-rest, catalog-rest, file-rest, tui-rest
aliases: headless, ci, script, scripting, pipeline-ci, non-interactive, json, app-server, http-api, openapi, github-actions
---
For: "run it from a script / cron / CI", "get the answer as JSON", "limit what it can do in a job", "use it from GitHub", "build my own client".

Shortest path: {{program}} run "message" (piped stdin is appended; a stdin silent for 1 s is skipped unless - is given; run - uses stdin only). It starts the daemon if needed, runs one turn and exits.
  Choose: --model provider/model, --agent NAME, --variant NAME, --effort minimal|low|medium|high|xhigh, --permission ask|edits|plan|smart (never full), --cwd PROJECT, --dir DATA, -f FILE… (files, images, a directory listing; the message may follow), --command NAME.
  Narrow it for a job: --tools a,b (allow-list; never grants more than the rules allow; sub-agents off), --exclude-tools, --offline (no webfetch, websearch, image_gen), --max-turns N, --add-dir PATH, --system-prompt TEXT, -c KEY=VALUE.
  Output: --format json streams raw events; --output-schema FILE makes stdout one validated JSON document; -o FILE writes the final message; --ephemeral deletes the session after.
  Exit codes of run: 0 done, 1 failed, 2 stopped, 3 answer rejected by the schema, 4 --max-turns reached, 5 an approval was denied for lack of --approve and nothing ran after it, 64 usage error.
  Nobody answers approvals in a script: --approve approves once, --dangerously-skip-permissions approves everything (also what Claude Code flags): only with the user's say-so, in a sandbox they chose. Both are the user's: from your own shell they are refused, and a session you start there gets at most your session's permission mode.
Background: run --bg returns the session id at once; ps lists, logs ID [-f] follows, kill ID cancels, attach ID opens the TUI on it. {{program}} session ... and {{program}} apply [SESSION] --to DIR (all-or-nothing copy of a session's file changes) exist too.
GitHub: {{program}} github install writes the workflow that answers comments mentioning its trigger words, github run executes one event; publishing and approvals are opt-in ({{program}} docs git).
Editors and other UIs: {{program}} acp is a stdio agent for Zed or JetBrains; {{program}} app-server is a JSON-RPC server (threads, turns, approvals) for third-party UIs, local-only; {{program}} generate prints the socket schema, generate --httpapi the OpenAPI contract of the opt-in HTTP adapter (daemon --http-listen 127.0.0.1:9877, loopback, bearer token). Remote use: {{program}} docs remote.

Commands take --json and --dir DATA; {{program}} help lists them. A bad flag is a usage error (exit 64) before any session exists; a daemon too old for --tools fails the run instead of running unrestricted.

Not possible: an unattended job that is asked for approval and waits (it needs --approve or a --permission mode that fits); full access from --permission; a script that changes the user's trust or credentials.

Check: the exit code and, with --json, the final event; say which you read.
