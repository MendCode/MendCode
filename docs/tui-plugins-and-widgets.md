# TUI Plugins and Widgets

MendCode TUI plugins are local or packaged JavaScript/TypeScript modules that extend the terminal UI without editing runtime internals. They are the right place for company dashboards, status lines, prompt-side context, custom footers, command palettes, dialogs, routes, themes, shell-backed widgets, and editor widgets.

The public API is exported from `@mendcode/plugin/tui`. The active host implementation lives in `src/mendcode/packages/opencode/src/cli/cmd/tui/plugin/`, and the type contract lives in `src/mendcode/packages/plugin/src/tui.ts`.

## Register a Plugin

Project-local plugins can be placed under `.mendcode/plugin` or `.mendcode/plugins`, or listed explicitly in config.

```jsonc
{
  "plugin": ["./.mendcode/plugins/company-tui.ts"]
}
```

A plugin module exports a `tui` entrypoint:

```tsx
/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiPluginMeta } from "@mendcode/plugin/tui"

export default {
  id: "company.tui",
  async tui(api: TuiPluginApi, options: unknown, meta: TuiPluginMeta) {
    api.ui.toast({
      variant: "success",
      title: "Company UI",
      message: `Loaded ${meta.id}`,
    })
  },
}
```

MendCode loads plugins from merged config in order. Later package/config layers can override plugin order or enablement.

## Persistent Status

Use `api.ui.runtime.setStatus()` for small persistent status text. Status entries are ordered and can be cleared by ID.

```tsx
export default {
  id: "company.status",
  async tui(api) {
    api.ui.runtime.setStatus("company.branch", api.state.vcs?.branch ?? "no branch", {
      order: 20,
    })

    api.lifecycle.onDispose(() => {
      api.ui.runtime.clearStatus("company.branch")
    })
  },
}
```

## Editor Widgets

Use `api.ui.runtime.setWidget()` for persistent widgets around the editor. Supported placements are:

- `aboveEditor`
- `belowEditor`
- `sessionBottomDock`

Widgets can declare sizing metadata:

- `width`, `minWidth`, `maxWidth`: terminal columns for dock widgets.
- `height`: terminal rows, or `auto`.
- `interactive`: marks the widget as expecting key/input handling.
- `title`: display/debug metadata for package UIs.

```tsx
/** @jsxImportSource @opentui/solid */

export default {
  id: "company.review-widget",
  async tui(api) {
    api.ui.runtime.setWidget(
      "company.review",
      () => (
        <box paddingLeft={1} paddingRight={1}>
          <text fg={api.theme.current.accent}>Review mode</text>
          <text fg={api.theme.current.textMuted}> checks, docs, tests</text>
        </box>
      ),
      {
        placement: "aboveEditor",
        order: 10,
        width: "auto",
      },
    )

    api.lifecycle.onDispose(() => {
      api.ui.runtime.clearWidget("company.review")
    })
  },
}
```

Use unique widget IDs. Reusing an ID replaces the previous render function for that widget.

## Shell-Backed Widgets

Use `api.shell.spawn()` when a widget needs live command output. The process output is streamed to plugin code and kept in a capped in-memory tail. It is intended for low-overhead widgets such as status panes, `neofetch`-style summaries, notes exporters, todo dashboards, log tails, and simple command monitors.

```tsx
/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"

function CommandWidget(props: { api: any }) {
  const [output, setOutput] = createSignal("")
  const proc = props.api.shell.spawn("printf 'ready\\n'; while true; do date; sleep 2; done", {
    maxBuffer: 8_000,
  })

  proc.onOutput((event) => setOutput(event.output))
  onCleanup(() => void proc.stop())

  useKeyboard((event) => {
    if (event.name === "escape") void proc.stop()
    if (event.sequence) proc.write(event.sequence)
  })

  return (
    <box flexDirection="column" paddingX={1}>
      <text fg={props.api.theme.current.accent}>Command</text>
      <text wrapMode="truncate">{output().split("\n").slice(-4).join("  ")}</text>
    </box>
  )
}

export default {
  id: "company.shell-widget",
  async tui(api) {
    api.ui.runtime.setWidget("company.shell", () => <CommandWidget api={api} />, {
      placement: "sessionBottomDock",
      order: 40,
      width: 32,
      minWidth: 24,
      height: "auto",
      interactive: true,
      title: "Command",
    })
  },
}
```

