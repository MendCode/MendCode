---
summary: change the color theme, or write and install a theme file
docs: customize, automation
aliases: themes, colors, colours, palette
---
Change the theme (a built-in, or a theme file already installed):
  customize_ui {"action":"settings","values":{"theme":"<name>"}}   (the profile key [[setting:theme]]; a project can have its own, [[setting:projectThemes]])
Not in your tool list (minimalist): tool_search finds customize_ui. It applies live to every terminal. The user's own way: /theme <name> (picker: /theme or ctrl+x t). "system" follows the terminal's light/dark mode.
{{program}} theme select <name> [--scope user|project] (the user's terminal; refused from your shell, like theme install) only selects a theme FILE (themes/<name>.json in the data dir, or in <project>/.mendcode for project scope); it cannot select a built-in.

Write a theme: <data dir>/themes/<name>.json (name: letters, digits, dot, underscore, hyphen, up to 40). A file of the same name replaces a built-in.
{
  "label": "Forest", "dark": true, "background": "#0b1210",
  "colors": { "primary": "#22c55e", "text": "#e5e7eb", "body": "#d1d5db", "muted": "#6b7280", "border": "#374151",
    "heading": "#a78bfa", "code": "#fbbf24", "link": "#60a5fa", "success": "#22c55e", "warning": "#f59e0b", "error": "#ef4444" }
}
These 11 colors are required, as #rrggbb. Optional: accent, secondary, info, borderActive (text roles) and panel, element, diffAddedBg, diffRemovedBg (fills behind text). Missing ones are derived; text roles are raised to readable contrast.
Check a file: {{program}} theme validate <file>. Install a copy: {{program}} theme install <file> [--name N] [--scope user|project]. After writing the file, select it as above (the file is re-read on selection).
Single Markdown colors over any theme: profile key markdownColors, e.g. {"mdHeading1":"#ff8800"}.
A package can carry themes too: {{program}} docs packages.
