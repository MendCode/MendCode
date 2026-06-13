# Package Index

This page maps the main packages in `src/mendcode/packages`.

## Runtime Packages

| Package | Purpose |
| --- | --- |
| `packages/opencode` | Main MendCode runtime, CLI, server, TUI, setup flow, mflow, TSM/worktree integration, model/provider runtime, and release build script. |
| `packages/core` | Shared core utilities used by runtime packages. |
| `packages/plugin` | Public plugin/tool/TUI extension SDK, including `@mendcode/plugin/tui`. |
| `packages/ui` | Shared UI components, themes, assets, markdown/diff rendering, and frontend UI primitives. |
| `packages/sdk/js` | Generated JavaScript SDK package. |
| `packages/script` | Shared release and maintenance script helpers. |
| `packages/slack` | Slack integration package. |
| `packages/function` | Cloud/function-side integration package. |

## App and Extension Packages

| Path | Purpose |
| --- | --- |
| `packages/app` | Web app surface embedded or served by the runtime. |
| `packages/console` | Console app/resources where present. |
| `packages/extensions` | Editor extension metadata and release references. |
| `sdks/vscode` | VS Code extension package. |

## Package Sharing

MendCode runtime packages are different from npm workspace packages. Runtime packages are shareable `.mendcode` bundles for teams and companies.

Use:

```bash
mend packages status
mend packages create --include skills,modes,plugins,tuiProfile
mend packages install github:YourOrg/company-mend-package
mend packages enable company-mend-package
```

See [Packages and team sharing](packages-and-team-sharing.md) for the team workflow.

## Plugin and Widget Packages

TUI plugins can be distributed inside runtime packages:

```text
.mendcode/
  plugins/
    company-tui.ts
  themes/
    company-dark.json
  mendcode.json
```

See [TUI plugins and widgets](tui-plugins-and-widgets.md).