`shell.spawn()` is not a PTY. Full-screen terminal applications that require a real TTY, cursor addressing, alternate screen buffers, or terminal audio bridges should be wrapped by a PTY-backed helper or a future `spawnPty` API. Do not fake a Doom/cava integration by assuming normal stdout pipes behave like a terminal emulator.

## Compaction Arcade Games

Compaction can show a small focused arcade surface while context is being packed. Built-ins include `snake`, `stars`, and `blocks`; plugins can register real keyboard-driven games by ID.

The user or package profile selects the game:

```jsonc
{
  "presentation": {
    "compaction": {
      "style": "cockpit",
      "showProgress": true,
      "allowScratchpad": true,
      "arcade": "company.dodger"
    }
  }
}
```

Register the game from a TUI plugin:

```tsx
/** @jsxImportSource @opentui/solid */
import type { TuiCompactionArcadeGame } from "@mendcode/plugin/tui"

type DodgerState = {
  player: number
  rock: { x: number; y: number }
  score: number
}

const width = 28
const height = 8

const game: TuiCompactionArcadeGame<DodgerState> = {
  id: "company.dodger",
  label: "Dodger",
  intervalMs: 140,
  initialState: () => ({
    player: Math.floor(Math.random() * width),
    rock: { x: Math.floor(Math.random() * width), y: 0 },
    score: 0,
  }),
  tick(state) {
    const y = state.rock.y + 1
    if (y >= height) {
      return {
        ...state,
        rock: { x: Math.floor(Math.random() * width), y: 0 },
        score: state.score + 1,
      }
    }
    return { ...state, rock: { ...state.rock, y } }
  },
  key(state, key) {
    if (key === "left" || key === "a") return { ...state, player: Math.max(0, state.player - 1) }
    if (key === "right" || key === "d") return { ...state, player: Math.min(width - 1, state.player + 1) }
    return undefined
  },
  render(state) {
    return {
      title: `Dodger · Score ${state.score}`,
      status: "Click/focus game first. Esc releases focus.",
      cells: Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => {
          if (y === height - 1 && x === state.player) return { text: "▲ ", tone: "head" as const }
          if (state.rock.x === x && state.rock.y === y) return { text: "◆ ", tone: "food" as const }
          return { text: "· ", tone: "empty" as const }
        }),
      ),
    }
  },
}

export default {
  id: "company.arcade",
  async tui(api) {
    api.ui.runtime.registerCompactionArcadeGame(game)
  },
}
```

Game input and runtime are focus-gated by the host compaction panel: click the game to focus/start it, `Esc` releases focus, and `tick()` is only called while the arcade surface is focused. Releasing arcade focus stops ticking the game, effectively pausing it. Keys are not sent to games while focus is outside the arcade surface.

Arrow keys are normalized to `up`, `down`, `left`, and `right`; common character keys arrive as lowercase strings such as `w`, `a`, `s`, `d`, or `r`. Return a new state from `key()` to consume the key, or `undefined` to ignore it.

Prefer `cells` for game boards that need semantic colors. Standard tones are `head`, `body`, `food`, `wall`, `empty`, `primary`, `muted`, `text`, `danger`, and `accent`; the host maps these to the active theme. Use `head` and `food` for player/target cells so every game gets accessible, consistent color separation. `lines` is still supported for simple monochrome output.

Plugin-owned games are automatically unregistered when the plugin is disposed. If a plugin needs manual cleanup, call `api.ui.runtime.clearCompactionArcadeGame("company.dodger")`.

## Footer Entries

Use `setFooterEntry()` when multiple packages need to contribute to the footer without replacing the whole footer.

