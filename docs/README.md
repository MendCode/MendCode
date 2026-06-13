# MendCode Docs

These docs describe the MendCode-specific runtime layer in this repository. They intentionally focus on MendCode-owned behavior instead of the donor runtime internals.

## Start Here

- [Architecture and packages](architecture.md): repo layout, owned runtime, package list, and how the pieces fit.
- [CLI, setup, and configuration](cli-setup-configuration.md): `mend`, setup steps, config files, models, providers, memory, permissions.
- [Customization](customization.md): prompt chrome, TUI profile, widgets, title/logo/ASCII mascot, model roles.
- [TUI plugins and widgets](tui-plugins-and-widgets.md): custom widgets, slots, footer entries, commands, dialogs, routes, themes, and package distribution.
- [Packages and team sharing](packages-and-team-sharing.md): package manifests, local snapshots, GitHub/team registries, sharing one company package.
- [Package index](package-index.md): source package map and runtime package distinction.
- [mflow coordination](mflow.md): what mflow is, setup, relay modes, file locks, and multi-agent same-worktree editing.
- [TSM and worktrees](tsm-and-worktrees.md): `mend --worktree`, `mend --tsm`, optional TSM lifecycle, preview-first worktree safety.
- [Releasing](releasing.md): release assets, installer contract, checksums, and smoke tests.
- [Community](community.md): issues, discussions, PRs, and labels.
- [Wiki](wiki.md): GitHub wiki setup and doc sync.
- [Public readiness audit](public-readiness-audit.md): current branch, secret, and old-repo-reference audit notes.
- [Lineage and acknowledgements](../ACKNOWLEDGEMENTS.md): opencode attribution and MendCode downstream scope.

## Main Commands

```bash
mend
mend status
mend setup status
mend tui status
mend models status
mend packages status
mend mflow status
mend tsm status
mend worktree status
mend --worktree [branch|path|id]
mend --tsm [branch|path|id|--all]
```

## Source Map

- `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts`: public `mend` command router.
- `src/mendcode/packages/opencode/src/mend/config/project.ts`: project config, focus profiles, generated runtime config, package metadata.
- `src/mendcode/packages/opencode/src/mend/config/models.ts`: model roles and projection.
- `src/mendcode/packages/opencode/src/mend/config/mflow.ts`: local-first mflow setup, relay config, edit-lock enforcement.
- `src/mendcode/packages/opencode/src/mend/config/tsm.ts`: optional TSM lifecycle and detection.
- `src/mendcode/packages/opencode/src/mend/config/worktree.ts`: worktree status, dry-run planning, adoption, destructive previews.
- `src/mendcode/packages/opencode/src/mend/runtime/pack.ts`: runtime package snapshots.
- `src/mendcode/packages/opencode/src/mend/runtime/packages.ts`: installed package state and active package projection.
- `src/mendcode/packages/opencode/src/mend/profile.ts`: TUI profile schema and defaults.
- `src/mendcode/packages/plugin/src/tui.ts`: public TUI plugin/widget types.
