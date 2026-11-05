# Code graph

Unless the [autopilot](#autopilot) is on (full tier; nightly, dev and local builds by default), the graph is built only on an explicit request, in a folder the [gate](#where-it-indexes) allows: when the model calls a graph tool, when the user presses `m` in the focused Galaxy panel to see the project's code ([code mode](sidebar.md#code-mode)), or once by itself when the Galaxy shows a session that has touched no code yet. Without `m` the Galaxy draws the session's own code graph from what its tools declared, and builds nothing: the files it read or changed and the symbols graph lookups returned, linked symbol to file and caller to callee, each node and link lighting up as it is used and fading over six seconds. Without the autopilot nothing else builds it: not opening a session or a page. Both refuse the home folder and the directories above it (not a project; nothing is indexed). `graph_context` is off until `/tier graph_context on` (balanced/full); on, it runs permission-gated `graph_map` orientation once per retained session context and project directory. The engine-injected orientation draws in the transcript as the code map card or as one muted row, `Code map · 7 dirs · 2,394 files · click or ctrl+o to open`. `codeMapCard` (Session chrome in `/customize`) chooses the default: `auto` opens the card in the full view and keeps the row in balanced, `open` and `folded` force either (the minimal view always keeps the row). A click on the card or row (or `ctrl+o`, for all cards) opens or folds that one card, and the reader's choice wins over the setting. The call is marked `injected` on its `item.started` meta, so a `graph_map` the model calls itself always keeps its card. The card is the ASCII project diagram alone at every level: its summary row (`7 dirs · 2,594 files · hubs: …`) and the directory and hub lists are not drawn, in any view or after `ctrl+o` (the folded row already counts dirs and files). They remain in the result the model reads and in the stored result and export (below); the terminal has no other view of them. Injection and token cost are unchanged. Successful native `edit`/`write` calls get a separate `graph_impact` card with cached pre-edit callers and importing files through two hops, without rescanning. The card identifies its snapshot and missing/unindexed files explicitly. Dynamic calls and new symbols may be missing: a small radius is not safety proof. Compaction may refresh orientation. Minimalist and peer turns skip automatic reads. Disable with `/tier graph_context off` or graph tool switches. Map/impact feed positive file-bytes/4 minus result-chars/4 estimates into `/usage` savings, not measured provider billing.

## Autopilot

Feature `graph_autopilot` (full tier; `/tier graph_autopilot on|off`). With it on, the sentence above changes: MendCode builds and refreshes the graph of a project by itself, so the model neither has to remember to ask nor gives up because none exists. **It is on by default only in nightly, dev and local builds** (the channel of the binary: `channelOfVersion` in `packages/upgrade/src/releases.ts`); in beta and stable it stays off until `/tier graph_autopilot on`, and minimalist and balanced never have it unless switched on. Off, everything above is exactly as before.

| What | How |
| --- | --- |
| Build | A session opens, a terminal connects in a folder, or a turn begins (`turn.started`) in an eligible project with no graph (in memory or as a cache file): `packages/codegraph/src/autopilot.ts` starts one background build through the shared indexer. One at a time per project (the indexer serialises per folder), cancellable (turning the feature off, `/graph off` or a folder that stops qualifying aborts it; shutdown aborts all), no turn waits for it. A failed build is not retried by turns for ten minutes. |
| Refresh | At a turn, at most once per two minutes per project (`CHECK_GAP_MS`), one walk and no scan compares every file's mtime, ctime and size with the cache. The walk adds up the **amount of code changed since the last index**, with no extra file read: for a new file its size, for a deleted file the size it had when indexed, for a modified file the larger of its size change (`|new size - indexed size|`) and `TOUCH_BYTES` = 200 bytes (about three lines), the latter never more than the file's own size. A same-size edit shows no size change, yet a file the disk says was written is not free, so it counts a small fixed amount instead of nothing or its whole size. When the sum reaches `REFRESH_BYTES` = 36 KiB, an incremental refresh scans only the changed files. The number comes from this repository: its non-test TypeScript is 15.3 MB in 248,000 lines, 61 bytes a line, so 36 KiB is about 600 lines (or nine files of the median 4.1 KB; 185 same-size touches). Because a file contributes at most what it holds (or the size it changed by), a few strings edited in a small file, however many times, never reach it; a new or rewritten large file, a deleted one or a broad change does. Below the budget nothing runs. A graph lookup still rescans whatever changed, so its answers are fresh between refreshes; the refresh only keeps the cached orientation (`graph_impact`, cache only) current and moves the scan out of the model's turn. |
| Eligible | The index gate's own verdict for the project's mode (`auto`: a folder inside a git repository below the home folder, or one with a project marker, under 10,000 files after the usual ignores; `/graph on` any folder; `/graph off` none), and never the filesystem root, an operating system folder (`/usr`, `/etc`, `/System`, `/Library`…) or a path through `node_modules`, `.git` or `.cache`. Never the home folder or a folder above it. Each decision is written once to the daemon log as `[GRAPH]: autopilot …`. |
| A lookup with no graph | `graph_find`, `graph_callers`, `graph_file_api`, `graph_map` and `code_search` (graph fallback) in an eligible project with no graph start the build and wait up to four seconds (`WAIT_MS`); a small project answers normally. A longer build answers at once, not as an error: `This project had no code graph; MendCode started building it in the background (42%, 310 of 740 files scanned). It is not ready yet: use grep, glob and read for now, and call this graph tool again in a minute or so.` The next call says `still building`. `graph_impact` (cache only) says the same instead of `no cached orientation`. A failed build says why and to use grep. |
| Status | The footer's GRAPH segment reads `indexing… 40%` while the first build scans (the daemon pushes every tenth, never per file) and `indexed` after it. |
| Prompt | One static line in the system prompt of focus, guide and full modes while `graph_find` is listed (`packages/daemon/prompts/graph-autopilot.md`, about 70 estimated tokens): the graph is built and kept fresh, locate code with `graph_find` (`source: true`), `graph_callers` or `graph_file_api` first and read only the spans they return, `grep` is for literal text, and a "still building" answer means grep meanwhile and retry. It never changes inside a turn, so it costs no cache. The tool descriptions of `read` and `grep` are not touched, for the same reason. |
| Sub-agents and other engines | Native sub-agents build their system prompt from the tools they are given, so one with the graph tools (`general`, `explore`) gets the same line and one without them none. Claude Code (its server instructions and its own sub-agents' `SubagentStart` context), Codex (its developer instructions) and ACP agents with HTTP MCP get the harness variant of the line appended to the instructions for `mcp__mendcode__graph_*`; it is added only while the feature is on and those tools are served. |
| Cost | Nothing for minimalist and balanced. In full, the line above and the build itself: the indexer already yields to the event loop every 50 files, keeps at most two project graphs in memory and drops an idle one after ten minutes. |

## Where it indexes

A folder is indexed only when its gate allows it (`createIndexGate` in `packages/codegraph/src/index-gate.ts`; the daemon checks it where indexing starts: a graph tool call and `codegraph.overview`). The mode is `codegraph_index` (`auto`, the default; `on`; `off`), set for every project with `/graph default on|off|auto` or the `Code graph index` row of `/customize` (Capabilities), and for one project with `/graph on|off|auto` (stored as `projectConfig[<dir>].codegraph_index`; `auto` removes the override). Bare `/graph` says what applies here. Nothing asks: no modal, no notification.

| Mode | Indexes |
| --- | --- |
| `auto` | A folder inside a git repository (a `.git` at it or above it, below the home folder), or a project folder without one (unpacked or never committed source: an `AGENTS.md`, `CLAUDE.md` or build manifest such as `package.json`, `go.mod`, `Cargo.toml` or `pyproject.toml` at its top), whose walk, after the usual ignores, stays under 10,000 files (`AUTO_INDEX_MAX_FILES`). The size is measured once and kept for ten minutes. |
| `on` | Any folder but the home folder and the directories above it. |
| `off` | Nothing. |

A skipped folder gives a reason: `off`, `home folder`, `no git repo`, `several repos` (a folder that is not a repository but holds two or more), `large folder`. The daemon publishes it as `codegraph.status {state: "skipped", reason}` when a session opens there and when the setting changes, and the footer's GRAPH row says it in one muted phrase, `graph off · large folder` (`graph off` for the user's own off). In a skipped folder the native engine does not list `graph_*` and `code_search` at all, so the model goes straight to `grep`/`glob`/`read`; a call that still arrives (another engine, a stale list) is refused with that reason and the advice to use them. The folder indexed is the session folder itself, not the repository root, so every `file:line` stays relative to where the session reads.

For semantic definitions, references, hover, symbols and call hierarchy from language servers, use the daemon's [`lsp` tool](lsp.md). The graph tools below remain the syntactic fallback.

Read-only tools that let the agent navigate a project by symbols and calls instead of reading files, plus a semantic `code_search` wrapper. They live in `packages/codegraph` (`@mendcode/codegraph`); the daemon adds them to a session's tool list with:

```ts
import { createCodeGraphTools } from "@mendcode/codegraph"

const tools = createCodeGraphTools({ cacheDir, jgBin?, now?, jgTimeoutMs?, onScan?, maxFiles? })
```

| Option | Meaning |
| --- | --- |
| `cacheDir` | Directory for the per-project JSON caches (required). |
| `jgBin` | The `jg` binary; default is `jg` on `PATH`. |
| `now` | Clock used for the cache timestamp; default `Date.now`. |
| `jgTimeoutMs` | Timeout of one `jg` run; default 60 000. |
| `onScan` | Called with the path of every file the own scanner reads (tests count re-scans through it). |
| `maxFiles` | Indexed-file cap; default 20 000. |
| `indexer` | An indexer made with `createIndexer` that the caller also uses elsewhere; the daemon shares one between the tools and `codegraph.overview`, so both read the same graph of a project. Default: a new one from the options above. |

## Overview for the Galaxy panel

`codegraph.overview {directory, limit?}` is the daemon command behind the Galaxy panel's code mode (`createCodeOverview({ indexer })` and `fileOverview({ graph, limit })` in `packages/codegraph/src/overview.ts`). It is sent when the user presses the mode key, or once for a session whose galaxy has nothing touched, and it builds or refreshes the index of `directory` like a graph tool does. The reply is one of:

| State | Meaning |
| --- | --- |
| `ready` | `files` (most connected first, then files with no links ordered by their symbols, so a project of scripts still lists its files), `edges` (`[from, to]` indexes into `files`: `from` imports `to` or calls into it), `total {files, symbols}`, `omittedEdges`, `partial`, `builtAt`. |
| `off` | Not a project (the home folder or above it), `MENDCODE_CODEGRAPH=0`, or the `codegraph` feature off. Nothing was indexed. `reason` says which. |
| `failed` | The build was tried and failed or was cancelled; `reason` is one line. |

A file is `{path, imports, importedBy, calls, degree, symbols, topImports, topImportedBy}`: `imports` and `importedBy` count resolved project files, `calls` the call edges that cross the file's boundary in either direction, and `degree` is the number of distinct files the file is joined to by any of those (an import and a call to the same file count once), which ranks the files. A file with no connection is left out. Caps (`CODEGRAPH_OVERVIEW` in `packages/protocol/src/codegraph-overview-data.ts`): 30 files (`limit` 1–30, default 24), 256 edges, 5 paths in each of `topImports` and `topImportedBy`, 240 characters per path, 200 per reason. Paths are relative to `directory`; one longer than the cap is left out, never cut. The command is not in the read-only set, so a read-only remote peer cannot start an index.

All six tools have permission `read` and follow the configured permission rules. Every result is bounded: at most 50 results, text cut to `OUTPUT_LIMITS`.

## Tools

A native model always has `graph_find`, `graph_callers` and `graph_file_api` in its tool list while the feature is on and the folder is indexed (above), in every tier that has it and with the [lean catalogue](tool-discovery.md): a model that cannot see them greps and reads whole files instead. Its system prompt says to find code with `graph_find`/`graph_callers` when they are listed and text with `grep`/`glob`, so a code question goes to the graph without the user asking for it. `graph_map`, `graph_impact` and `code_search` are found with `tool_search`. Claude Code gets them as `mcp__mendcode__graph_*` ([Claude Code](claude-code.md)) and is told to load them with one `ToolSearch` when its own client defers them.

| Tool | Arguments | Answers |
| --- | --- | --- |
| `graph_find` | `query`, `kind?`, `path?`, `limit?` (1-50, default 20), `source?` | Ranked symbols with `file:line`; `Class.method` works. `source: true` adds up to eight numbered source lines per match, with long lines/definitions clipped. Source is omitted if the file changed after indexing or resolves outside the project. |
| `graph_callers` | `symbol`, `direction?` (`in` default, or `out`), `depth?` (1-20 or `"all"`, default 1), `path?` | Breadth-first call chains, with depth and via symbol. `"all"` follows the full reachable graph, handles cycles, and counts all omitted descendants even beyond the 50-row output cap. |
| `graph_file_api` | `path` | One file's symbols with kind and line span (`L13-L16    method run`), exported marks, and the project files it imports. |
| `graph_map` | `path?`, `depth?` (1-3, default 2) | Directories with file counts per language, and the 20 hub symbols with the most callers. |
| `graph_impact` | `path`, `depth?` (1-20 or `"all"`, default 2) | Cached transitive callers (24 rows) and import dependents (12 files), including symbol-less barrels and type-only imports. Counts omitted results; never scans or rebuilds. |
| `code_search` | `query`, `path?` | A short summary and `file:line` hits from `jg`, or the graph fallback. `meta.engine` is `"jg"` or `"graph"`. |

`graph_find`, `graph_callers` and `graph_map` also return a `render` (renderSpec@1):

- `graph_find`: one `codemap` node: centre `search: <query>`, no left side, the matches on the right (`flow: "none"`, at most 50, the rest in `more`).
- `graph_callers`: one `codemap` node: centre = the symbol, `left` = callers, `right` = callees. The side the call asked about carries up to 50 entries with their hop `depth`; the other side carries up to 12 direct neighbours, so the map is complete even though the model's text answers one direction.
- `graph_map`: `stack[graph(root = project directory; top directories and hubs), text, detail(preview: hub table), detail(open: directories, hubs)]`. The terminal card draws the graph and the text only; the `detail` nodes stay in the spec for other renderers.

Graph nodes carry at most 24 edges and labels of at most 120 characters. A `codemap` entry is `{label, file?, line?, kind?, depth?}` and a side is `{title, entries, more?, flow?}` (`more` counts entries left out, `flow` is `in`, `out` or `none`); the protocol caps a side at 50 entries.

## Call map in the terminal

The terminal draws a `codemap` as a map, not a file list (`apps/cli/src/view/code-map.ts`):

```
┌renderToolCard · 7 callers · 16 callees──────────────────────────────────────────────────────┐
│ defaultBody   transcript:399            ◇⠒⠤⡀                   ⢀⠤⠒◇ cardRows           :254 │
│ ⠣ rowsOf      transcript:520               ⠘⢄                 ⢠⠊    ⠣ computerCard          │
│ chatView      transcript:700            ◇⠒⠒⠒⢚◆ renderToolCard ⡁     ⠣ wrapSpans             │
│ ⠣ layout      render:40                    ⡠⡎  tool-card:237  ⠹⡉⠒⠒◇ parseToolTitle     :101 │
│ toolCardTest  chat-transcript.test:7    ◇⠒⢊⠜                   ⠱⡀   ⠣ renderSpecLines       │
│ recallTest    tool-card-sessions.test:2 ◇⠒⠁                     ⠈⠒◇ parseDiff          :131 │
└+1 caller · +10 callees · ~12.4K tokens saved · ctrl+o───────────────────────────────────────┘
```

- MendCode v1's graph look: a thin square frame with the title set into its top edge and the status (left-out counts, the saved estimate, `ctrl+o`) into its bottom edge, so neither costs a row. Callers on the left, callees (or search matches) on the right, the symbol in the middle as an accent `◆` with its `kind · file:line` under it.
- Every direct neighbour is a `◇` (blue for functions, violet for types, green for values) joined to the centre by its own fine braille dot line, so the links fan out from the centre instead of running along a rail. A symbol shows its name and a muted `file:line` (the file without its extension, plus the fewest parent directories that tell two files apart; only `:line` in the centre's own file).
- A deeper hop hangs, indented, under the entry it was reached through, with a dotted `⠣` hook and no link of its own.
- Each side shows 6 rows (balanced view) or 12 (full view); the bottom edge counts what is left out, including what the tool itself left out. `ctrl+o` (tools expanded) shows every row the tool sent.
- Under 70 columns the map stacks along one spine (callers, centre, callees, each `◇` on it and deeper hops on a dotted bar); under 40 columns the frame is dropped; rows are always clipped to the width. `MENDCODE_GLYPHS=ascii` draws with ASCII only (`+-|` frame, `o` nodes, `@` centre, `.` links).
- The minimal view keeps the one-line tool row; `codegraph` itself is a balanced-tier feature (see [tiers](tiers.md)), so minimalist has neither the tools nor the map. Message rendering `plain` or `markdown` shows the text instead.
- graft's own `graft_trace_calls` (an MCP tool, so full tier) has no render spec; its text (`name · kind · path:L1-L2`, then `calls ← caller (path:L..)` and `calls → callee (path:L..) [depth N]` lines) is read back into the same map. Text in any other shape, and graft's other tools, stay as text.
- Frames for 60x20, 100x30 and 180x50 come from `apps/cli/test/code-map.test.ts` (`GRAFT_MAP_FRAMES=1`).
- Wide maps size each side to its visible content: the links give up width first, then complete names are reserved, then callers' file suffixes before callees' suffixes. Set `GRAFT_MAP_FRAMES_DIR` to select the frame output directory.
- `~N tokens saved` is the lookup's own estimate: the size of what the model would really have used instead, over four, minus the result it got. The footer's `~N saved` sums only `graph` savings of the current session and is absent until a graph tool has saved something there. See [how each saving is estimated](#how-the-saving-is-estimated).

## How the saving is estimated

Each tool is compared with the alternative a model has without the graph, never with whole files it would not have opened. The size of an alternative comes only from what the graph already holds (file size and line count, symbol spans, call edges); no file is read and nothing is run for the figure. An `rg -n` hit is priced as `path:line:` plus 50 bytes, the assumed length of a line (the graph records no line counts, so its cache does not grow; MendCode's own sources average 61 bytes, so 50 keeps the figure low for shorter lines). When an alternative cannot be sized, or the result is not smaller than it, the lookup reports no saving: it never goes negative and is never made up. Figures already stored are not recomputed.

| Tool | Alternative priced |
|---|---|
| `graph_find` | `rg -n <query>`: one hit per declaration whose name holds the query and one per distinct calling symbol of those declarations. With `source`, also reading each listed symbol's line range. More than 2,000 matches are not priced. |
| `graph_callers` `in` | `rg -n <symbol>`: the declaration lines and one hit per caller listed, at every depth. |
| `graph_callers` `out` | Reading the line range of the symbol, and of each callee that has callees listed. |
| `graph_file_api` | Reading the file whole. |
| `graph_impact` | `rg -n` hits for each caller and each importing file listed. |
| `graph_map` | None: an overview replaces no single read, so it reports no saving. |

The estimate is a floor for the greps: a symbol that calls the name twice, and mentions that are not calls (imports, comments), print more lines in `rg` than the graph counts. It can be above the real output when the declaration or call lines are shorter than the file's average line. The same figure feeds `meta.savedTokens`, the map card and `/usage` (source `graph`).

Command output filters (`ansi`, `tests`, `git`, `tsc`, `search`, `repeats`) are measured on the same text before and after the filter, bounded by the output limits: the saving is what the model would have been shown without the filter minus what it is shown with it, so a megabyte of colour codes counts as at most the cap, not a megabyte. graft's own `[graft] tokens saved` line is not counted anywhere (`/usage`, footer, map card): MendCode cannot verify it and its method compares with whole files.

## Indexing

The graph is built lazily on the first tool call for a project and is incremental: no timers, no watchers. Each normal graph lookup walks the project, compares every file's `mtimeMs`, `ctimeMs` and size with the cache and re-scans only files that are new or changed; deleted files drop their symbols and edges. This also detects same-size edits with a restored mtime. The scan stays stat-only, so a rewrite of the same length that lands in the same timestamp tick of a filesystem whose mtime and ctime are both coarse (some container overlays, network and FAT volumes) is not seen until the file changes again; hashing every file on each lookup is what it would take, and the walk does not do it. `source` excerpts also require the file's size to match what was indexed, so a changed file is never quoted from outdated line numbers. Workspace manifests and ignore rules are reread, so configuration edits re-resolve edges without rescanning unchanged source. Calls for the same project are serialised; an aborted call keeps the files it already scanned. `graph_impact` is the exception: it only uses the last in-memory snapshot. No manual build/sync is required, and the native indexer never rewrites Graft's own files. The [autopilot](#autopilot) adds no timers or watchers either: it acts when a session opens or a turn begins.

### Sources

1. **Graft wiring.** If `<cwd>/graft/.graph/wiring.json` exists, a file it covers is taken from it when neither the file's mtime nor ctime is newer than the wiring file. Wiring changes are detected by mtime, ctime and size. Nodes `{id, name, kind, path, span, exported}` become symbols (`span` is `"L12-L30"`; missing spans give a symbol without line), `imports` edges give file imports and `calls` edges give call edges with a known target. A file changed after the wiring was written, and any file the wiring does not cover, falls back to the own scanner.
2. **Own scanner**, no native parser. A masking pass blanks comments, strings, template literals and regex literals (keeping offsets); declarations are then found by regex at the top level (brace/paren depth 0) and their spans by brace matching.

| Language | Declarations | Imports |
| --- | --- | --- |
| `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | `function`, `class` (with methods and arrow properties), `interface`, `type`, `enum`, `namespace`, `const`/`let`/`var` (an arrow or function value is a `function`); `export { a as b }` marks exports | `Bun.Transpiler.scanImports`, plus a line regex for type-only imports and re-exports |
| `.py` | `def`, `async def`, `class`, methods directly inside a class | `import a, b`, `from x import y`, relative forms |
| `.go` | `func`, receiver methods, `type` (struct, interface, other), single `var`/`const` | `import "x"`, grouped imports |
| `.rs` | `fn`, `struct`, `enum`, `trait` (with its `fn`s), `union`, `type`, `mod`, `const`/`static`, `impl` blocks with their `fn`s | `use ...;` |
| `.swift` | `class`, `actor`, `struct`, `enum`, `protocol`, `extension` at any nesting with their `func` and `init` members; top-level `func`, `var`/`let`, `typealias`. Stored properties and locals are left out; everything not `private`/`fileprivate` counts as exported | `import X` |

Calls are attributed to their containing declarations. TS/JS named/default imports, aliases, namespace calls, destructured/namespace `require`, and named/star re-exports resolve through their actual bindings, including cyclic barrels. Conflicting star exports are dropped rather than inventing multiple targets. Module-level Python aliases and renamed imports are resolved too. Missing/external bindings never fall back to an unrelated global name; remaining Go/Rust/Graft name heuristics stay within the same language and require a unique global candidate when neither local nor imported candidates exist.

`this.f()`, `self.f()` and Go receiver calls resolve to sibling methods; `Type.f()` / `Type::f()` resolve to known types. Imported class aliases and namespace calls are supported, as are optional TS/JS calls (`f?.()`, `ns?.f()`). Unknown receivers (`obj.f()`, `JSON.parse()`) are not treated as project functions. Explicit Graft target ids that disappeared do not fall back to name guesses.

Relative script imports support extension substitution (`.js` → `.ts`, `.mjs` → `.mts`, `.cjs` → `.cts`). Workspace packages are discovered from project `package.json` files, without installing dependencies: `exports` conditions and wildcard subpaths, or `source`/`types`/`module`/`main` entrypoints, resolve only to indexed project files. Private/blocked subpaths and targets escaping a package are not followed. Conditions are a source-first navigation heuristic, not a runtime module loader.

Skipped: `node_modules`, `.git`, `dist`, `build`, `graft`, `__pycache__`, `coverage`, hidden directories, `target` next to a `Cargo.toml`, `*.min.*`, files over 512 KB, files with NUL bytes, symlinks, and `.gitignore` matches. Root and nested ignore files support ordered `!` negations, directory-relative anchors, globs and escaped leading `#`/`!`. Like Git, negating a child cannot reinclude it while its parent directory remains ignored. Hard-skipped directories cannot be re-enabled. This is a bounded source walker, not a full Git implementation (no global excludes or tracked-file overrides).

### Cache

`cacheDir/<first 16 hex of sha1(cwd)>.json`, written atomically (temp file and rename) whenever something changed:

```json
{
  "version": 2,
  "cwd": "/abs/project",
  "builtAt": 1700000000000,
  "graftMtimeMs": null,
  "graftStamp": null,
  "packages": [],
  "partial": false,
  "files": {
    "src/a.ts": {
      "mtimeMs": 1700000000000.5,
      "ctimeMs": 1700000000000.5,
      "size": 412,
      "language": "typescript",
      "source": "scan",
      "imports": ["./b"],
      "bindings": [{ "local": "helper", "imported": "helper", "source": "./b" }],
      "exports": [{ "exported": "main", "local": "main" }],
      "symbols": [{ "name": "main", "kind": "function", "start": 3, "end": 6, "exported": true }],
      "calls": [{ "from": 0, "name": "helper" }]
    }
  }
}
```

`source` is `"scan"` or `"graft"`. `calls[].from` indexes `symbols`; a call may carry `self`, `qualifier` (+ `dot`) or, from graft, a `target` id. Name resolution happens when the graph is derived, so a change in one file can change the edges of another without re-scanning it. A cache with another `version` or `cwd`, malformed per-file records/bindings, or invalid JSON is ignored and rebuilt automatically. Version 1 caches therefore migrate by rebuilding once, without user action.

### Cap

At most 20 000 files are indexed by default (in directory order). Reaching the configured cap, oversized source files, unreadable directories/files, or scan failures mark coverage `partial`. Other directories are still visited after an oversized/unreadable entry. Results carry `meta.partial = true` and report the actual indexed-file count rather than always claiming a 20 000-file cap.

## code_search

If `jg` is found (`jgBin`, else `PATH`), it runs as `jg <query> <path>` in its own process group, with `cwd` the project root and `path` the project (or the requested subpath, which must stay inside the project). The environment is only `PATH`, `HOME` and whichever of `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY` the user's environment already has. The group is killed after 60 s, when the turn is cancelled, or when output passes 512 KB.

jg's plain-text output is split into a summary (prose lines, at most 1500 characters) and hits (`path:line[:col] text`, up to 50, absolute paths made project-relative).

If `jg` is missing, exits non-zero, times out, or prints nothing readable, `code_search` falls back to the graph and says why (`[graph search: jg timed out after 60 s]`, `meta.fallback`). The fallback ranks symbols by the query's words (with simple plural/`-ed`/`-ing` stems), then runs a bounded case-insensitive literal search (20 hits, 3 000 files) over indexed files, first for the whole query and, when that finds nothing, for its words. A cancelled turn returns `cancelled` and kills `jg` without falling back.

## Known limits

- This is syntactic navigation, not type/lexical-scope analysis: parameter/local shadowing, dynamic dispatch, inferred instance methods, callbacks and computed properties are not fully resolved. Go/Rust retain name heuristics. Treat `graph_callers` as a fast map, never a proof of no callers; use LSP and tests for semantic verification.
- Declarations are found at line starts: two declarations on one line, or a declaration after `;` on the same line, are missed. Nested functions inside a function body are not symbols (the own scanner); calls inside them count for the enclosing function. Object-literal methods (`{ run() {} }`) are not symbols.
- `tsconfig.paths`, runtime module-loader conditions, anonymous default declarations, complex CommonJS assignments, Python star/local imports and namespace re-exports are not fully resolved. Go/Rust module paths are recorded but not linked to files. Re-export resolution is cycle-safe and limited to 64 levels.
- JSX text containing an apostrophe can confuse string masking for the rest of that line only.
- `jg` output parsing is heuristic (plain text); an unknown format still surfaces as a summary.
- Graft spans are whatever Graft recorded; missing/invalid spans are listed without a line number.

## Verification

`bun test packages/codegraph/test packages/engine-native/test/graph-context.test.ts packages/daemon/test/tier.test.ts` covers binding resolution, workspace manifest changes, full traversal/cycle/truncation accounting, cached transitive impact, incremental/aborted/concurrent indexing, corrupt-cache recovery, nested ignores, bounded source excerpts, and native tier/permission integration. Tool schemas remain inside the existing per-tier token budgets.

## A path in another project

A graph tool given a `path` outside the session's project (an attached or added folder) answers from the graph of the project that
holds it when that project was indexed before, in memory or as a cache file: the answer starts `From the code graph of <folder>` and
its paths are relative to that folder. A folder nobody indexed is never indexed for this; the tool says the path is outside the
project and that read, glob and grep reach it. The path is judged first as an external-directory read, like any other tool's.
