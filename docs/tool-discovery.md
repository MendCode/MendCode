# Tool discovery

Native sessions can opt in through `settings.set`:

```json
{"type":"settings.set","patch":{"experimental":{"tool_discovery":true}}}
```

Discovery defaults on for native full-tier sessions when MCP is enabled; other tiers and legacy settings stay opt-in.
Explicit `experimental.tool_discovery: false` restores the complete permission-filtered catalog. Resetting
`experimental` returns to the tier default. A settings patch replaces the whole object; include any existing
`primary_tools` and `continue_loop_on_deny` values when changing discovery. Settings persist in the daemon and
apply on the next model step. External engines keep their own catalogs.

Core tools stay visible: file and shell operations (including `shell_session`, `shell_monitor`, `sleep` and `notebook_edit`), background status, tasks, questions, plans, goals, todo, skills,
memory, loops, workflows, review, sessions, web tools, image generation, LSP and secret markers. Other built-ins,
MCP tools, custom tools and extension tools are secondary. `experimental.primary_tools` still means **main agent
only**; it does not promote tools into the discovery primary set.

`tool_search({query, limit?})` searches names and descriptions locally. Exact names rank before name fragments,
then description matches; equal scores sort by name. Empty queries list names alphabetically. Query: at most
500 characters and 16 search words. Limit: 1–8, default 5. The result is `{tools: [{name, description, inputSchema}],
omitted}`. Descriptions stop at 3,000 characters; the entire UTF-8 result fits 24 KiB. Oversized schemas and matches
beyond the session's 64 secondary-tool slots are counted in `omitted`.

Returned tools become callable on the next model step. The daemon stores discovery receipts in native tool
history, so they survive restarts and later turns in the same session. Retained legacy tool calls activate their
schemas too. Compaction discards old receipts along with old tool history. Sessions and inline child agents have
separate discovery contexts. Lookup reads schemas only: it never invokes an MCP service or a tool, changes an
approval or grants permission. Tool/path rules, agent restrictions, main-only tools and execution approvals remain
in force. If lookup itself is disabled by tool or agent rules, eligible tools remain directly visible.

The chat uses existing tool rows; Ctrl+O expands the JSON receipt. No new page or sidebar is required.
OpenAI Responses uses `mendcode_tool_search` at the wire boundary and `tool_search` in host history; both names
are reserved from extension registration. The ChatGPT backend gets the API's own tool search instead (see "Deferred
loading on the ChatGPT backend"). Invalid stored search arguments stop replay without rewriting history.

B26 decisions: opt-in/off by default; v1 primary capabilities mapped to v2 names; local, bounded lookup without
a service timeout or a new listener. B71 adds opt-in [Code Mode](code-mode.md), using this catalog and retaining
every nested tool's native permissions.

## Lean catalogue and plan tools (tier defaults)

Every tool schema is sent with every model call, so the catalogue is most of a short task's input: in the gpt-6-luna
evaluation, 55 tools were 92.7 KB of schemas (about 20 K tokens per call, 89 % of all input tokens), while a coding
turn uses about a dozen of them. These features cut the request down; each follows the tier and reverts alone
(`/tier <id> on|off`, or `features.<id>` in settings). With no tier set nothing changes.

