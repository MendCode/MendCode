# MendCode

MendCode is a terminal-first coding runtime built around the `mend` CLI, a MendCode-owned configuration layer, reusable runtime packages, optional mflow coordination, optional TSM/worktree orchestration, and a customizable terminal UI.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture and packages](docs/architecture.md)
- [CLI, setup, and configuration](docs/cli-setup-configuration.md)
- [Customization](docs/customization.md)
- [TUI plugins and widgets](docs/tui-plugins-and-widgets.md)
- [Packages and team sharing](docs/packages-and-team-sharing.md)
- [mflow coordination](docs/mflow.md)
- [TSM and worktrees](docs/tsm-and-worktrees.md)
- [Public readiness audit](docs/public-readiness-audit.md)
- [Lineage and acknowledgements](ACKNOWLEDGEMENTS.md)

## Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash
mend
```

Development source currently lives under `src/mendcode`.

## Lineage

MendCode is a downstream project built on the opencode codebase. It is not presented as a simple fork: MendCode adds its own `mend` CLI surface, control plane, setup flow, package system, mflow coordination, optional TSM/worktree orchestration, and terminal UI customization layer. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for attribution.
