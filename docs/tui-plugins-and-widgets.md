# TUI Plugins and Widgets

MendCode TUI plugins are local or packaged JavaScript/TypeScript modules that extend the terminal UI without editing runtime internals. They are the right place for company dashboards, status lines, prompt-side context, custom footers, command palettes, dialogs, routes, themes, and editor widgets.

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
      },
    )

    api.lifecycle.onDispose(() => {
      api.ui.runtime.clearWidget("company.review")
    })
  },
}
```

Use unique widget IDs. Reusing an ID replaces the previous render function for that widget.

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

Plugins receive the active keybind map, persistent plugin KV, app state, SDK client, renderer, theme, and lifecycle signal.

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

Company packages should include plugins and widgets under `.mendcode/plugins`, `.mendcode/widgets`, or `.mendcode/components`, then activate them through package config.

```text
.mendcode/
  package.json
  mendcode.json
  plugins/
    company-tui.ts
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
mend packages create --include plugins,tuiProfile,themes
mend packages install github:YourOrg/company-mend-package
mend packages enable company-mend-package
```

## Rules

- Keep render functions deterministic and cheap.
- Use unique IDs for widgets, footer entries, statuses, routes, and plugins.
- Clear runtime state in `api.lifecycle.onDispose()` when the plugin owns persistent UI.
- Do not edit donor/runtime TUI files for company customization.
- Prefer package-distributed plugins over manual local edits.
- Do not use external plugin install flows for production rollout until they are enabled by MendCode registry policy.
