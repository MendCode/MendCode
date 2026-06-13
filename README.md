# MendCode

```text
      .-.       █▄ ▄█ █▀▀▀ █▄  █ █▀▀▄ █▀▀▀ █▀▀█ █▀▀▄ █▀▀▀
     (o o)      █ ▀ █ █▀▀▀ █ ▀ █ █  █ █    █  █ █  █ █▀▀▀
    /|[+]|\     ▀   ▀ ▀▀▀▀ ▀   ▀ ▀▀▀  ▀▀▀▀ ▀▀▀▀ ▀▀▀  ▀▀▀▀
   /_|___|_\
      \_/
```

MendCode is a terminal-first coding runtime built around the `mend` CLI, a MendCode-owned configuration layer, reusable runtime packages, optional mflow coordination, optional TSM/worktree orchestration, and a highly customizable terminal UI.

It is designed for people and teams who want a coding agent environment they can make their own: model-role presets, project packages, prompt chrome, bottom status, home layouts, ASCII titles, mascots, widgets, command palettes, and agent/session views without editing runtime internals.

## What You Can Customize

- Prompt input frame: full box, top/bottom rails, minimal panel, or ASCII box.
- Prompt marker: change the lead string shown before input, for example `❭`, `>`, `mend>`, or a team-specific marker.
- Prompt status: choose built-in status items, placement inside/outside the prompt, separator text, colors, and script-backed custom status.
- Home identity: generated ASCII title or ASCII mascot.
- Home layout: centered home screen or split home screen.
- Split home panel: quick actions (`Resume session`, `Open commands`, `Quit`) or Agent View.
- Agent View: background/global sessions grouped by needs-input, working, and completed state.
- Activity presentation: compact MendCode rendering with custom activity text and mascot states for thinking, reading, running commands, patching, testing, blocked, done, and error.
- Packages: share `.mendcode` commands, agents, modes, skills, plugins, themes, widgets, and TUI profiles across a team.

## Documentation

- [Documentation index](docs/README.md): start here.
- [CLI, setup, and configuration](docs/cli-setup-configuration.md): commands, setup state, config paths, models, providers, permissions, memory.
- [Customization](docs/customization.md): prompt input, prompt marker, home centered/split modes, Agent View, ASCII title/mascot, activity events, examples, and AI prompt for creating mascots.
- [TUI plugins and widgets](docs/tui-plugins-and-widgets.md): plugin entrypoints, slots, status rows, widgets, dialogs, routes, themes, and package distribution.
- [Packages and team sharing](docs/packages-and-team-sharing.md): share commands, agents, modes, skills, prompts, widgets, TUI profile, and models.
- [mflow coordination](docs/mflow.md): optional same-worktree coordination and local edit locks.
- [TSM and worktrees](docs/tsm-and-worktrees.md): optional TSM/worktree flow with preview-first safety.
- [Architecture and packages](docs/architecture.md): source layout, runtime boundary, and MendCode-owned subsystems.
- [Releasing](docs/releasing.md), [Supply chain security](docs/supply-chain-security.md), [Community](docs/community.md), [Public readiness audit](docs/public-readiness-audit.md).
- [Lineage and acknowledgements](ACKNOWLEDGEMENTS.md): opencode attribution and MendCode downstream scope.

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash
mend
```

Development source currently lives under `src/mendcode`.

## Example TUI Setup

A good power-user setup is:

- `identity.logoMode: "mascot"`
- `surfaces.homeWelcome.mode: "split"`
- `surfaces.homeWelcome.rightPanel: "agentManager"`
- `promptChrome.preset: "top-bottom"` or `"ascii-box"`
- `promptStatus.placementByPreset["top-bottom"]: "outside"`
- a compact custom bottom status script for branch, package, provider, context, and permissions
- command hints hidden unless you want reminders

That gives you a mascot/title identity on the left, live agent/session state on the right, and a clean prompt surface at the bottom. Use `Ctrl+P` to open the command palette and search for Home, Prompt, Presentation, Agent, or Status commands.

## Lineage

MendCode is a downstream project built on the opencode codebase. It is not presented as a simple fork: MendCode adds its own `mend` CLI surface, control plane, setup flow, package system, mflow coordination, optional TSM/worktree orchestration, and terminal UI customization layer. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for attribution.