```tsx
/** @jsxImportSource @opentui/solid */

export default {
  id: "company.footer",
  async tui(api) {
    api.ui.runtime.setFooterEntry(
      "company.plan",
      () => <text fg={api.theme.current.info}>Plan: enterprise</text>,
      { order: 30 },
    )
  },
}
```

Use `setFooter()` only when one package intentionally owns the complete footer.

## Floating Overlays

Use `api.ui.overlay.open()` for temporary floating UI owned by a plugin: side-chat helpers, checklists, short inspectors, or contextual command surfaces. Overlays are not PTYs and are not the host-owned Memory Center side-chat; they are plugin-rendered Solid surfaces that can be opened from commands and closed by ID or via the render context.

```tsx
/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import { useKeyboard } from "@opentui/solid"

function PluginSideChat(props: { close: () => boolean }) {
  const [draft, setDraft] = createSignal("")
  const [history, setHistory] = createSignal(["Plugin side-chat ready"])

  useKeyboard((event) => {
    if (event.name === "escape" || event.sequence === "q") props.close()
    if (event.name === "backspace") setDraft((value) => value.slice(0, -1))
    if (event.name === "return" && draft().trim()) {
      setHistory((items) => [...items.slice(-5), `You: ${draft().trim()}`])
      setDraft("")
    }
    if (event.sequence && event.sequence.length === 1) setDraft((value) => value + event.sequence)
  })

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg="cyan">Plugin Side Chat</text>
      {history().map((line) => <text wrapMode="truncate">{line}</text>)}
      <text fg="gray">› {draft() || "type, Enter to add, Esc/q to close"}</text>
    </box>
  )
}

export default {
  id: "company.side-chat-overlay",
  async tui(api) {
    api.command.register(() => [
      {
        title: "Open Plugin Side Chat",
        value: "company.side-chat.open",
        category: "Company",
        onSelect() {
          api.ui.overlay.open(
            "company.side-chat",
            (context) => <PluginSideChat close={context.close} />,
            {
              title: "Plugin Side Chat",
              anchor: "bottom-right",
              width: "38%",
              height: 12,
              modal: false,
            },
          )
        },
      },
    ])
  },
}
```

Plugin overlays are automatically cleaned up when a plugin is deactivated or disposed by the runtime wrapper. If the plugin closes the overlay itself, call `api.ui.overlay.close("company.side-chat")` or `context.close()`.

Use the right surface for the job:

- **Memory Center side-chat:** host-owned memory review UI and graph proposals.
- **Plugin floating side-chat:** plugin-owned temporary overlay using `api.ui.overlay.open()`.
- **External TUI app:** requires PTY/pane support; `shell.spawn()` and overlays do not emulate full-screen terminal apps like `graf` or `cava`.

## Slots

Slots let a plugin inject or replace named UI regions. Built-in host slots include:

- `app`
- `home_logo`
- `home_prompt`
- `home_prompt_right`
- `home_bottom`
- `home_footer`
- `session_prompt`
- `session_prompt_right`
- `sidebar_title`
- `sidebar_content`
- `sidebar_footer`

The most common customization targets are:

- `home_logo`: replace the home title/mascot surface.
- `home_prompt`: replace the whole home prompt editor surface.
- `home_prompt_right`: add small right-side prompt context without replacing the editor.
- `session_prompt`: replace the session prompt editor surface.
- `session_prompt_right`: add session-specific prompt context.
- `home_footer` / `sidebar_footer`: add persistent low-noise team status.

```tsx
/** @jsxImportSource @opentui/solid */

export default {
  id: "company.slots",
  async tui(api) {
    api.slots.register({
      slots: {
        home_footer() {
          return <text fg={api.theme.current.textMuted}>ACME secure workspace</text>
        },
        session_prompt_right(props) {
          return <text fg={api.theme.current.accent}>{props.session_id.slice(0, 8)}</text>
        },
      },
    })
  },
}
```

When consuming slots inside a custom route or component, use `api.ui.Slot`. Slot mode follows the opentui Solid slot model and can be used by host components to append, prepend, or replace default content.

For static home identity, prefer the profile fields documented in [Customization](customization.md): `identity.logoMode`, `identity.productName`, `identity.logoFont`, `surfaces.homeLogo`, and `surfaces.homeWelcome`. Use slots when the content needs runtime data or interaction.

