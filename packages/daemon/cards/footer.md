---
summary: footer rows, icons, presets by settings; code only for data MendCode lacks
docs: extensions-tui, customize
aliases: statusline, status-line, status, statusbar
---
Multi-row footers are settings (footerRows, presets, icons); an extension is only for data MendCode does not have. Use what is built in first. To copy another tool's status line (Pi, Claude Code, Codex), map each part to a built-in segment or to MendCode's usage data ({{program}} docs usage), keep its icons (footerIcons), and tell the user which parts have no source (shown as unavailable). Apply at once, do not ask first: /footer reset undoes it. Never read another program's files or caches: MendCode's own readings are the only source, and a window it does not know is unknown. Footer rows stay under the prompt, never in prompt.above.

A. Settings only, no file (customize_ui settings, or the user's /footer → [[setting:footer]]):
  The five-row layout (preset rows): footerRows [["directory","text:tagline"],["model","effort","context","cache","tokens"],["quota:codex"],["quota:claude"],["codegraph"]], footerText {"tagline":"keep the contract"} (text:NAME reads footerText.NAME), footerIcons nerd|glyph|none.
  Up to 12 rows, a quarter of the terminal height; a row that does not fit loses its last segments. /footer preset classic|rows|compact|telemetry, /footer reset.
  Segments: directory branch model effort (:JEV when adaptive) context cache tokens quota quota:codex quota:claude codegraph time text:name state permission today cost goal jobs sandbox vim update ttft tps spend forecast ctx hit think calls notice. codegraph shows files, symbols, edges once a graph tool indexed the project. No source: "synced".
  quota: a bar and % left per window; an ended window is n/a, an old reading is dimmed with its age (62% left ~2d), a fresh one keeps its reset countdown. quotaView used|left, quotaColor pressure|accent.
  quotaRefresh (off; {{program}} docs usage) spends quota on a timer: set it when the user asks for live usage, else offer it.

B. A script (any language). <data dir>/statusline.json (a project's .mendcode/statusline.json after /tools trust):
  { "right": { "command": ["./status.sh"], "refreshMs": 5000, "timeoutMs": 1500 } }
"left" works the same; "enabled": false switches a side off. command is argv, no shell; ./ is relative to the file's folder. refreshMs >= 1000. It prints plain text (first line), JSON {"segments":[{"text":"dev","fg":"#86efac"}]} or up to 4 rows {"rows":[[{"text":"a"}],[{"text":"b"}]]}. Env: MENDCODE_USAGE_JSON.

C. An extension with a slot (JavaScript). customize_ui {"action":"write","file":"footer.ts","content":"..."} with
  export default { name: "footer", tui(api) { api.slot("footer.right", ({ branch, usage }) => [[{ text: branch ?? "", fg: "muted" }]]) } }
Slots: footer.left, footer.right (up to 12 rows) and footer.replace (the whole footer). The callback gets width, height, now, directory, branch, state, stats and usage and returns rows of spans {text, fg, bg, bold, dim}; fg and bg are theme roles or #rrggbb. Fast and pure (4 ms). A load error comes back in the tool result: fix it with action "edit". More: {{program}} docs extensions.
