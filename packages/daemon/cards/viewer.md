---
summary: open a file or folder in the viewer beside the chat; click a path; diagrams
docs: file-viewer, mermaid, changes
aliases: file-viewer, open, path-click, preview, mermaid, diagram, pathclick
---
For: "open that file at line 40", "show me the file beside the chat", "what does clicking a path do", "show the diagram full screen".

The user's way (tier balanced; /tier file_viewer on enables it elsewhere):
  Click a file path in the conversation, or type /open <path>[:line[-line]] (@ completes the path; /open close closes it). alt+o opens the first path in the selection or the item in view; alt+x closes (actions file.open and file.close in {{program}} docs key-actions). A folder lists its entries.
  The viewer is read-only: header, line numbers, syntax colors, the cited lines selected, Git marks in the margin, / search (n, N), : and a number jumps to a line.
  Profile keys (customize_ui settings, {{program}} docs customize): [[setting:pathClick]] auto|panel|editor (what a click does; panel turns the viewer on anywhere), [[setting:fileOpener]] file|vscode|cursor|zed|idea|none (the editor that o and editor links open), [[setting:viewerNumbers]], [[setting:viewerWrap]] auto|on|off, [[setting:viewerFocus]] (does it take the keyboard).
  /diagram [n] opens a Mermaid diagram of the session on a pannable canvas (arrows pan, +/- zoom); with messageRenderer full a mermaid fence in an answer is drawn as a diagram, and the source stays when the layout fails.

What the model can do: reference paths as src/app.rs:120 or src/ui.rs:56-79 in backticks so they are clickable. There is no tool that opens the viewer for the user or reads what is shown in it; to read a file use read.

Limits: only paths inside the workspace (the session directory and directories from /add-dir); a path outside says "not opened" and is never read. A file over 4 MB is "too large to view"; binary files show only type and size; lines over 2,000 characters are cut; a folder shows at most 500 entries. Secrets are masked as in diffs. Off with no tier and in minimalist, where a click leaves the path to the terminal's own link.

Data honesty: Git marks come from the Changes report; with no report there are none. The viewer re-checks the file when the window gets focus, a turn ends or r is pressed; there is no watcher, so a file changed by a running command may show old text until then.

Check: ask the user what they see; if you cannot see the screen, say the result was not verified.