| Feature | Tier default | What it does | Revert |
|---|---|---|---|
| `lean_tools` | on with every tier | Lists only the coding core (`shell`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `shell_output`, `shell_kill`, `task`, `task_status`, `skill`, `webfetch`, `question`, the three plan-mode tools, `code`/`snip` when enabled, and with the feature `codegraph` the lookups `graph_find`, `graph_callers` and `graph_file_api`) and `tool_search`. `ls` is not in it (`read` lists a directory). Workflows, loops, worktrees, memory, sessions, notebooks, LSP, images, MCP and the rest are found with `tool_search`. | `features.lean_tools: false` (the discovery set above applies when `tool_discovery` is on) |
| `aux_tools` | off with every tier (on with no tier) | Keeps the situational tools of the core in every request: `shell_output`, `shell_kill`, `task_status`, `webfetch`, `question` and the three plan-mode tools. Off, nothing is removed: each one is listed without a search as soon as the conversation calls for it (the plan tools while the session is in plan mode, `shell_output` and `shell_kill` once a command was started in the background, `task_status` once a sub-agent was launched), and `tool_search` finds any of them before that. | `/tier aux_tools on` |
| `find_tools` | on with every tier, and with no tier | Keeps `glob` and `grep` in every request. Minimalist without them sent a 864-token first request, under OpenAI's 1,024-token minimum cacheable prompt: the second request of every session was paid in full and, over 36 evaluation runs, uncached input rose 12 % although the first request shrank. With them it is 1,064, still below pi. Off, `shell` searches with `rg` and `tool_search` finds them. | `/tier find_tools off` |
| `ui_tool` | on with `balanced` and `full`, and with no tier | Keeps `customize_ui` (the user's own screen) in every request: measured with gpt-6-luna on 20 requests like "hide the footer", deferred it was found and used in 14 of 20, the rest looked in the project; listed, 20 of 20. Minimalist defers it. | `/tier ui_tool on` |
| `plan_tools` | off with every tier (on with no tier) | Keeps `todo` and the goal tools (`get_goal`, `create_goal`, `update_goal`) in every request. A one-turn coding task does not use them (13 `todo` and 1 `update_goal` calls in 36 evaluation runs, the latter an error); `tool_search` finds them. | `features.plan_tools: true` |

So the first request of a fresh session lists, with no MCP and no skills: minimalist `read`, `write`, `edit`, `apply_patch`,
`shell`, `glob`, `grep` and `tool_search`; balanced and full those, the three graph lookups and `task`. Measured on the ChatGPT
backend with gpt-6-luna (input tokens the provider reported for "Reply with the single word ok", `.agents/evals/harness/first-request.ts`):
minimalist 1,104 → 1,064, balanced 3,256 → 2,421, full 4,734 → 3,433; pi 0.85.1 with its four tools, 1,188. A test
(`packages/engine-native/test/lean-catalog.test.ts`) finds every deferred core tool with `tool_search` in each tier and checks
that it joins the request with the very schema it had when always listed.

`experimental.tool_discovery: false` beats them all: the complete catalogue, as before. A deferred tool the model calls by
name is refused once as an unknown tool and is listed from the next call on, so finding it with `tool_search` first saves that step.

Cache behaviour: discovered tools are appended at the end of the tool list in the order they were found
(`tool_search` comes right before them), so the tools listed before keep their bytes and the cache key does not change. The
call right after a find still reads the system prompt and the conversation uncached, once: providers place the tool list
before both, and a longer list ends the cached prefix there (see [prompt cache](prompt-cache.md)). The ChatGPT backend is the
exception: see "Deferred loading on the ChatGPT backend" below. The harness's own `graph_map` and `graph_impact` notes never list a schema. Measured first-request
sizes (chars of tool JSON, then tokens at 0.21 per char, plus a system prompt of 0.5 to 0.9 K tokens):

| Arm | Tools | Tool chars | About tokens (tools and system prompt) |
|---|---|---|---|
| no tier (before) | 55 | 74,170 | 16.2 K (20.2 K before schema compaction) |
| balanced, `lean_tools` off, `plan_tools` on, `tool_discovery` off | 58 | 76,969 | 16.8 K |
| balanced, `lean_tools` off (plan tools deferred only) | 54 | 74,250 | 16.2 K |
| balanced, discovery with the legacy primary set | 39 | 43,419 | 9.8 K |
| balanced, lean with plan tools | 23 | 14,522 | 3.7 K |
| **balanced, lean (default)** | 19 | 11,803 | 3.1 K |
| **minimalist, lean (default, `minimal` prompt)** | 18 | 10,486 | 2.3 K |
| minimalist, `lean_tools` off, `plan_tools` on | 47 | 69,270 | 14.7 K |
| full, lean (default, `full` prompt) | 23 | 14,522 | 3.9 K |
| full, `lean_tools` off | 39 | 43,419 | 9.9 K |

The `read` schema grew by about 500 characters when it learned `paths`; the table is measured with it. It was measured before the three code graph lookups joined the always-listed set (balanced and full): those rows now list three more tools, with short schemas.

## Deferred loading on the ChatGPT backend

On the ChatGPT subscription (`https://chatgpt.com/backend-api/codex`) the Responses adapter sends `tool_search` as the
API's own client-executed tool search, so a found tool never joins the `tools` array (`searchLoads` and `toResponsesInput`
in `packages/engine-native/src/openai-responses.ts`; tests in `packages/engine-native/test/cache-discovery.test.ts`).
MendCode still runs the search itself, with the same catalogue, limits and permissions; only the wire shape differs:

| Where | Function shape (every other provider) | Client-executed shape (ChatGPT backend) |
|---|---|---|
| `tools` | `{type: "function", name: "mendcode_tool_search", …}`, then each found tool appended | `{type: "tool_search", execution: "client", description, parameters}`; found tools are not listed |
| The model's search | `function_call` named `mendcode_tool_search`, `arguments` a JSON string | `{type: "tool_search_call", call_id, execution: "client", arguments: {query, limit?}, status}`, `arguments` an object |
| The result in `input` | `function_call_output` with the JSON receipt | `{type: "tool_search_output", call_id, status: "completed", execution: "client", tools: [{type: "function", name, description, parameters, strict: false, defer_loading: true}]}` |

A found tool is defined once, in the result of the last successful search that names it: a model that searches again for
a tool it already has gets it in that answer instead of an empty one (the earlier result then sends `tools: []`, one
uncached call). A failed search and a search that only finds listed tools send `tools: []`. The model does not see the receipt's
`omitted` count in this shape. Tools activated without a search result in the history (found inside `code`, or called by
name and refused once) are still appended to `tools`, with the one uncached call that costs. The native compaction
endpoint (`/responses/compact`) keeps receiving the function shape: the canary did not cover it.

A backend that answers 400 or 422 to a request in this shape gets the same call again in the function shape, once, in the
same turn. When that second request is answered, the session (per model) stays on the function shape for the life of the
daemon, with no further attempt; when it is refused too, its error is reported and nothing is remembered. A 5xx or a
network failure is retried as before and never switches the shape. `api.openai.com` and other Responses hosts stay on the
function shape: the public API documents the same items for its newest models only, and no call was made there
(`clientToolSearch: true` on `createResponsesProvider` turns it on for a host).

Live canary, 2026-10-12, `gpt-6.1-sol` at effort `low`, 9 calls, one prefix (3 function tools and the search, instructions of
about 5.3 K tokens, one user message), all HTTP 200:

| # | Request | Input tokens | Read from cache | The model |
|---|---|---|---|---|
| 1 | function shape, first call | 5,691 | 0 | called `mendcode_tool_search` |
| 2 | the same request again | 5,691 | 5,504 | the same call |
| 3 | function shape with one tool appended to `tools` (a find, as before) | 5,726 | 0 | called `mendcode_tool_search` |
| 4 | client-executed shape, first call | 5,707 | 0 | `tool_search_call`, `{query: "edit Jupyter notebook cell source", limit: 1}` |
| 5 | 4 plus the call and a `tool_search_output` defining `notebook_edit` | 5,893 | 5,504 | called `notebook_edit` with `{path: "a.ipynb", cell: 0, source: "print(1)"}` |
| 6 | 5 plus that call and its result | 5,942 | 5,760 | answered `done` |
| 7 | 4 plus an empty result (`tools: []`), a second search the model never made, its result, the tool call and its result | 5,984 | 5,504 | answered `done` |
| 8 | the adapter as implemented, first user message | 5,707 | 5,504 | `tool_search_call`, turned into a `tool_search` call for the host |
| 9 | the adapter as implemented, history with the search and the found tool | 5,893 | 5,760 | called `notebook_edit` with the right arguments |

So: appending one tool cost the whole prefix (call 3: 0 of 5,726 read from the cache), and loading it through the search
result cost nothing (call 5: 5,504 of 5,893, the same read as the plain repeat in call 2). Only this model was tried.

## Fewer round trips: reads, patches and the orientation block

The other half of the gap is calls, not size. In the 36 evaluation runs, 56 % of the read-only exploration steps could have
shared a call with a neighbour (94 of 166 calls were savable), the model searched for `AGENTS.md` 14 times (the system prompt
already carried it) and listed directories 17 times. Three changes, each reverting alone:

