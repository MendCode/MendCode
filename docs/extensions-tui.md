# Terminal extensions and keybindings

The terminal half of the extension contract (`packages/extension-api`): TypeScript modules that draw in the terminal, add `/commands`, pages, modals and named actions, bind keys and reshape tool cards and assistant text. The daemon half (hooks, tools) is separate; a module can export both and each process calls only its own (`tui(api)` here, never `daemon`).

## Where modules live

Per layer, `extensions/*.ts|js` and `extensions/<name>/index.ts|js`:

| Layer | Path |
|---|---|
| user packages | `<data dir>/packages/<name>/extensions` |
| user | `<data dir>/extensions` |
| project packages | `<project>/.mendcode/packages/<name>/extensions` |
| project | `<project>/.mendcode/extensions` |

`<data dir>` is the CLI's `--dir` (else `MENDCODE_V2_DIR`, else `~/.mendcode-v2`). Modules load in that order, which is the daemon's layer order (user packages, your own folder, project packages, the project's folder; a later module wins a name, key or slot); within a layer, by file name. Versions before the precedence report loaded your own folder first. `/packages` then `p` and `/doctor` list every name more than one module registers and which one is in force ([packages](packages.md#one-precedence-report)). Packages disabled in the daemon's settings (`disabledPackages`, `user:name` / `project:name`) are skipped. Files starting with `.` and `.d.ts` files are ignored.

A module is loaded with a dynamic `import()` only when at least one file exists: a terminal without extensions never parses the runtime (`apps/cli/test/extensions-loader.test.ts` checks this in a fresh process), and draws no extra work per frame.

```ts
// <data dir>/extensions/clock.ts — no import needed; a plain object is enough.
export default {
  name: "clock",
  tui(api) {
    api.slot("footer.right", ({ now }) => [[{ text: new Date(now).toTimeString().slice(0, 5), fg: "muted" }]])
  },
}
```

`import { defineExtension } from "@mendcode/extension-api"` only resolves where the workspace package does; outside it use a plain object (and `import type` for types, which is erased).

## Project trust

Project extensions (`.mendcode/extensions`, `.mendcode/packages/*/extensions`) are code from the repository, so they load only when the directory is trusted, the same trust as project custom tools.

1. The daemon pushes its settings to every terminal; `trustedToolDirs` (realpath of trusted roots) is the flag `tools.list` itself is computed from. The terminal checks its directory against it (no query needed).
2. If the list does not say trusted and project extension files exist, the terminal asks `tools.list` for the directory and treats the project as trusted when it has project tools and all of them are trusted. (The report has no directory-level flag of its own.)
3. Otherwise project modules are not loaded. `/help` shows `N extensions not loaded: directory not trusted`. When trust is granted later (`settings.changed`), they load without a restart.

Limit: `/tools` → `t` only acts when the project has custom tools, so a project with extensions and no tools cannot be trusted from that page today (the daemon's `tools.trust` command works for any directory).

Disabling a package that is already loaded reloads the terminal half. `/customize` → Extensions can disable individual terminal modules by name, independently of their daemon half.

## Live reload and agent customization

Edit or add a `.ts`/`.js` file under `<data dir>/extensions`: the **daemon** watches this directory, invalidates its extension cache, and broadcasts `extensions.changed`. Connected terminals build a candidate runtime beside the running one and import the modules again, including local helpers. The candidate's settings requests wait until it is swapped in; if a module that loaded before now fails (syntax error, missing import, `tui()` throws) the candidate is disposed (its own disposers run once), the running extensions stay on screen and the failure is shown in `/extensions` and reported to the daemon. When the candidate is at least as good, it takes over and the previous runtime is disposed once; an `api.onDispose` that returns a promise is awaited (up to 2 s), and only then does the new copy run its `api.onStart` callbacks. Start processes, sockets and timers in `api.onStart`, not in `tui()`: `tui()` runs while the old copy is still live, so a helper started there runs twice during a reload (two captures of the same device, two servers on one port). A broken candidate never starts. Closing the terminal awaits the disposers the same way. There is no CLI file watcher. `/extensions reload` explicitly performs the same reload (including trusted project/package modules); it does not grant project trust. Deletion of an extension file also removes its registrations. Register timer/listener cleanup with `api.onDispose(cleanup)`; it runs on reload, failed setup and terminal exit.

```ts
// Seconds since this copy went live, redrawn every second. The timer starts in onStart, so a reload never runs two.
export default {
  name: "uptime",
  tui(api) {
    let since = Date.now()
    let timer: ReturnType<typeof setInterval> | undefined
    api.onStart(() => { since = Date.now(); timer = setInterval(() => api.redraw(), 1000) })
    api.onDispose(() => clearInterval(timer))
    api.slot("footer.right", ({ now }) => [[{ text: `up ${Math.floor((now - since) / 1000)}s`, fg: "muted" }]])
  },
}
```

The writing tool `customize_ui` uses the normal tool permission gate: plan mode cannot write, and approval/denial follows the active permission policy. Its model-visible schema includes every profile key and its API description includes the terminal contract. Actions:

- `{action: "settings", values: {userIcon: "◆", messageMeta: "off"}}` applies a validated `/customize` patch and reloads.
- `{action: "write", file: "look.ts", content: "export default ..."}` writes a complete user module.
- `{action: "edit", file: "look.ts", old: "exact unique text", new: "replacement"}` patches one literal occurrence.
- `{action: "reload"}` retries validation without changing a file.

Results contain `revision`, `errors`, `terminalValidation` (`complete` when all connected local terminals acknowledge, otherwise `pending`) and `file` for file writes. A load error makes the tool result an error; the model can repair it with `edit`. Without a connected terminal, importing the daemon half is not proof of terminal rendering. Render-time failures remain visible in `/customize` and `/help`; validation acknowledges setup, not every future renderer invocation.

Only flat alphanumeric/underscore/hyphen `.ts`/`.js` filenames are accepted, at most 64 KiB of UTF-8. No paths, traversal, dotfiles, project destinations, symlinked extension directories/targets, dangling links or hardlinked targets. Edits use `O_NOFOLLOW` and writes use an exclusive mode-0600 temporary file followed by rename. Settings storage also rejects links. These checks confine the **tool's file operations**, not executed extension code: an approved module is arbitrary code with the user's privileges, not an OS sandbox. Parent-directory races against a hostile local process are not a sandbox guarantee.

`/customize` → Extensions lists UI modules, on/off state and errors; left/right select a module, enter/space toggle, down selects Export look, enter exports. Export look writes the current complete profile as a new `look-<uuid>.ts` user module and reloads it; it does not export other modules' source, timers or arbitrary renderers. Both actions persist without restarting.

## Errors

Each problem is kept per extension, shown in **one** toast at startup (`N extension problems · /help`, or the message itself when there is one) and listed in `/help` (problems lead the page). Problems: a module that fails to import, a default export that is not `{ name, tui? }`, a missing or duplicate `name`, a `tui()` that throws, rejects or takes longer than `HOOK_TIMEOUT_MS`, an unknown slot, an invalid key, a command that shadows a built-in, invalid `keybindings.json` entries. A `tui()` that fails has its earlier registrations removed.

At run time every call into extension code is guarded: a slot renderer, tool renderer, markdown transform or page that throws (or returns the wrong shape) is **disabled for the session** and reported once (toast + `/help`); a command or key that throws is reported and stays registered. Nothing an extension does can fail a frame.

## Slots

`api.slot(name, (ctx) => Line[] | undefined)`. `undefined` keeps the default. `*.replace` slots take the place of what MendCode draws (the last extension that answers wins); the others add to it (all extensions, in load order). `[]` from a `*.replace` slot replaces with nothing.

| Slot | Drawn in | What it does |
|---|---|---|
| `header.replace` | `ui/app.ts` `chatRows` (top bar), `view/topbar.ts` `renderHeaderSlot` | Replaces the top bar: up to 3 rows, in every view (also on the home screen; the minimal view, which has no top bar, draws it too). |
| `footer.replace` | `app/extensions.ts`, `app/chrome.ts` | Replaces the footer, up to 12 rows (a quarter of the terminal height), outside the prompt frame. |
| `footer.left` / `footer.right` | same | Up to 12 rows per side, combined row by row; each side gets about half the row's width. A multi-row footer made of MendCode's own segments needs no slot: set `footerRows` or `/footer preset rows` ([customize.md](customize.md#footer-rows)); a slot is for data MendCode does not have. |
| `welcome.replace` | `ui/app.ts` `emptyState`, `view/home.ts` `renderWelcomeReplacement` | Replaces the whole home screen (from the top; you lay it out, `ctx.width/height` are the rows available). |
| `welcome.below` | `view/home.ts` `renderHome` (`below`) | Rows under the home's centered block (at most 8). |
| `prompt.above` / `prompt.below` | `ui/app.ts` `chatRows` (`promptSlotRows`), `view/prompt-chrome.ts` `slotRows` | Up to 3 rows directly above / below the prompt box (1 row under 20 screen rows, none under 14). |
| `prompt.replace` | `app/chat-rows.ts` | Replaces the input's rendered rows; use `api.prompt.replace` to supply an explicit cursor too. |
| `sidebar:<id>` | Right sidebar `extension:<id>` widget | Renders one custom widget at its available width. Add it with the `sidebar` tool or `/sidebar edit`; an unregistered slot shows unavailable. |
| `working.replace` | `ui/app.ts` `workingRow`, `view/working-row.ts` `renderWorkingReplacement` | Replaces the spinner row whenever it would show (first line only; the `[esc again to interrupt]` hint is kept). |

Balanced and full use one footer under the prompt (agent · model · effort/provider), also used on pages. `footer.*`
slots replace or extend that same row. `minimal` has none of its own; it shows the footer when `footerRows` is set or an extension
draws in a `footer.*` slot. Shell mode keeps its own row.

`SlotContext` is a frozen snapshot per call: `width` (cells available to that slot), `height` (rows available to it), `breakpoint`
(the terminal's width class from `ui/breakpoints.ts`: `compact` under 70 columns, `normal` 70 to 109, `wide` 110 to 149, `xl` 150 and up;
it is the whole terminal's, not the slot's), `screen` (`{ width, height }` of the terminal), `sessionId`, `title`, `directory`, `branch`, `model`, `effort`, `state` (`idle`, `working`, `waiting` for approval or a held queue, `offline`), `context` (0–1 of the compaction threshold) and `now`.

Output is cut to the slot's width (replace-style slots are padded to it), at most 200 rows are read, and text is reduced to printable cells: escape sequences and control characters are dropped, newlines and tabs become spaces.

### Colors and styles

`fg`/`bg` are theme roles: `primary text body muted border heading code link success warning error accent secondary info borderActive panel element promptBg diffAddedBg diffRemovedBg background synComment synKeyword synString synNumber synFunction synType`. An unknown `fg` falls back to `text`; an unknown `bg` is ignored. `#rgb` / `#rrggbb` also work. `bold`, `dim`, `italic` apply; `underline` is accepted and ignored (the terminal layer has no underline).

## Tool cards, markdown

`api.renderTool(tool, ({ tool, detail, args, final, output, status, width, expanded }) => Line[] | undefined)` is consulted for every tool card before the default body, built-in tools included (`shell`, `edit`, `custom__x`, `mcp__s__t`…). The body is drawn inside the card's indent; `width` is what is left. `status` is `running`, `ok` or `error` (cancelled and interrupted count as `error`).

**Arguments.** `detail` is the text after the tool name in the title (a command, a path). Once the call finished, `args` holds every argument the tool got, with `detail` among them, and `final` is `true`; while it runs, or when the daemon cut long arguments (it keeps 4000 characters, secrets redacted), `args` is `{ detail }` and `final` is `false`. Everything is read-only: `args` and every object and list in it are frozen (assigning throws in module code), strings over 2000 characters end in `…`, lists keep 100 items and nesting stops at 6 levels.

**Which renderer draws.** `tool` is a name or a pattern ending in `*`: `mcp__github__*`, `mcp__*`, `*` (a `*` anywhere else is refused at load). For each call the exact name is asked first, then the longest matching prefix, then `*`; among equals the later registration wins (a later package, or a later call in the same file). A renderer that returns `undefined` passes the call to the next one, and after the last comes the default card.

```ts
// Every GitHub MCP call as one line with its repository; other MCP tools keep the default card.
api.renderTool("mcp__github__*", ({ tool, args, final, status }) => final
  ? [[{ text: `${tool.slice("mcp__github__".length)} `, fg: "accent" }, { text: String(args.repo ?? args.detail), fg: status === "error" ? "error" : "muted" }]]
  : undefined)
```

Renderers apply in `balanced` and `full` (`minimal` draws one-line rows); cards are cached once finished, so keep a renderer a pure function of its input.

A complete package with two renderers is `examples/packages/tool-renderers/`: `shell` as `$ command` with its folder, background flag and the last lines of output, and every `mcp__github__*` call as action, `owner/repo #number` and title, each passing the call on when its arguments are missing.

`api.markdown((text) => string)` remains the assistant-only shorthand. `api.markdown(role, (text, ctx) => string)` selects `user`, `assistant`, `tool` or `meta` (reasoning/status/notices). Transforms chain in load order and only alter display text; they never mutate transcript data or model context. User transformed markdown renders as markdown, rather than the default plain tinted message.

```ts
// TODO in an answer stands out; a message that starts with a path shows it as code. Only the screen changes.
api.markdown((text) => text.replace(/\bTODO\b/g, "**TODO**"))
api.markdown("user", (text) => text.replace(/^(\S+\/\S+)/, "`$1`"))
```

## Role renderers, prompt, widgets and settings

`api.renderMessage(role, ({message, width, theme}) => Line[] | undefined)` overrides the entire message body before the default markdown/tool/meta renderer. The last answering registration wins; `undefined` preserves the default, `[]` hides the body. `message` contains `role`, `text`, optional `itemId`, `turnId`, `title`, `at`, `status`, and `meta` (agent/model/tokens/time when available). The message, nested metadata and theme are frozen snapshots. `theme` has `name` and `colors`. Maximum 200 rows, sanitized and clipped to cell width. Throwing or invalid renderers/transforms are disabled and reported once, like slots; other modules keep drawing.

```ts
// The user's messages as quoted lines; every other role keeps the default body.
api.renderMessage("user", ({ message }) => message.text.split("\n").filter(Boolean).map((line) => [{ text: `> ${line}`, fg: "muted" }]))
```

`api.prompt.chrome({lead?, border?, preset?})` merges overrides in load order. Border: `auto|single|rounded|double|ascii`; preset: `box|top-bottom|minimal|ascii-box`. `api.prompt.replace(ctx => ({lines, cursor: {row, col}}) | undefined)` draws up to 8 input rows inside that chrome; cursor coordinates are zero-based cells within those rows. `ctx` extends `SlotContext` with `text`, visual `lines`, `cursor` and frozen `theme`. Input editing/submission stays in MendCode. Invalid coordinates disable the renderer; above/below slots and the footer remain outside the input frame.

```ts
// A "λ" lead on the first input row; every row moves two cells right and the cursor with them.
api.prompt.chrome({ preset: "minimal" })
api.prompt.replace(({ lines, cursor }) => ({
  lines: lines.map((line, row) => [{ text: row === 0 ? "λ " : "  ", fg: "primary" }, { text: line }]),
  cursor: { row: cursor.row, col: cursor.col + 2 },
}))
```

`api.widget("tray" | "sidebar", id, {title, render: ctx => Line[] | undefined})` registers a named panel. Ctrl+T shows tray widgets. Sidebar panels stay hidden and unrendered until explicitly added with `/sidebar widget <id>` or an `extension:<id>` sidebar spec entry; registration never opens a surface or takes focus. Rendering receives available `width`/`height`, is sanitized and bounded to 8 rows (the tray shows two panels, two content rows each); right-sidebar overflow scrolls. Compact terminals hide side panels; short terminals omit tray panels to preserve the input and footer. IDs use letters, digits, `_` or `-`. A failing widget is disabled and reported once. The existing `api.page` and `sidebar:<id>` slots remain supported.

```ts
// Branch and model in the tray (ctrl+t), and the same panel for the right sidebar once `/sidebar widget where` adds it.
const where = { title: "Where", render: ({ branch, model }) => [[{ text: branch ?? "no branch", fg: "primary" }], [{ text: model ?? "no model", fg: "muted" }]] }
api.widget("tray", "where", where)
api.widget("sidebar", "where", where)
```

`api.settings.get(key)` reads a `/customize` profile value; `get()` returns the full profile. `api.settings.set(key, value)` or `set({...})` validates a patch like `/customize`, applies it immediately and refreshes cached messages. It is a layer over your profile for as long as the extension is loaded: nothing is written to your stored profile, a value you choose yourself in `/customize` wins over it, and unloading the extension puts your stored value back. Keys/defaults are in `view/tui-profile.ts` and the additive wire validator in `packages/protocol/src/tui-data.ts`; unknown keys/invalid values throw. Setup changes are staged and committed only if `tui()` succeeds; failed/timed-out setup removes its registrations and staged settings. Styles, slots and profile changes from `api.settings` are all runtime-only. `disabledUiExtensions` stores terminal module names. API version remains 1; all new methods are additive.

```ts
// Side-by-side diffs while this module is loaded, unless you chose a diff view in /customize yourself.
if (api.settings.get("diffView") === "unified") api.settings.set("diffView", "auto")
```

Usage widgets use the same settings API, for example
`api.settings.set({usageWidgets: ["token-mix", "clock"], usageWeatherEnabled: false})`.
IDs: `token-mix`, `response-load`, `subscription-usage`, `peak-pressure`, `clock`, `weather`,
`status`, `outcome-signals`, `tools`, `agents-models`. Default selection is empty.
Weather also requires `usageWeatherEnabled: true`, a nonempty `usageWeatherRegion` and an explicit
daemon service adapter; selecting its widget alone never starts a query. See [Usage](usage.md).

## Usage and provider quota

`api.usage()` and `SlotContext.usage` give `UsageSnapshot` (types in `@mendcode/extension-api`): `context?` (`usedPercent`, `tokens`, `limit`, measured
against the compaction threshold), `tokens` (`input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`), `costMicros?` and `quota`, a list of
`QuotaReading` (`provider`, `window` such as `7d` or `5h`, `usedPercent`, `leftPercent`, `resetsAt?`, `observedAt`, `ageMs`, `stale`). Read-only, free,
nothing is sent to the daemon. Quota comes from what each provider itself reports (the ChatGPT backend's response headers on the native engine,
the Codex and Claude Code engines' rate-limit events) and is remembered per provider: a session on one provider leaves another's last reading
in place, with its age. A window that was never reported is not listed (unknown, never 0 % or 100 %). `stale` is true after 15 minutes or once the
window has reset (a reset window is shown as `n/a`, a stale one in a live window dimmed with a compact age such as `~2d`). Extensions never read another program's files for this. A `statusline.json` script gets the same list in `MENDCODE_USAGE_JSON`
(`{ now, quota }`). `mendcode docs usage` has a two-row quota footer that is tested against this contract.

```ts
// The fullest quota window on the left of the footer ("7d 82%"): amber from 80 %, dim when the reading is stale.
api.slot("footer.left", () => {
  const fullest = [...api.usage().quota].sort((a, b) => b.usedPercent - a.usedPercent)[0]
  if (!fullest) return undefined
  const fg = fullest.stale ? "muted" : fullest.usedPercent >= 80 ? "warning" : "text"
  return [[{ text: `${fullest.window} ${Math.round(fullest.usedPercent)}%`, fg }]]
})
```

## Session stats

| API | What it gives |
|---|---|
| `api.stats()` | The current `SessionStats`: a frozen snapshot, never null, free to call from a renderer or a handler. The same object comes back until a figure moves, so `===` tells whether anything changed |
| `api.onStats(listener)` | Calls `listener(stats)` after a model call, a compaction or a change of model, effort or context window moved a figure: at most once per change, after the current frame or event (a microtask), never on a timer. Returns the function that stops it; reload and disable stop it too. A listener that throws is skipped and reported like any renderer |
| `SlotContext.stats` | The same snapshot, inside every slot renderer |

Read-only: nothing here changes the session or asks the daemon for anything. The fields (`calls`, `input`, `cacheRead`, `cacheWrite`,
`output`, `reasoning`, `cachePercent`, `lastPrompt`, `lastCacheRead`, `lastCachePercent`, `contextTokens`, `contextLimit`, `contextPercent`,
`contextApprox`, `costMicros`, `tokensPerSecond`, `firstTokenMs`, `forecastTurns`, `model`, `effort`) are described in the table under
[Session stats](customize.md#session-stats); optional ones are absent until there is something behind them.
`examples/extensions/cache-ctx.ts` draws `cache 99% · ctx 21%` in the footer's right side and redraws when the figures move:

```ts
export default {
  name: "cache-ctx",
  tui(api) {
    const text = () => {
      const stats = api.stats()
      const parts = []
      if (stats.cachePercent !== undefined) parts.push("cache " + stats.cachePercent + "%")
      if (stats.contextPercent !== undefined) parts.push("ctx " + stats.contextPercent + "%")
      return parts.join(" · ")
    }
    api.slot("footer.right", () => {
      const line = text()
      return line ? [[{ text: line, fg: "muted" }]] : undefined
    })
    const stop = api.onStats(() => api.redraw())
    api.onDispose(stop)
  },
}
```

Tests: `apps/cli/test/extensions-stats.test.ts` (the example in the real app, identity, one call per change, disposal, a throwing listener),
`session-stats.test.ts` (the source, the hub, the parts and their thresholds) and `stats-surfaces.test.ts` (top bar, activity status, sidebar
card, footer). Frames at 80 and 120 columns, dark and light: `bun scripts/render-session-stats-frames.ts <directory>`.

## Keys

### `keybindings.json`

`<data dir>/keybindings.json`: `{ "<key>": "<action>" | null }`. Read at startup, again whenever [`/keymap`](editor.md#keymap-editor) changes it, and on every `extensions.changed`: the daemon's watcher sends one when the file is written by hand or by the agent, so every open terminal applies it without a restart. Invalid entries are reported once and skipped, the rest apply. With no file the defaults are unchanged. `null` unbinds that key. A key set here leaves every default table, so `"ctrl+o": "dock"` replaces ctrl+o's default meaning.

Keys (case-insensitive): `ctrl+<letter>`, `ctrl+space`, `ctrl+\`, `ctrl+]`, `ctrl+^`, `ctrl+_`, `alt+<char>` (`opt+<char>` and `option+<char>` are the same key, for a Mac keyboard; hints name it by the platform, the file's name is `alt`), `f1`…`f12`, `up down left right home end pgup pgdn insert delete`, `shift+tab`, `leader+<char>` (the chord after `ctrl+x`), or a raw sequence such as `"\u0007"`. Reserved (refused): `ctrl+c` (quit/clear), `ctrl+x` (leader), `enter`, `esc`, `tab`, `backspace`, `ctrl+j`, `ctrl+m`, `ctrl+i`, `ctrl+h`.

Actions:

| Action | Default key |
|---|---|
| `new`, `sessions`, `model`, `theme`, `compact`, `quit`, `agents`, `usage`, `changes` | `ctrl+x n l m t c q a U d` |
| `help` | none (`/help`) |
| `dock` | `ctrl+t` |
| `model.next`, `effort.next` | `f2`, `f3` (`alt+.` or `ctrl+x .` also steps effort up) |
| `effort.previous` | `alt+,` / `ctrl+x ,` |
| `history.search` | `alt+r` / `ctrl+x ?` (search earlier prompts; see `editor.md`) |
| `history.previous` / `history.next` | `alt+p` / `alt+n`, or `ctrl+x [` / `ctrl+x ]` (walk the prompt history from any row; `ctrl+p` stays the palette) |
| `queue.edit` | `alt+up` / `ctrl+x ^` (pull the newest queued prompt back into the prompt) |
| `selection.comment` / `comment.list` | `ctrl+g` or `alt+q` / `alt+l`, or `ctrl+x w` / `ctrl+x W` (comments on an answer; see `editor.md`) |
| `panel.focus` | `ctrl+\` / `alt+}` / `ctrl+x }` (the right panel, or the open file, takes the keyboard; esc gives it back) |
| `file.switch` | `alt+{` / `ctrl+x {` (the right slot shows the open file or the panel; see [file viewer](file-viewer.md)) |
| `file.open` / `file.close` | `alt+o` / `ctrl+x ;`, `alt+x` / `ctrl+x -` (open the first file path of the selection or the item in view, a list when there are several; close the open file) |
| `backtrack.open` / `shortcuts.toggle` | none (`esc esc` on an idle empty prompt and `?` are built in; same as `/backtrack` and `/shortcuts`) |
| `edit.yank` / `edit.yank-pop` | `alt+y` / `alt+shift+y`, or `ctrl+x '` / `ctrl+x "` (kill ring) |
| `edit.jump-forward` / `edit.jump-backward` | `alt+j` / `alt+shift+j`, or `ctrl+x j` / `ctrl+x J` (jump to a character) |
| `palette` | `ctrl+p` |
| `tools.expand` | `ctrl+o` |
| `permission.next` | `shift+tab` |
| `queue.send` | `ctrl+s` |
| `queue.drop` | `ctrl+k` |
| `queue.flip` | `ctrl+shift+enter` (send this one message the other way: steer a running turn, or queue it when the policy steers; `ctrl+enter` stays a newline) |
| `image.paste` | `ctrl+v` |
| `scroll.top` / `scroll.bottom` | `home` / `end` |
| `scroll.up` / `scroll.down` | `pgup` / `pgdn` |
| `edit.undo` / `edit.redo` | `ctrl+_` (also `ctrl+/` in most terminals) / `ctrl+y` |
| `editor.open` | `ctrl+x e` (edit the prompt in `$EDITOR`) |
| `message.copy` | `ctrl+x y` (copy the last answer) |
| `drafts.restore` | `ctrl+r` (bring back the newest unsent draft of an earlier session) |
| `transcript.find` | `ctrl+f` / `ctrl+x /` (find in the transcript; see `layout.md`) |
| `stash.push` / `stash.pop` | `ctrl+x p` / `ctrl+x o` (park the prompt, restore the last one) |
| `message.undo` / `message.redo` | `ctrl+x u` (`z` alias) / `ctrl+x r` |
| `session.timeline` | `ctrl+x g` |
| `session.export` | `ctrl+x x` |
| `sidebar.toggle` | `ctrl+x b` (same as `/sidebar`) |
| `scratch.edit` | `ctrl+x s` (the dock's scratch note) |
| `diagram.open` | `ctrl+x i` (the last Mermaid diagram of the session, full screen; same as `/diagram`) |
| `messages.open` | `ctrl+x k` (Message Actions: copy, revert or fork a message; same as `/messages`; a plain click on the transcript never opens it) |
| `voice.toggle` | `ctrl+x v` (start or stop dictation; same as `/voice`, see `voice.md`) |
| `details.toggle` | `ctrl+x f` (fold or open the `<details>` block nearest the middle of the screen; a click on a block's `▸`/`▾` summary row does the same for that block, and `ctrl+o` still opens every block) |
| `block.copy` | `ctrl+x Y` (copy the code block, table, list, quote or diagram nearest the middle of the screen; a click on a visible `copy` (a code header, a table border, beside a diagram) does the same, `art` copies a diagram as drawn; lists and quotes have no visible hint, only this key; see [markdown rendering](design/markdown-parity.md)) |
| `command:<name>` | a slash command, built-in or terminal extension (`"f4": "command:usage"`) |
| `page:<id>` | an extension page; with no extension page of that id, the built-in page its slash command opens (`page:git` is `/git`) |
| `modal:<id>` | an extension modal (`api.modal`) |
| `action:<id>` | an extension's named action (`api.action`) |

Keys act in the chat; the keymap is bypassed while a slash/mention popup or an approval/question owns the keys. The prompt's own defaults (`palette` to `scroll.down`) keep their conditions on their default keys (an empty prompt, a queued message, no pending approval…); on a key you bound they act whenever the keymap is live. Not rebindable: enter, esc, tab, `ctrl+c`, `ctrl+x`, editing keys, `a`/`s`/`d` and `1`–`3` on approvals, `!`, arrows in the prompt.

### `api.key(key, run)`

Same key names, or a raw sequence. Extension keys override `keybindings.json` and defaults; later extensions win. Nothing is replaced silently: `/keymap` marks both rows ("ctrl+o replaced <action>", "ctrl+o is taken by extension x"), `/extensions` lists the key under that extension, and two extensions on one key are a problem naming the loser. The same goes for a terminal command or page id registered by two extensions. `d` on `/extensions` turns the selected extension off by name (terminal half through `disabledUiExtensions`, daemon half through `extensions.disable`). `run(actions)` gets `TuiActions`. An invalid key is reported and ignored.

`/help` lists the effective bindings (file and extensions included).

## Commands, pages, actions

`api.command(name, description, (args, actions) => void)`: `/name args` runs in the terminal with no daemon round trip. It appears in the slash suggestions (marked `:ext`) and the palette; picking it inserts `/name ` so arguments can follow. A name that is a built-in command or alias is refused. Extension commands run before `.mendcode/commands` of the same name.

`api.page(id, { title, render, onKey? })` is a full-screen page drawn with the page standard (`view/page.ts`: title, rule, your body, `esc back`). `render(ctx)` returns the body (`ctx.width` = page width − 2, `ctx.height` = rows available, `ctx.breakpoint` the terminal's width class), called again on every frame, so a resize lays it out anew. Open it with `actions.openPage(id)` (from a command or key) or the `page:<id>` action. `onKey(key, { close, redraw })` gets every key first, named like the keybindings (`x`, `up`, `ctrl+o`, `alt+x`, `pgup`, `enter`…; typed-ahead text arrives one character at a time) and returns `true` when it handled it; an unhandled `esc` closes the page. Mouse events are not forwarded. A page that throws while drawing closes and is disabled.

```ts
// `/note text` keeps a note; `/note` alone opens them on a page, where x clears them and esc goes back.
const notes: string[] = []
api.command("note", "Keep a note, or show them", (args, actions) => {
  if (!args.trim()) return actions.openPage("notes")
  notes.push(args.trim())
  actions.toast(`${notes.length} notes`)
})
api.page("notes", {
  title: "Notes",
  render: ({ height }) => notes.length
    ? notes.slice(-height).map((note) => [{ text: `• ${note}` }])
    : [[{ text: "No notes yet: /note <text>", fg: "muted" }]],
  onKey: (key, { redraw }) => {
    if (key !== "x") return false
    notes.length = 0
    redraw()
    return true
  },
})
```

`api.modal(id, { title, render, onKey?, width? })` is a card drawn over the chat, or over the page that is open, with the palette's chrome (`view/modal-card.ts`, shared with `view/palette.ts`): a centered card on the `panel` fill, three columns of padding, the title row with `esc` on the right, and padding rows on a screen of 24 rows or more. The transcript stays drawn around it. `render(ctx)` returns the body and is called with a fresh context every frame: `ctx.width` is the card's inner width, `ctx.height` the rows it may take, `ctx.breakpoint` and `ctx.screen` describe the terminal, so a modal adapts to a resize without a listener. `width` is the card's width in columns (above 1) or a share of the terminal (0 to 1), or a function `({ width, height, breakpoint }) => number` of the terminal asked every frame (one that throws or answers anything but a positive number disables the modal); without it the card is as wide as the palette (72 % of the terminal, 96 to 148 columns). It is never wider than the terminal less two columns; a terminal too small for a card of 16 columns closes the modal. Open it with `actions.openModal(id)` or the `modal:<id>` action; `actions.closeModal()` closes it. `onKey(key, actions)` gets the terminal's `TuiActions` (insert, submit, toast, open a page…) plus `close()` and `redraw()`, and returns `true` when it handled the key. While it is open it takes every key, named as for pages (typed-ahead and pasted text one character at a time); nothing reaches the prompt behind it. An unhandled `esc` closes it and `ctrl+c` always does (it never quits from a modal). Mouse events are dropped. Opening a page closes the modal. A modal that throws while drawing or in `onKey` closes and is disabled for the session, like a page.

`api.action(id, run, { title?, description? })` names an action: `action:<id>` in `keybindings.json` and `/keymap`, and a row under **Actions** in the palette (ctrl+p) with `title` (else the id) and `description`. `run(actions)` gets `TuiActions`, as a key does; a throw is reported and the action stays registered. An id is letters, digits, `_`, `.`, `:` or `-`; a later module's action with the same id wins and the conflict is listed in `/extensions`. An id no loaded extension has is a toast (`unknown action: <id>`).

`TuiActions`: `submit(text)` sends text as the user (a `/command` runs as typed; the prompt's draft is kept), `insert(text)` inserts into the prompt, `openPage(id)`, `openModal(id)`, `closeModal()`, `openFile(path, lines?)` (opens a file of the workspace in the [file viewer](file-viewer.md), at `{ from, to? }`; a path outside the workspace, a missing file or a folder is refused with a toast and nothing is read), `toast(text, tone?)`, and `comments` (below).

### A responsive modal

`examples/extensions/branches.ts` (tested in `apps/cli/test/extensions-ui.test.ts` at 60, 100 and 160 columns): ctrl+x B, "Pick a branch"
in the palette or `"f6": "action:branches.pick"` in `keybindings.json` open it; the body puts a second column beside the names from the
`wide` breakpoint up.

```ts
// <data dir>/extensions/branches.ts
export default {
  name: "branches",
  tui(api) {
    const branches = ["main", "integration/all", "lane/ext-modals", "release/1.4"]
    let selected = 0
    api.modal("branches", {
      title: "Branches",
      // The whole terminal when it is narrow, half of it from 70 columns up (the card always leaves two columns free).
      width: ({ breakpoint }) => (breakpoint === "compact" ? 1 : 0.5),
      // Called every frame with the card's inner size and the terminal's breakpoint: no resize listener needed.
      render: ({ width, height, breakpoint }) => {
        const twoColumns = breakpoint === "wide" || breakpoint === "xl"
        const rows = branches.slice(0, Math.max(1, height - 1)).map((name, i) => {
          const mark = i === selected ? "› " : "  "
          const detail = twoColumns ? name.padEnd(Math.floor(width / 2)) + (i === 0 ? "default" : "") : name
          return [{ text: mark + detail, fg: i === selected ? "primary" : "text" }]
        })
        return [...rows, [{ text: "enter insert · ↑↓ move", fg: "muted" }]]
      },
      onKey: (key, actions) => {
        if (key === "up" || key === "down") { selected = (selected + (key === "up" ? branches.length - 1 : 1)) % branches.length; return true }
        if (key === "enter") { actions.insert(branches[selected]); actions.close(); return true }
        return false
      },
    })
    api.action("branches.pick", (actions) => actions.openModal("branches"), { title: "Pick a branch", description: "insert a branch name into the prompt" })
    api.key("leader+shift+b", (actions) => actions.openModal("branches"))
  },
}
```

### Every tier

Terminal extensions load at every tier: the terminal never asks the tier before discovering or importing them (`extensions` is a
kernel feature, [tiers](tiers.md)), and only `--pure`, `--safe-mode`, a remote attach, `disabledPackages` and `/customize` → Extensions
leave them out. Their commands, pages, modals, actions and keys work the same in minimalist, balanced and full; their commands and
actions are listed in the slash menu and the palette under minimalist too (they are the user's own). The minimal view that minimalist
selects has no top bar or footer of its own, but it draws an extension's `header.replace` and `footer.*` slots. What a view still
decides is how the transcript looks: tool cards are one-line rows in the minimal view, so `renderTool` bodies show in balanced and full.

### Comments on an answer

The user's comments on passages of an answer ([editor.md](editor.md#comments-on-an-answer)) are visible to extensions in two ways.

`actions.comments.list()` returns the pending comments, each `{ n, quote, text, itemId? }` (`n` is the chip number), and `actions.comments.add({ quote, text })` adds one, for example "comment on this diff hunk". It returns `false` when comments are off, the quote or the words are empty, or the user's limit (`commentMax`, at most nine) is reached. A comment added by code is marked `of="context"` on the wire, never `earlier answer`, and has no passage in the transcript to mark.

`api.comments.beforeSend((message, { comments, note }) => string | undefined)` runs just before a message with comments is sent. `message` is the complete envelope as built (the user's `commentTemplate` and `commentEntry` included); return the text to send instead, or `undefined` to keep it. Text before or after the envelope is allowed and shows as such in the transcript. Transforms run in load order, receive frozen data, and one that throws, or returns anything but a string or `undefined`, is disabled with a problem in `/doctor`. The result must stay under 60,000 characters or the send is refused and the prompt keeps everything.

```ts
// <data dir>/extensions/comment-hunk.ts (examples/extensions/comment-hunk.ts)
export default {
  name: "comment-hunk",
  tui(api) {
    api.command("hunk", "Comment on a file's diff hunk", (args, actions) => {
      const [file, ...words] = args.trim().split(/\s+/)
      if (!file || words.length === 0) return actions.toast("usage: /hunk <file> <comment>", "warning")
      actions.comments.add({ quote: `diff of ${file}`, text: words.join(" ") })
    })
    api.comments.beforeSend((message, { comments }) => `${message}\n\nReviewed ${comments.length} ${comments.length === 1 ? "passage" : "passages"}.`)
  },
}
```

`api.redraw()` schedules a render; calls are coalesced with every other frame request.

## Diagram view

`/diagram [n]` (or the `diagram.open` action, `ctrl+x i`) opens the session's Mermaid diagrams full screen, the last one by default. The chat draws a diagram at the chat's width and shows source when it does not fit; this view draws it at its natural size and scrolls. Keys: arrows or `hjkl` pan, `H J K L` and shift+arrows pan a page, `home`/`end` jump to the corners, `+`/`-` zoom (overview, 100%, 200%, 300%: a horizontal stretch that keeps labels whole), `0` or `r` reset the zoom and pan, `n`/`p` move between diagrams, `esc` or `q` close. v1's Mermaid card has fit, zoom and pan but no rotate or flip, so neither exists here. The renderer loads the first time the view opens.

## Tests

`apps/cli/test/extensions-loader.test.ts` (discovery, trust, invalid modules, footprint), `extensions-slots.test.ts` (every slot at 60 and 100 columns, throwing renderers, `renderTool`, markdown), `extensions-ui.test.ts` (commands, pages, modals, named actions, the responsive context, every tier, redraw), `keybindings.test.ts` (parsing, remap, unbind, invalid entries, `api.key`, `action:` and `modal:`). Extension files in the tests are real `.ts` files in temp directories.

### Right sidebar example

```ts
export default {
  name: "project-note",
  tui(api) {
    api.slot("sidebar:project-note", ({ branch }) => [[{ text: branch ?? "No Git branch", fg: "primary" }]])
  },
}
```

Add `{ "type": "extension:project-note", "title": "Project", "options": {} }` to the [sidebar spec](sidebar.md). Sidebar slot ids use letters, digits, `_` or `-`; the same sanitisation, width limits and failure isolation as other slots apply.

## Per-role message chrome

`api.messageStyle("user" | "assistant" | "tool" | "meta", { icon?, lead?, label?, tint?, layout? })` overrides local role chrome. `layout` is `quiet` (inline lead) or `classic` (separate header) for user/assistant; tool/meta add a prefix above their default body. Icons/leads are sanitized to four printable characters; `label` is a boolean or custom string; tint is boolean. Later registrations merge. Existing cached messages refresh after reload. Local profile files are unaffected unless `settings.set` is used. Completion metadata stays governed by `Message meta: off|compact|full`.

```ts
export default {
  name: "message-chrome",
  tui(api) {
    api.messageStyle("user", { icon: "◆", lead: "", label: true, tint: false })
    api.messageStyle("assistant", { lead: "•", label: false })
  },
}
```

Save the module in `<data dir>/extensions/message-chrome.ts`; the daemon reloads it automatically, or use `/extensions reload`.

## Three complete looks

Plain modules need no imports and can be placed directly under the user extensions directory. These examples are also exercised through the real app harness at 100×30 and 180×50; frames live in `.agents/runs/frames/ui-10/`.

### Pi-style icons, roles and header (`messages.ts`)

```ts
export default {
  name: "matrix-messages",
  tui(api) {
    api.messageStyle("user", { icon: "◆", label: "You", lead: "", tint: false })
    api.messageStyle("assistant", { icon: "◇", label: "Agent", lead: "" })
    api.slot("header.replace", ({ width }) => [[{ text: "MEND · Matrix workspace", fg: "primary", bold: true }], [{ text: "─".repeat(width), fg: "border" }]])
  },
}
```

### Clock and branch, two footer rows (`footer.ts`)

```ts
export default {
  name: "clock-branch",
  tui(api) {
    api.slot("footer.replace", ({ now, branch }) => [
      [{ text: new Date(now).toISOString().slice(11, 19) + " UTC", fg: "primary" }],
      [{ text: branch ? "Branch · " + branch : "No Git branch", fg: "muted" }],
    ])
    const timer = setInterval(() => api.redraw(), 1000)
    api.onDispose(() => clearInterval(timer))
  },
}
```

### Prompt chrome (`prompt.ts`)

```ts
export default {
  name: "prompt-console",
  tui(api) {
    api.prompt.chrome({ lead: "λ", border: "rounded", preset: "ascii-box" })
    api.slot("prompt.above", () => [[{ text: "Console · enter sends · shift-enter newline", fg: "muted" }]])
    api.slot("prompt.below", ({ state }) => [[{ text: "Session · " + state, fg: "secondary" }]])
  },
}
```

## Row SDK adapter (B38)

Opted-in `plugin` declarations also load `{ id, activate }` or `{ id, tui }` modules. Keep separate server/TUI
entrypoints when a server module imports the legacy schema helper. UI callbacks return `Line[]`, never JSX or
Solid/OpenTUI nodes. Native `renderTool`, `renderMessage`, `messageStyle`, prompt, widgets and settings APIs
remain available. `app.version` is the running version; `app.capabilities` lists the supported bridge surfaces.

```ts
import type { RowPluginAPI } from "@mendcode/extension-api/plugin"
export default {
  id: "review",
  activate(api: RowPluginAPI) {
    api.route.register([{ name: "review", title: "Review", render: () => [[{ text: "Local review" }]] }])
    api.command("review", "Open review", (_args, actions) => actions.openPage("review"))
    api.slots.register({ slots: { home_bottom: () => [[{ text: "Review", fg: "accent" }]] } })
  }
}
```

`command.register(factory)` accepts slash names/aliases, keybinds and `onSelect`; `route.register` returns a
disposer and `route.navigate` opens the registered page. `slots.register` maps home/session prompt, home bottom,
home footer and sidebar slots to native surfaces, also returning a disposer. `home_logo` maps to the whole native
welcome replacement. Registered pages use the shared bordered panel grid (one column under 70) and header hints.
Lifecycle disposal aborts its signal and clears registrations. The bridge supplies footer/widget runtime aliases;
UI registration happens during activation, and edits are applied through the existing live reload.

`metadata.current/get/getCurrent/list/patch` addresses plugin-owned session JSON through the daemon.
`get({ sessionID })` resolves `{ data }`; `patch({ sessionID, patch: { status: "review" } })` persists a bounded
32 KB merge (null deletes a key). The default is the visible session. Namespaces are separated by module id;
cross-project session access is refused. This metadata is separate from the donor Agent View data model.
`/extensions` shows the plugin id, ABI, auth/provider registrations and errors in its selected panel.

Donor component trees, HTTP SDK methods, overlays, workspace adapters and Effect APIs need migration to the
native row/daemon interfaces. The adapter does not import the donor application or framework.

## View slots

`api.view(slot, renderer)` is one contract for every redrawable part of the terminal: messages, tool cards, approval and question boxes,
prompt frame, top bar, session list, notices, footer, home, panel widgets, the slash menu, the compaction card, turn status and tool rows, every full-screen page (`page`), the palette and cards (`overlay`) and the rows around the prompt (`bar`). View code is not sandboxed: installing one trusts its author. Each slot receives
plain data, returns span lines (or `undefined`), and falls back to the built-in after three faults. See [views.md](views.md).

```ts
// Read cards as one line with the line count; every other tool keeps the built-in card.
api.view("tool.card", (card) => card.kind === "read"
  ? [[{ text: "  read ", fg: "muted" }, { text: card.detail }, { text: ` · ${card.counts.lines ?? 0} lines`, fg: "muted" }]]
  : undefined)
```

## Slash command menu view

`api.view("slashMenu", renderer)` replaces the menu using the enabled catalog, query, selected
item, groups, effective layout and terminal size. It is synchronous and returns span lines;
the terminal keeps key handling, permissions and execution. Returning undefined uses the built-in
view. Three faults disable that renderer until reset or reload and the built-in layout draws with a notice. The runtime sanitizes
and clips output. See [the full contract and complete example](customize.md#replacing-the-slash-menu-view).
