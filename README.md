# MendCode

MendCode is a customizable coding-agent harness for the terminal. It packages the `mendcode` CLI, model-role configuration, permission policy, memory, reusable team packages, mflow coordination, optional TSM/worktree orchestration, and a highly customizable TUI into one MendCode-owned runtime.

It is built for developers and teams who want their coding agent environment to match how they actually work: the models they trust, the prompts they use, the context they share, the permission posture they need, and the terminal interface they want to live in all day.

## Why MendCode

- Configure the harness: choose provider/model defaults, model roles, prompt context modes, budget posture, permissions, memory behavior, and TUI profile without editing runtime internals.
- Package your workflow: share `.mendcode` commands, agents, modes, skills, prompts, MCP files, widgets, plugins, themes, model policy, and worktree policy as reusable team packages.
- Review before execution: Plan Mode renders a Markdown plan in an interactive TUI modal, lets you approve, edit, comment, or reject it, then switches to your configured implementation agent.
- Coordinate local agents: use optional mflow locks and optional TSM/worktree flows when multiple sessions or worktrees need a safer operating model.
- See the work: Usage Insights surfaces daily token activity, sessions, AI time, user prompts, token mix, top tools, top agents, top models, and optional Open-Meteo weather.

## Install

Pick the command for your OS, then open a new terminal and run `mendcode`.

<details open>
<summary><strong>macOS</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash
mendcode
```

The installer detects Apple Silicon vs Intel automatically and installs the latest release into `~/.mendcode/bin`.

</details>

<details>
<summary><strong>Linux</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash
mendcode
```

The installer detects x64 vs arm64, glibc vs musl/Alpine, and baseline CPU builds automatically.

</details>

<details>
<summary><strong>Windows PowerShell</strong></summary>

```powershell
irm https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install.ps1 | iex
mendcode
```

The PowerShell installer detects x64, x64 baseline, and arm64 release assets automatically.

</details>

<details>
<summary><strong>Windows Git Bash / WSL</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash
mendcode
```

Use this option if you already work from Git Bash, MSYS2, Cygwin, or WSL and want the same auto-detection flow as macOS/Linux.

</details>

To pin a specific version:

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash -s -- --version <version>
```

To install without editing shell startup files:

```bash
curl -fsSL https://raw.githubusercontent.com/MendCode/MendCode/main/src/mendcode/install | bash -s -- --no-modify-path
```

The public install contract is `mendcode`. Development checkouts may contain a local `mend` shim for legacy/internal workflows, but public docs, examples, and screenshots should use `mendcode`.

## Product Surfaces

### Terminal UI

The TUI can be shaped from config or the command palette:

- Prompt input frame: `box`, `top-bottom`, `minimal`, or `ascii-box`.
- Prompt marker: examples include `❭`, `>`, `mendcode>`, `ship>`, or a team marker.
- Prompt status: mode, model, provider, reasoning, context, permission mode, command hints, and script-backed custom status.
- Home identity: generated ASCII title or custom ASCII mascot.
- Home layout: centered welcome or split view with Agent View.
- Agent View: background/global sessions grouped by needs-input, working, and completed state.
- Chat presentation: raw, minimal, or MendCode activity-oriented rendering.

Screenshot slots for the README:

| Slot | Capture | Use |
| --- | --- | --- |
| `docs/assets/screenshots/home-agent-view.png` | Home split with Agent View and at least one working or needs-input session. | First visual proof that MendCode is more than a chat prompt. |
| `docs/assets/screenshots/prompt-top-bottom.png` | `top-bottom` prompt with `mendcode>` marker and status row. | Show prompt chrome, marker, model/provider/context status. |
| `docs/assets/screenshots/usage-insights.png` | Usage Insights global dashboard. | Show product telemetry without ROI claims. |

Do not add these image links until the files exist; broken screenshots make the README look less ready than no screenshots.

### Plan Mode

Plan Mode turns planning into an explicit review step. MendCode renders the plan in a TUI modal, including Markdown and Mermaid/flowcharts when supported. Approve it, edit it, add implementation comments, or reject it. When approved, MendCode switches to the configured implementation agent and continues from the reviewed plan.

See [Plan Mode](docs/plan-mode.md).

### Usage Insights

Usage Insights is a TUI dashboard for local activity: daily token heatmap, global/project scope, token mix, sessions, AI generation time, user prompt volume, changed files, top tools, top agents, top models, cached stats loading, and optional weather.

See [Usage Insights](docs/usage-insights.md).

## Documentation

- [Docs index](docs/README.md): start by user journey.
- [CLI, setup, and configuration](docs/cli-setup-configuration.md): install/open commands, setup state, config paths, focus profiles, model roles, prompt modes, permissions, and memory.
- [Customization](docs/customization.md): prompt input, input marker, home centered/split modes, Agent View, ASCII title/mascot, activity events, screenshot capture plan, and team profile examples.
- [Plan Mode](docs/plan-mode.md): plan review modal, approve/edit/comment/reject flow, and post-approval implementation mode.
- [Usage Insights](docs/usage-insights.md): dashboard fields, scopes, shortcuts, weather, and screenshot plan.
- [Packages and team sharing](docs/packages-and-team-sharing.md): package your harness for a team.
- [TUI plugins and widgets](docs/tui-plugins-and-widgets.md): plugin entrypoints, slots, widgets, routes, dialogs, footer/status entries, and package distribution.
- [mflow coordination](docs/mflow.md): optional same-worktree coordination and local edit locks.
- [TSM and worktrees](docs/tsm-and-worktrees.md): optional TSM/worktree flow with preview-first safety.
- [Architecture and packages](docs/architecture.md): source layout, runtime boundary, and MendCode-owned subsystems.
- [Releasing](docs/releasing.md), [Supply chain security](docs/supply-chain-security.md), [Community](docs/community.md), [Public readiness audit](docs/public-readiness-audit.md).
- [Lineage and acknowledgements](ACKNOWLEDGEMENTS.md): opencode attribution and MendCode downstream scope.

## Example TUI Setup

A good power-user setup is:

- `identity.logoMode: "mascot"`
- `surfaces.homeWelcome.mode: "split"`
- `surfaces.homeWelcome.rightPanel: "agentManager"`
- `promptChrome.preset: "top-bottom"` or `"ascii-box"`
- `promptChrome.glyphs.leadText: "mendcode>"`
- `promptStatus.placementByPreset["top-bottom"]: "outside"`
- a compact custom bottom status script for branch, package, provider, context, and permissions
- command hints hidden unless you want reminders

That gives you a mascot/title identity, live agent/session state, and a clean prompt surface at the bottom. Use `Ctrl+P` to open the command palette and search for Home, Prompt, Presentation, Agent, Status, or Usage Insights commands.

## Lineage

MendCode is a downstream project built on the opencode codebase. It is not presented as a simple fork: MendCode adds its own `mendcode` CLI surface, control plane, setup flow, package system, mflow coordination, optional TSM/worktree orchestration, Plan Mode review flow, Usage Insights dashboard, memory policy, model-role projection, and terminal UI customization layer. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for attribution.
