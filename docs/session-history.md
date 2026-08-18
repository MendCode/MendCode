# Session history browser

The live session keeps a bounded render window for predictable memory use and stable scrolling. Older messages open in a separate, explicitly paged history browser instead of being inserted back into the live transcript.

Open it with `/history` or the `session_history` keybinding. The browser supports:

- Three distinct history views; press `v` to cycle them for the current run:
  - `timeline` shows chronological conversation turns.
  - `tree` nests the final assistant response below each user prompt.
  - `pages` shows an explicitly numbered, compact turn page.
  - `auto` chooses tree or timeline from the terminal width.
- An independent preview pane; press `s` to toggle split layout for any view. `split: "auto"` enables it on wide terminals.
- User-to-assistant turn grouping, with optional tool and subagent detail.
- A full-turn reader opened with `Enter`.
- `PageUp` and `PageDown` navigation through bounded history pages.
- `/` Quick Jump searches complete turn pages from newest to oldest and opens the first match.
- `l` to return directly to the live session and `Escape` to step back.

Configure the defaults globally in `~/.config/mendcode/tui.json` or per project in `.mendcode/tui.json`:

```jsonc
{
  "$schema": "https://mendcode.ai/tui.json",
  "session_history": {
    "enabled": true,
    "view": "auto",
    "split": "auto",
    "page_size": 50,
    "group_by": "day",
    "show_tools": "count",
    "show_subagents": true,
    "search": true,
    "remember_position": true,
    "open_at": "latest",
    "preview_width": 58,
    "search_page_limit": 200,
  },
  "keybinds": {
    "session_history": "<leader>shift+g",
    "session_history_search": "/",
    "session_history_open": "return",
    "session_history_back": "escape",
    "session_history_live": "l",
    "session_history_view": "v",
    "session_history_split": "s",
  },
}
```

`page_size` accepts 10–200 complete conversation turns, not raw assistant or tool events. `split` accepts `true`, `false`, or `"auto"`; `preview_width` accepts 40–75 percent. Narrow terminals hide the preview pane so both columns remain usable. `search_page_limit` accepts 1–1000 bounded pages for Quick Jump. `open_at` selects the latest or oldest visible end when a page opens.

Older configs remain valid: `view: "split"` maps to `timeline` with preview enabled, and `view: "chapters"` maps to `timeline`. These legacy values no longer appear in the interactive view selector.

`remember_position` stores only lightweight navigation state for up to 32 recently viewed sessions: the opaque page cursor, selected message, filter, collapsed turns, temporary view choice, and preview state. It does not retain historical message payloads or expand the live transcript window.
