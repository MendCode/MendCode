# Tool discovery

Tool discovery lets native sessions find secondary tools locally instead of sending every schema with every model call. Returned tools become callable on the next model step.

## Enable discovery

Native sessions can opt in through `settings.set`:

```json
{"type":"settings.set","patch":{"experimental":{"tool_discovery":true}}}
```

| Setting or condition | Effect |
|---|---|
| Native full-tier session with MCP enabled | Discovery defaults on |
| Other tiers and legacy settings | Stay opt-in |
| `experimental.tool_discovery: false` | Restore the complete permission-filtered catalog |
| Reset `experimental` | Return to the tier default |

**Warning:** A settings patch replaces the whole object. Include any existing `primary_tools` and `continue_loop_on_deny` values when changing discovery.

Settings persist in the daemon and apply on the next model step. External engines keep their own catalogs.

## Find and use a tool

1. Call `tool_search({query, limit?})` to search names and descriptions locally.
2. Use a returned tool on the next model step. Lookup reads schemas only; it does not invoke the tool.

### What stays visible

| Tool group | Discovery behavior |
|---|---|
| Core tools | Stay visible: file and shell operations (including `shell_session`, `shell_monitor`, `sleep` and `notebook_edit`), background status, tasks, questions, plans, goals, todo, skills, memory, loops, workflows, review, sessions, web tools, image generation, LSP and secret markers |
| Other built-ins, MCP tools, custom tools and extension tools | Secondary |

`experimental.primary_tools` still means **main agent only**. It does not promote tools into the discovery primary set.

### Search order and limits

Exact names rank before name fragments, then description matches. Equal scores sort by name. Empty queries list names alphabetically.

| Limit | Value |
|---|---|
| Query | At most 500 characters and 16 search words |
| Results requested | 1–8, default 5 |
| Description | Stops at 3,000 characters |
| Entire UTF-8 result | Fits 24 KiB |
| Secondary-tool slots per session | 64 |

The result is `{tools: [{name, description, inputSchema}],
omitted}`. Oversized schemas and matches beyond the session's slots are counted in `omitted`.

### History and permissions

The daemon stores discovery receipts in native tool history, so they survive restarts and later turns in the same session. Retained legacy tool calls activate their schemas too.

Compaction discards old receipts along with old tool history. Sessions and inline child agents have separate discovery contexts.

Lookup never invokes an MCP service or a tool, changes an approval or grants permission. Tool/path rules, agent restrictions, main-only tools and execution approvals remain in force.

If lookup itself is disabled by tool or agent rules, eligible tools remain directly visible.

The chat uses existing tool rows; Ctrl+O expands the JSON receipt. No new page or sidebar is required.

B71 adds opt-in [Code Mode](code-mode.md), using this catalog and retaining every nested tool's native permissions.

## Lean catalogue and plan tools (tier defaults)

Every tool schema is sent with every model call, so the catalogue is most of a short task's input. In the gpt-6-luna evaluation, 55 tools were 92.7 KB of schemas: about 20 K tokens per call, 89 % of all input tokens.

A coding turn uses about a dozen tools. The features below cut the request down; each follows the tier and reverts alone (`/tier <id> on|off`, or `features.<id>` in settings). With no tier set nothing changes.

