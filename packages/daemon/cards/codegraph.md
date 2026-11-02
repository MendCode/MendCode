---
summary: find symbols and callers by graph, language servers, and the code map card
docs: code-graph, lsp, formatters
aliases: graph, callers, symbols, lsp, code-map, definition, references, impact, diagnostics
---
For: "who calls this function", "where is X defined", "what breaks if I change this file", "give me the structure of the project", "type errors".

Model tools (TS/JS/Py/Go/Rust/Swift; read-only, no approval; feature codegraph, tier balanced; MENDCODE_CODEGRAPH=0 turns it off; the live line says if on):
  graph_find {query, kind?, path?, limit?, source?}: ranked symbols with file:line; Class.method works; source: true adds up to 8 numbered lines per match.
  graph_callers {symbol, direction: in|out, depth: 1-20|"all", path?}: call chains. graph_file_api {path}: one file's symbols with line spans, exports and imports.
  graph_map {path?, depth?}: directories with file counts per language and the 20 hub symbols. graph_impact {path, depth?}: cached transitive callers and importers; never rebuilds.
  code_search {query, path?}: text hits with file:line from jg when installed, else the graph fallback (its reason is in the result).
  lsp {operation, filePath, line, character, query?}: semantic goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation and call hierarchy from language servers; diagnostics lists their errors. Servers start from .mendcode/lsp.json (false disables); a request times out after 4 s.
All results are bounded (50 rows).

When: ask the graph before reading many files, and the language server when correctness matters. A caller list is a map, never proof that nothing else calls it: dynamic dispatch, callbacks, tsconfig paths, object-literal methods and a second declaration on one line are not resolved. Say so when the answer depends on it; confirm with lsp, grep or tests.

Indexed on a graph call or m in /panel galaxy, never home or up. auto: git repo folders under 10,000 files; elsewhere graph tools are unlisted (footer: graph off · reason). /graph on|off|auto: this project; /graph default: all ([[setting:codegraph_index]]). Orientation is off by default: /tier graph_context on (balanced, full) adds a code map once per session, as a card or one row; [[setting:codeMapCard]] auto|open|folded sets it (ctrl+o or a click opens one).

Autopilot (graph_autopilot, full; nightly/dev/local by default, else /tier graph_autopilot on): MendCode builds and refreshes the graph itself; a tool with none yet says "building, N%": grep meanwhile, retry.

Data honesty: the index is a per-project cache of files on disk; a symbol added a moment ago may be missing until the next scan, and a file changed since returns no source excerpt. Cap: 20,000 files. If a tool says it is unavailable, use grep and read, and say you did.

Formatting: successful write, edit and apply_patch calls format the written file when .mendcode/formatter.json enables it (true for the builtins, or custom argv commands with $FILE), then report errors of running language servers (one installed starts after a write; MENDCODE_LSP_WARMUP=0: off). A failure appends a Formatting: section; the edit still succeeded.

Check: every hit has file:line; read the line before relying on it.