| Change | What it does | Revert |
|---|---|---|
| Multi-path `read` | `read` takes `paths: [{path, offset?, limit?}]` (up to 64; one 120 KB output budget and one 80 MiB budget for attached images and PDFs are the real bounds); each file is a `=== path ===` section, a bad path is reported in its section and only fails the call when every path failed. Once a budget is spent the call ends with one `[not read: …]` marker that lists every path left, one per line, for the next call. Permission rules are checked per path. | The system text decides what the model is told; `read` with a single `path` is unchanged |
| `apply_patch` as the edit path | The system text names `apply_patch` for one or several files (no earlier `read` needed when the model has the text), `edit` for one replacement, `write` for new files. A hunk that does not match names the closest line. Hunks are matched against the file as it is on disk: out of file order they still apply when they fit exactly one unclaimed place (several places or an overlap with another hunk is an error that says so), a hunk that changes nothing (context only, or the same lines removed and added) is an anchor that says where the next hunk goes, and a file whose hunks change nothing at all is an error instead of a reported `M`, except with `*** Move to:`, where the rename is the change. Any error leaves every file of the patch untouched. | Revert the wording in `packages/engine-native/prompts/system.md` (lines 3 to 6) |
| `orientation` (tier balanced and up) | The first user message of a main session starts with an `<orientation>` block: cwd, git branch, package manager and test command from `package.json` (or Cargo, Go), the project instruction files the system prompt already holds, and the top two levels of the tree (at most 150 paths, ignoring `.gitignore` plain names and `node_modules`, `dist`, `build` and the like; at most 6,000 characters). Built once, kept in the history, never in the cached system prefix. | `/tier orientation off` or `features.orientation: false` |

`glob` saves calls the same way: a pattern may use brace alternatives (`{src,test}/**/*.ts`), and `patterns` (up to 8) merges
several globs into one newest-first list without duplicates under the same 1,000-file cap. Each pattern is matched against the
`glob` permission rules; the single `pattern` form is unchanged.

`glob` walks the tree itself and bounds the walk. It starts at the pattern's fixed directories (`src/lib/**` reads only
`src/lib`) and, without `**`, stays at the pattern's depth. `node_modules`, `.git`, hidden files and directories and, on macOS,
`~/Library` are not listed at all unless the pattern names them (`.github/**/*.yml`, `node_modules/zod/**`). After 50,000
directory entries or 5 s (the bounds of the daemon's file search fallback) the walk stops and the result says so:
`[stopped after 50,112 entries in 0.1 s: results are partial; narrow the pattern or the directory]`, or
`No files found in the first 50,112 entries (0.1 s): …` when nothing matched yet. The walk is breadth first, so the files near
the top are the ones a partial result holds. A directory that does not exist is named together with the nearest one that does
(`src/lib/deep: no such file or directory (nearest existing directory: src)`); `grep`, `ls`, `read` and the `shell` working
directory say it the same way.

## What a result says when there is nothing to show

- Binary command output (an executable, an archive or an image sent to stdout: at least 10% of the characters are NUL, other
  control characters or bytes that are not UTF-8) reaches the model as one line, `[binary output: 13,224 bytes; not shown. Use
  file, xxd | head, or strings to inspect it]`, also in the live output, in `shell_output`, in `task_status` and in the exit
  notice of a background task. Colour codes, carriage returns, any script and a NUL-separated list (`find -print0`) are text.
  `read` refuses a binary file with the same advice and its size.
- A failing `shell` command ends with `[exit N]` (`[killed by SIGNAL]` when a signal ended it). When the exit code is 1, nothing
  was written to stderr and the last command is `grep`, `rg`, `diff`, `cmp`, `test`, `[` or `git grep`/`git diff`, the line says
  what that 1 means: `[exit 1: no match]`, `[exit 1: files differ]`, `[exit 1: false]` (`meta.expectedExit`). The call's status
  still follows the exit code.
- `webfetch` converts the page's main content when it marks one (`<main>`, `role="main"`, or its only `<article>`) with at
  least 200 characters of text, and the whole document otherwise; `nav`, `footer`, `select` and `dialog` elements are never
  content.