| Feature | Tier default | What it does | Revert |
|---|---|---|---|
| `lean_tools` | on with every tier | Lists only the coding core (`shell`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, `shell_output`, `shell_kill`, `task`, `task_status`, `skill`, `webfetch`, `question`, the three plan-mode tools, `code`/`snip` when enabled, and with the feature `codegraph` the lookups `graph_find`, `graph_callers` and `graph_file_api`) and `tool_search`. `ls` is not in it (`read` lists a directory). Workflows, loops, worktrees, memory, sessions, notebooks, LSP, images, MCP and the rest are found with `tool_search`. | `features.lean_tools: false` (the discovery set above applies when `tool_discovery` is on) |
| `aux_tools` | off with every tier (on with no tier) | Keeps the situational tools of the core in every request: `shell_output`, `shell_kill`, `task_status`, `webfetch`, `question` and the three plan-mode tools. Off, nothing is removed: each one is listed without a search as soon as the conversation calls for it (the plan tools while the session is in plan mode, `shell_output` and `shell_kill` once a command was started in the background, `task_status` once a sub-agent was launched), and `tool_search` finds any of them before that. | `/tier aux_tools on` |
| `find_tools` | on with every tier, and with no tier | Keeps `glob` and `grep` in every request. Minimalist without them sent a 864-token first request, under OpenAI's 1,024-token minimum cacheable prompt: the second request of every session was paid in full and, over 36 evaluation runs, uncached input rose 12 % although the first request shrank. With them it is 1,064, still below pi. Off, `shell` searches with `rg` and `tool_search` finds them. | `/tier find_tools off` |
| `ui_tool` | on with `balanced` and `full`, and with no tier | Keeps `customize_ui` (the user's own screen) in every request: measured with gpt-6-luna on 20 requests like "hide the footer", deferred it was found and used in 14 of 20, the rest looked in the project; listed, 20 of 20. Minimalist defers it. | `/tier ui_tool on` |
| `plan_tools` | off with every tier (on with no tier) | Keeps `todo` and the goal tools (`get_goal`, `create_goal`, `update_goal`) in every request. The goal tools do not need it to finish a goal: while a session has an unfinished goal (any status but `complete` and `budget_limited`) they are listed whatever this says, because the continuation text tells the model to call `update_goal`; a session without a goal pays nothing. The three schemas are 2,010 characters (about 420 tokens at 0.21 per character), which `plan_tools` would add to the first request of every session. A one-turn coding task does not use them (13 `todo` and 1 `update_goal` calls in 36 evaluation runs, the latter an error); `tool_search` finds them. `todo` itself is listed in balanced and full by `visible_plan` ([the visible plan](layout.md#the-visible-plan)): deferred, the model kept a list in 21 % of sessions with five or more edits. Minimalist has no `todo` at all. | `features.plan_tools: true` |

### First-request tools and tokens

With no MCP and no skills, the first request of a fresh session lists:

| Tier | Tools |
|---|---|
| Minimalist | `read`, `write`, `edit`, `apply_patch`, `shell`, `glob`, `grep` and `tool_search` |
| Balanced and full | Those tools, the three graph lookups and `task` |

The ChatGPT backend measurements below use gpt-6-luna and provider-reported input tokens for "Reply with the single word ok" (`.agents/evals/harness/first-request.ts`):

| Tier or comparison | Input tokens |
|---|---|
| Minimalist | 1,104 → 1,064 |
| Balanced | 3,256 → 2,421 |
| Full | 4,734 → 3,433 |
| pi 0.85.1 with its four tools | 1,188 |

`packages/engine-native/test/lean-catalog.test.ts` finds every deferred core tool with `tool_search` in each tier. It checks that the tool joins the request with the very schema it had when always listed.

`experimental.tool_discovery: false` beats them all: the complete catalogue, as before. A deferred tool called by name is refused once as an unknown tool and listed from the next call on. Finding it with `tool_search` first saves that step.

### Cache behavior and measured sizes

Discovered tools are appended at the end of the tool list in discovery order, with `tool_search` right before them. Tools listed before keep their bytes and the cache key does not change.

The call right after a find still reads the system prompt and conversation uncached, once. Providers place the tool list before both, and a longer list ends the cached prefix there; see [prompt cache](prompt-cache.md).

The ChatGPT backend is the exception; see "Deferred loading on the ChatGPT backend" below. The harness's own `graph_map` and `graph_impact` notes never list a schema.

The following first-request sizes measure chars of tool JSON, then tokens at 0.21 per char, plus a system prompt of 0.5 to 0.9 K tokens:

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

On the ChatGPT subscription (`https://chatgpt.com/backend-api/codex`), the Responses adapter sends `tool_search` as the API's own client-executed tool search. A found tool never joins the `tools` array.

MendCode still runs the search itself, with the same catalogue, limits and permissions. Only the wire shape differs:

| Where | Function shape (every other provider) | Client-executed shape (ChatGPT backend) |
|---|---|---|
| `tools` | `{type: "function", name: "mendcode_tool_search", …}`, then each found tool appended | `{type: "tool_search", execution: "client", description, parameters}`; found tools are not listed |
| The model's search | `function_call` named `mendcode_tool_search`, `arguments` a JSON string | `{type: "tool_search_call", call_id, execution: "client", arguments: {query, limit?}, status}`, `arguments` an object |
| The result in `input` | `function_call_output` with the JSON receipt | `{type: "tool_search_output", call_id, status: "completed", execution: "client", tools: [{type: "function", name, description, parameters, strict: false, defer_loading: true}]}` |

### Repeated searches

A found tool is defined once, in the result of the first successful search that names it. A later search keeps that earlier result unchanged and loads only new tools.

For tools already defined by a search, the adapter appends a short developer message after the new `tool_search_output`: `Tools already loaded: <names>. Use their earlier definitions; they remain available.`

This distinguishes a repeated find from an empty search without duplicating definitions or adding unsupported fields to the API result. Failed and empty searches add no notice. A search that only finds listed tools still sends `tools: []`.

The model does not see the receipt's `omitted` count in this shape. Tools activated without a search result in history, found inside `code` or called by name and refused once, still append to `tools` with the one uncached call that costs.

The native compaction endpoint (`/responses/compact`) keeps receiving the function shape: the canary did not cover it.

### Fallback and other hosts

1. If a backend answers 400 or 422 to this shape, the adapter repeats the same call in the function shape, once, in the same turn.
2. If that second request is answered, the session, per model, stays on the function shape for the daemon's lifetime, with no further attempt.
3. If the second request is refused too, its error is reported and nothing is remembered.

A 5xx or network failure is retried as before and never switches the shape. `api.openai.com` and other Responses hosts stay on the function shape: the public API documents the same items for its newest models only, and no call was made there.

`clientToolSearch: true` on `createResponsesProvider` turns it on for a host.

### Live canary

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

Appending one tool cost the whole prefix: call 3 read 0 of 5,726 from cache. Loading it through the search result cost nothing: call 5 read 5,504 of 5,893, the same as the plain repeat in call 2.

Only this model was tried.

## Fewer round trips: reads, patches and the orientation block

The other half of the gap is calls, not size. In 36 evaluation runs, 56 % of read-only exploration steps could have shared a call with a neighbour: 94 of 166 calls were savable.

The model searched for `AGENTS.md` 14 times although the system prompt already carried it, and listed directories 17 times. Three changes each revert alone:

| Change | What it does | Revert |
|---|---|---|
| Multi-path `read` | `read` takes `paths: [{path, offset?, limit?}]` (up to 64; one 120 KB output budget and one 80 MiB budget for attached images and PDFs are the real bounds); each file is a `=== path ===` section, a bad path is reported in its section and only fails the call when every path failed. Once a budget is spent the call ends with one `[not read: …]` marker that lists every path left, one per line, for the next call. Permission rules are checked per path. | The system text decides what the model is told; `read` with a single `path` is unchanged |
| `apply_patch` as the edit path | The system text names `apply_patch` for one or several files (no earlier `read` needed when the model has the text), `edit` for one replacement, `write` for new files. A hunk that does not match names the closest line. Hunks are matched against the file as it is on disk: out of file order they still apply when they fit exactly one unclaimed place (several places or an overlap with another hunk is an error that says so), a hunk that changes nothing (context only, or the same lines removed and added) is an anchor that says where the next hunk goes, and a file whose hunks change nothing at all is an error instead of a reported `M`, except with `*** Move to:`, where the rename is the change. Any error leaves every file of the patch untouched. | Revert the wording in `packages/engine-native/prompts/system.md` (lines 3 to 6) |
| `orientation` (tier balanced and up) | The first user message of a main session starts with an `<orientation>` block: cwd, git branch, package manager and test command from `package.json` (or Cargo, Go), the project instruction files the system prompt already holds, and the top two levels of the tree (at most 150 paths, ignoring `.gitignore` plain names and `node_modules`, `dist`, `build` and the like; at most 6,000 characters). Built once, kept in the history, never in the cached system prefix. | `/tier orientation off` or `features.orientation: false` |

### Search several patterns

`glob` saves calls the same way. A pattern may use brace alternatives (`{src,test}/**/*.ts`), and `patterns` (up to 32) merges several globs into one newest-first list without duplicates under the same 1,000-file cap.

Each pattern is matched against the `glob` permission rules. The single `pattern` form is unchanged.

### Read search context

`grep` takes `context` (0 to 5). Lines around each match come back in rg's shape: `path-line-text` beside the matching `path:line:text`, with `--` between groups that do not touch. A search often replaces the read that would follow it.

Both backends, ripgrep and the built-in walker, print the same lines. The 500-match cap, `meta.matches` and the tool card count matching lines only.

### Replace several strings

`edit` takes `edits: [{oldString, newString}]`, up to 50, for several replacements in one file:

1. Replacements run in order on one read; each sees what previous ones wrote.
2. Each gets the CRLF and trailing-space near misses of a single edit.
3. The first failure stops the call before anything is written: `edit 2 of 3: oldString not found in f.ts; nothing was written`.

A top-level `oldString`/`newString` pair runs first when both are given. `replaceAll` covers every replacement of the call.

### Patch matching and diagnostics

`apply_patch` also places a hunk whose lines differ from the file only in runs of whitespace inside a line. A context line matched that way, or by indentation or trailing spaces, keeps the file's own text: only `-` and `+` lines change the file.

A multi-line hunk that does not match adds the file around its closest line, numbered, with `>` on the first line that differs, at most 16 rows.

### Schema cost

The two arguments cost no context: `context` and the entries of `edits` carry no descriptions of their own; an entry repeats the top-level keys.

Descriptions that only restated their tool's were cut: `read`'s `paths`, `glob`'s `patterns`, and the `patch` of `apply_patch`.

Measured on 2026-10-31 with the tier test's tool pool, minimalist's first request (system prompt and tool definitions, lean catalogue) is 5,378 characters where it was 5,381. Tier baselines are 3,353 / 4,808 / 6,111 estimated tokens where they were 3,354 / 4,808 / 6,111.

### Bounded directory walks

`glob` walks the tree itself and bounds the walk. It starts at the pattern's fixed directories (`src/lib/**` reads only `src/lib`) and, without `**`, stays at the pattern's depth.

`node_modules`, `.git`, hidden files and directories and, on macOS, `~/Library` are not listed unless the pattern names them: `.github/**/*.yml`, `node_modules/zod/**`.

After 50,000 directory entries or 5 s, the bounds of the daemon's file search fallback, the walk stops. The result says so:

- `[stopped after 50,112 entries in 0.1 s: results are partial; narrow the pattern or the directory]`
- `No files found in the first 50,112 entries (0.1 s): …` when nothing matched yet.

The walk is breadth first, so files near the top are the ones a partial result holds.

A missing directory is named with the nearest one that exists: `src/lib/deep: no such file or directory (nearest existing directory: src)`. `grep`, `ls`, `read` and the `shell` working directory say it the same way.

## What a result says when there is nothing to show

### Binary output

Binary command output is an executable, archive or image sent to stdout where at least 10% of characters are NUL, other control characters or bytes that are not UTF-8. It reaches the model as one line:

`[binary output: 13,224 bytes; not shown. Use
  file, xxd | head, or strings to inspect it]`

The same line appears in live output, `shell_output`, `task_status` and a background task's exit notice. `read` refuses a binary file with the same advice and its size.

Colour codes, carriage returns, any script and a NUL-separated list (`find -print0`) are text.

### Command exit status

A failing `shell` command ends with `[exit N]`, or `[killed by SIGNAL]` when a signal ended it. The call's status still follows the exit code.

When the exit code is 1, nothing was written to stderr and the last command is `grep`, `rg`, `diff`, `cmp`, `test`, `[` or `git grep`/`git diff`, the line explains that 1:

| Meaning | Output |
|---|---|
| No match | `[exit 1: no match]` |
| Files differ | `[exit 1: files differ]` |
| False | `[exit 1: false]` |

These use `meta.expectedExit`.

### Web content

`webfetch` converts a page's main content when it marks one (`<main>`, `role="main"`, or its only `<article>`) with at least 200 characters of text. Otherwise it converts the whole document.

`nav`, `footer`, `select` and `dialog` elements are never content.

## Implementation and earlier decisions

OpenAI Responses uses `mendcode_tool_search` at the wire boundary and `tool_search` in host history. Both names are reserved from extension registration. The ChatGPT backend gets the API's own tool search instead; see "Deferred loading on the ChatGPT backend".

Invalid stored search arguments stop replay without rewriting history. The ChatGPT implementation uses `searchLoads` and `toResponsesInput` in `packages/engine-native/src/openai-responses.ts`, with tests in `packages/engine-native/test/cache-discovery.test.ts`.

B26 decisions were opt-in/off by default; v1 primary capabilities mapped to v2 names; local, bounded lookup without a service timeout or a new listener.
