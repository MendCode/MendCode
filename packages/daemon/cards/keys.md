---
summary: rebind keyboard shortcuts (keybindings.json, /keymap)
docs: extensions-tui, editor
aliases: keybindings, keymap, shortcuts, hotkeys, keyboard
---
<data dir>/keybindings.json is { "<key>": "<action>" | null }. null unbinds a key. A key set there leaves every default table, so "ctrl+o": "dock" replaces what ctrl+o did. Invalid entries are reported once and skipped; the rest apply.
  { "f4": "command:usage", "ctrl+g": "palette", "alt+q": null, "leader": "ctrl+b" }
A file you write applies at once in every open terminal (the daemon announces the change; no restart). A key that types or sends text needs an extension: tui(api) { api.key("f5", (a) => a.submit("run the tests")) } ({{program}} docs extend). The user's way: /keymap (alias /keybindings): lists every action with its keys, press Enter then the new key to rebind, Ctrl+D unbinds, Ctrl+R resets one action, Ctrl+G twice resets all.

Key names (case-insensitive): ctrl+<letter>, ctrl+space, alt+<char>, f1..f12, up down left right home end pgup pgdn insert delete, shift+tab, leader+<char> (the chord after the leader key, default ctrl+x), or a raw sequence such as "\u0007". The "leader" field changes ctrl+x.
Always refused: ctrl+c, enter, esc, ctrl+m, ctrl+i (the file reports each refusal). Not rebindable: a/s/d and 1-3 on approvals, arrows inside the prompt.
Actions: the names in {{program}} docs key-actions (the real list of this version, with default keys). Also command:<name> (any slash command, built-in or from an extension, e.g. "command:theme") and page:<id> (an extension page, else the built-in page of /<id>: "ctrl+g": "command:git" or "page:git").
A key held by an extension wins over this file and the defaults; /keymap marks both rows. The user sees the effective bindings with /help and ?.
A package can ship keys too (activate.keybindings, same format): {{program}} docs packages.
Terminal quirks (Shift+Enter, tmux): the user runs /terminal-setup.
Prompt editing, all the user's: /editor opens the prompt in $EDITOR (ctrl+x e); /vim toggles Vim mode ([[setting:vimMode]]); /multiline ([[setting:multiline]]) makes Enter add a line and alt+enter, shift+enter or ctrl+enter send (Enter itself cannot be rebound); /shortcuts or ? shows the keys; /backtrack (esc esc on an empty prompt) edits an earlier prompt. {{program}} docs sessions for stash and drafts.
