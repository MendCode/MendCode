# Customization

MendCode customization is centered on `.mendcode/` config plus optional runtime packages. The goal is that a person, team, or company can keep the same terminal behavior without editing runtime internals.

## TUI Profile

The active TUI profile is a JSON profile with these main sections:

- `identity`: product name, tagline, logo mode, logo font.
- `theme`: dark/light mode, palette, color tokens.
- `layout`: density, spacing, borders, width, header/footer/sidebar/session/prompt zones.
- `widgets`: enabled widget IDs, order, and widget config.
- `surfaces`: model/provider/status visibility, home logo, home welcome layout.
- `promptChrome`: prompt frame style, glyphs, and preset.
- `promptStatus`: left/right status items and script-backed status.
- `workingIndicator`: visible thinking/working text and token/elapsed display.
- `presentation`: raw/minimal/mendcode rendering, reasoning visibility, activity placement, mascot, completion symbol.
- `rollback`: profile rollback metadata.

Inspect it with:

```bash
mend tui status
mend tui profile
mend tui preview
```

## Prompt Chrome

Prompt chrome controls the terminal prompt wrapper: borders, glyphs, status slots, right-side prompt surfaces, and preset behavior. Use it for company-specific terminal identity without changing the model prompt.

Typical customization points:

- prompt border/glyphs
- left/right status labels
- command hints
- provider/model visibility
- compact vs rich prompt status

## ASCII Logo and Mascot

MendCode supports title-style and mascot-style identity:

- `identity.logoMode`: `title` or `mascot`
- `identity.logoFont`: `classic`, `mendcode`, `small`, `standard`, or `shadow`
- `surfaces.homeLogo.text`: custom ASCII home logo
- `surfaces.homeLogo.size`: `compact`, `default`, or `large`
- `presentation.activity.mascot.states`: ASCII mascot states for phases like `thinking`, `editing`, `running`, `testing`, `done`, and `error`

Example profile snippet:

```json
{
  "identity": {
    "productName": "AcmeCode",
    "tagline": "company coding runtime",
    "logoMode": "mascot",
    "logoFont": "mendcode"
  },
  "surfaces": {
    "homeLogo": {
      "text": "ACME\\nCODE"
    }
  }
}
```

## Widgets and TUI Plugins

The `@mendcode/plugin` package exposes:

- custom tools
- TUI routes
- commands
- dialogs
- prompt components
- toasts
- themes
- slots/widgets

Package artifacts can include widget files under `.mendcode/widgets`, `.mendcode/components`, or `.mendcode/scripts`. Runtime packages project them into the active runtime package state.

See [TUI plugins and widgets](tui-plugins-and-widgets.md) for concrete examples of `setWidget`, `setFooterEntry`, slots, dialogs, commands, routes, themes, and team package distribution.

## Model Customization

Model behavior is controlled by model roles. This lets a team use one model for build/code, another for review, and cheaper models for title/summary/compaction.

```bash
mend models status
mend models presets
mend models set-default openai gpt-5.2 --auth-mode api-key --enable
mend models plan
```

When `models.yaml` has `enabled: false`, roles are documented but not projected into the generated runtime config. The CLI supports `set-default` and `use-preset`; edit `models.yaml` for role-specific overrides such as `build`, `review`, `subagent`, `title`, and `compaction`.

## Safe Customization Rule

Prefer these extension points:

- `.mendcode/mendcode.json`
- `.mendcode/tui/profile.json`
- `.mendcode/models.yaml`
- `.mendcode/commands`
- `.mendcode/agents`
- `.mendcode/modes`
- `.mendcode/skills`
- `.mendcode/plugins`
- `.mendcode/widgets`
- runtime packages

Avoid editing protected donor/runtime hot paths for normal customization.
