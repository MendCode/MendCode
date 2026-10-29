---
summary: add a custom tool the model can call, with its own display
docs: extensions, hooks, tool-discovery, code-mode
aliases: tool, custom-tools, custom-tool, tool-define, render, tool-search, lean, discovery
---
Smallest path: the tool_define tool (find it with tool_search). It validates, writes a script plus manifest, and can run it once on sample arguments. The user approves it. Files land in <data dir>/tools/ (all projects) or <project>/.mendcode/tools/ (usable after the user trusts the project in /tools). The model sees it as custom__<name>; it is callable from the next message, no restart.

By hand: tools/<name>.json (name: letters, digits, _, -, up to 40) next to its script:
  { "description": "What it does and when to call it.", "command": ["bun", "./tool.ts"], "input": "stdin",
    "args": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] },
    "timeoutMs": 60000, "cwd": "project", "render": { "type": "text", "text": "{{result.summary}}" } }
- command is argv, no shell; a part starting ./ or ../ is relative to the manifest's folder.
- input "stdin" (default) sends the arguments as one JSON line; "argv" appends them as the last argument.
- stdout is the result; print JSON to bind fields in render. Non-zero exit is a failed call. Keep output small: it goes back to the model.
- Env: MENDCODE_PROJECT_DIR, MENDCODE_TOOL_DIR, MENDCODE_TOOL_NAME.

render is data, never code. {{args.x}} and {{result.a.0.b}} bind the call's arguments and the parsed stdout (a whole-string binding keeps its type). { "$each": "{{result.items}}", "map": <node> } repeats a node per item with {{item.x}}. Limits: depth 6, 200 nodes.
Nodes: stack {children, gap} - row {children 1-4, weights} - box {title, children} - text {text, tone, bold, dim} - badge {text, tone} - code {text} - diff {text} - progress {value, max, label, tone} - sparkline {values, label, tone} - table {columns up to 8, rows up to 50} - kv {items: [{key, value, tone}]} - list {items, ordered}.
Tones: text, muted, primary, accent, secondary, info, success, warning, error, heading, code.
Turn one tool off for a project or everywhere: the user's settings key [[setting:tools]] { "name": false }.
Which tools you have: the list is lean (feature lean_tools, every tier): the coding core plus tool_search, which finds the rest by name or purpose (memory, workflows, loops, worktrees, notebook_edit, MCP tools). Search before saying one does not exist; /tier lean_tools off lists all at a token cost. glob, grep (feature find_tools) always listed; customize_ui (feature ui_tool) from balanced. Deferred MCP tools (feature and flag tool_discovery, full tier) work the same way. Code Mode (feature code_mode, flag code_mode, full tier, off until the user sets the flag) gives one code tool: confined JavaScript that calls tools.<name>(input) and returns only the selected value. Output filters (feature output_filters, balanced; [[setting:tool_output]] filters) condense ANSI noise and passing tests; the full output stays on disk.
Instead of a script, a tool can also come from an extension (api.registerTool, {{program}} docs extensions) or an MCP server ({{program}} docs mcp). The user lists tools and trust in /tools.