## Commands and Dialogs

Plugins can add command palette entries and slash commands. Use dialogs for interactive flows.

```tsx
/** @jsxImportSource @opentui/solid */

export default {
  id: "company.commands",
  async tui(api) {
    api.command.register(() => [
      {
        title: "Open Company Checklist",
        value: "company.checklist",
        description: "Show release checklist",
        category: "Company",
        slash: {
          name: "checklist",
          aliases: ["shipcheck"],
        },
        onSelect() {
          api.ui.dialog.replace(() => (
            <api.ui.Dialog
              size="large"
              onClose={() => api.ui.dialog.clear()}
            >
              <box flexDirection="column" padding={1}>
                <text fg={api.theme.current.accent}>Release checklist</text>
                <text>Docs, tests, secrets, branches, Dependabot.</text>
              </box>
            </api.ui.Dialog>
          ))
        },
      },
    ])
  },
}
```

## Routes

Use routes for full-screen plugin views.

```tsx
/** @jsxImportSource @opentui/solid */

export default {
  id: "company.routes",
  async tui(api) {
    api.route.register([
      {
        name: "company-dashboard",
        render() {
          return (
            <box flexDirection="column" padding={1}>
              <text fg={api.theme.current.accent}>Company Dashboard</text>
              <text>Sessions: {api.state.session.count()}</text>
            </box>
          )
        },
      },
    ])

    api.command.register(() => [
      {
        title: "Company Dashboard",
        value: "company.dashboard",
        category: "Company",
        onSelect() {
          api.route.navigate("company-dashboard")
        },
      },
    ])
  },
}
```

## Themes

Plugins can install themes shipped beside the plugin file or package.

```tsx
export default {
  id: "company.theme",
  async tui(api, options) {
    if (typeof options?.theme_path === "string") {
      await api.theme.install(options.theme_path)
      api.theme.set("company-dark")
    }
  },
}
```

```jsonc
{
  "plugin": [
    [
      "./.mendcode/plugins/company-theme.ts",
      {
        "theme_path": "./.mendcode/themes/company-dark.json"
      }
    ]
  ]
}
```

## Keybinds and State

Plugins receive the active keybind map, persistent plugin KV, app state, SDK client, renderer, theme, shell runner, and lifecycle signal.

```tsx
export default {
  id: "company.keys",
  async tui(api) {
    const keys = api.keybind.create(
      {
        openChecklist: "ctrl+alt+c",
      },
      api.tuiConfig.keybinds,
    )

    api.kv.set("lastLoadedAt", Date.now())

    api.event.on("session.updated", (event) => {
      if (api.lifecycle.signal.aborted) return
      api.ui.runtime.setStatus("company.session", event.properties.info.id)
    })
  },
}
```

## Package Distribution

Marketplace packages should include plugins, widgets, pages, tools, and components under `.mendcode/`, then activate them through package config.

```text
.mendcode/
  package.json
  mendcode.json
  plugins/
    company-tui.ts
  pages/
    company-dashboard.tsx
  tools/
    company-status.ts
  themes/
    company-dark.json
```

```jsonc
{
  "plugin": ["./plugins/company-tui.ts"],
  "plugin_enabled": {
    "company.tui": true
  }
}
```

Use package sync for team rollout:

```bash
mendcode marketplace create --include plugins,tuiProfile,themes,tools,pages
mendcode marketplace add-source company --type github --url https://github.com/YourOrg/company-mendcode-marketplace.git --channel team
mendcode marketplace install company-mend-package company
mendcode marketplace enable company-mend-package
```

## Rules

- Keep render functions deterministic and cheap.
- Use unique IDs for widgets, footer entries, statuses, routes, and plugins.
- Clear runtime state in `api.lifecycle.onDispose()` when the plugin owns persistent UI.
- Do not edit donor/runtime TUI files for company customization.
- Prefer package-distributed plugins over manual local edits.
- Do not use external plugin install flows for production rollout until they are enabled by MendCode registry policy.
