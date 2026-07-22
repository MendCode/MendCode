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
import type { TuiPluginApi } from "@mendcode/plugin/tui"

function CommandWidget(props: { api: TuiPluginApi }) {
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

## Pages, Modals, and AI

MendCode does not require a separate page framework. A plugin page is a registered route rendered with OpenTUI Solid. A modal is either the host dialog stack or a plugin-owned overlay. Both surfaces can use the same session and AI APIs as the rest of the TUI.

```tsx
/** @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid"
import { createSignal } from "solid-js"
import type { TuiPluginApi } from "@mendcode/plugin/tui"

function AssistantModal(props: { api: TuiPluginApi; sessionID: string }) {
  const [answer, setAnswer] = createSignal("Ask this session anything")
  const ai = props.api.ai.open(props.sessionID)

  useKeyboard((event) => {
    if (event.name !== "return") return
    void ai.prompt("Summarize the current session in five bullets.").then((result) => {
      setAnswer(JSON.stringify(result.data ?? result.error ?? result))
    })
  })

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg={props.api.theme.current.accent}>Session assistant</text>
      <text wrapMode="word">{answer()}</text>
      <text fg={props.api.theme.current.textMuted}>Press Enter to summarize. Use Esc to close.</text>
    </box>
  )
}

export default {
  id: "company.session-assistant",
  async tui(api: TuiPluginApi) {
    api.command.register(() => [
      {
        title: "Open session assistant",
        value: "company.session-assistant.open",
        onSelect() {
          const sessionID = api.session.current()
          if (!sessionID) return
          api.ui.dialog.replace(() => (
            <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}>
              <AssistantModal api={api} sessionID={sessionID} />
            </api.ui.Dialog>
          ))
        },
      },
    ])
  },
}
```

For a plugin-owned side chat, use `api.ui.overlay.open()` instead of the dialog stack. Set `modal: true` when the overlay should capture attention, call `api.ui.overlay.focus(id)` after opening, and use `context.close()`, `context.focus()`, or `context.blur()` from the renderer. Set `allowStack: true` when the plugin intentionally owns more than one overlay.

`api.ai.create()` creates a persistent MendCode session that can power a page or modal. `api.ai.open(sessionID)` wraps an existing session. AI handles expose `prompt`, `promptAsync`, `messages`, `update`, `abort`, and `delete`; delete the session explicitly when it is temporary. Plugin disposal removes UI registrations, but it does not silently delete sessions or memory.

## Session and Metadata API

The TUI plugin API exposes the same generated SDK contracts used by MendCode itself, with the current route and host client already available:

```ts
const sessionID = api.session.current()
const sessions = await api.session.list({})
const status = await api.session.status({})

if (sessionID) {
  const session = await api.session.get({ sessionID })
  const messages = await api.session.messages({ sessionID })
  await api.metadata.patch({
    sessionID,
    agentViewMetadataPatch: {
      title: "Release review",
      tags: ["release", "review"],
      priority: "high",
      pinned: true,
    },
  })
}
```

`api.session` includes `list`, `create`, `status`, `delete`, `get`, `update`, `children`, `todo`, `diff`, `messages`, `prompt`, `promptAsync`, `command`, `shell`, `deleteMessage`, `message`, `fork`, `abort`, `interrupt`, `init`, `summarize`, `revert`, `unrevert`, `background`, `agentView`, and `agentCommand`.

`api.metadata` includes `list`, `get`, `patch`, `getCurrent`, and `current`. Metadata changes are control-plane changes: they update title, tags, grouping, priority, notes, pin, and archive state without rewriting the transcript.

For endpoints not yet wrapped by a convenience method, `api.client` is the generated `OpencodeClient`. It is intentionally part of the public contract, so a plugin can use the same authenticated instance and request context without importing MendCode internals.

## Memory Graph API

Memory graph access is project-scoped to the active TUI instance. Plugins can inspect the graph, create or update facts, create or update links, delete either, and call the structured Memory side chat:

```ts
const snapshot = await api.memory.graph()
const fact = await api.memory.upsertGraphFact({
  text: "The release checklist lives in .mendcode/checklists/release.md",
  scope: "project",
  categoryIDs: ["workflow"],
  provenance: ["company.release-plugin"],
  confidence: 0.9,
})

const link = await api.memory.upsertGraphLink({
  from: fact.id,
  to: snapshot.facts[0]?.id ?? fact.id,
  kind: "related",
})

await api.memory.deleteGraphLink(link.id)
await api.memory.deleteGraphFact(fact.id)

const proposal = await api.memory.sideChat({
  message: "Suggest a safe graph fact for the selected release context.",
})
```

Graph facts expose identity, scope, ownership, categories, provenance, timestamps, confidence, durability, change risk, sensitivity, stale state, and retrieval priority. Graph links include their IDs and creation timestamps, so a plugin can edit and remove the exact object it created. `api.memory.graph()` is read-only; graph writes are explicit and persist under the active project's MendCode memory directory.

## Public API Surface

The complete public TUI contract is exported from `@mendcode/plugin/tui`:

| Surface | Public API | Typical use |
| --- | --- | --- |
| Pages | `route.register`, `route.navigate`, `route.current` | Full-screen dashboards, settings, inspectors, sidebars |
| Modals | `ui.dialog`, `ui.Dialog*` | Confirmations, forms, selectors, AI workflows |
| Floating UI | `ui.overlay` | Side chats, inspectors, popovers, non-capturing status panels |
| Editor | `ui.Prompt`, `ui.runtime.setEditor`, `setEditorVisual` | Replace or decorate prompt input |
| Persistent UI | `ui.runtime.setWidget`, `setFooter`, `setFooterEntry`, `setStatus` | Panels, footer data, status indicators |
| Session AI | `session`, `metadata`, `ai` | Create, inspect, prompt, organize, and stop sessions |
| Memory | `memory` | Read and mutate graph facts/links and call Memory side chat |
| Host state | `state`, `event`, `client` | React to events and inspect synced TUI state |
| Terminal work | `shell`, `pty`, `renderer` | Commands, renderer integrations, and future PTY-backed surfaces |
| Interaction | `command`, `keybind`, `slots`, `theme`, `kv` | Commands, shortcuts, injection points, themes, persistence |
| Lifecycle | `lifecycle` | Abort signals and deterministic cleanup |

`api.app.capabilities` reports the host capability vocabulary (`session.ai`, `metadata.write`, `memory.graph.write`, `overlay.focus`, and related surfaces). It is a discovery aid, not a sandbox: local plugins run with the permissions of the MendCode process. Review third-party package source before enabling plugins that can execute shell commands, mutate sessions, or write memory.

`api.pty.spawn` is part of the stable type contract, but the default host currently rejects PTY creation with an explicit error. Use `api.shell.spawn` for non-interactive commands and overlays/widgets for UI until a PTY host is enabled; do not assume a pipe emulates a full terminal.

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
