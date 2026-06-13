# MendCode Docs

These docs describe the MendCode-specific runtime layer in this repository. They focus on MendCode-owned behavior: the `mend` CLI, `.mendcode/` config, setup flow, packages, model roles, prompt/TUI customization, mflow, optional TSM/worktrees, and release/security policy.

If you only read one page after this index, read [Customization](customization.md). It explains the user-visible surface people ask about most often: prompt input, input marker, home centered vs split layout, Agent View, ASCII title/mascot, mascot activity states, and examples for team profiles.

## Start Here

1. [CLI, setup, and configuration](cli-setup-configuration.md): install/open commands, setup state, config paths, model roles, providers, auth, permissions, and memory.
2. [Customization](customization.md): prompt input, input marker, prompt status, home centered/split modes, Agent View, ASCII title/mascot, mascot events, examples, and AI prompt for mascot creation.
3. [TUI plugins and widgets](tui-plugins-and-widgets.md): custom status rows, editor widgets, slots, command palette entries, slash commands, dialogs, routes, themes, keybinds, and package distribution.
4. [Packages and team sharing](packages-and-team-sharing.md): package manifests, local snapshots, GitHub/team registries, and sharing one company package.
5. [Architecture and packages](architecture.md): repo layout, owned runtime, package list, runtime boundary, and safety model.

## Coordination and Worktrees

- [mflow coordination](mflow.md): what mflow is, setup, relay modes, file locks, and multi-agent same-worktree editing.
- [TSM and worktrees](tsm-and-worktrees.md): `mend --worktree`, `mend --tsm`, optional TSM lifecycle, preview-first worktree safety.

## Reference

- [Package index](package-index.md): source package map and runtime package distinction.
- [Releasing](releasing.md): release assets, installer contract, checksums, and smoke tests.
- [Supply chain security](supply-chain-security.md): release provenance, SBOM, pinned actions, dependency review, and scanner policy.
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

## TUI Customization Commands

Most visual changes can be made from the command palette:

```text
Ctrl+P -> Home identity
Ctrl+P -> Home title text
Ctrl+P -> Home title font
Ctrl+P -> Home ASCII size
Ctrl+P -> Home welcome mode
Ctrl+P -> Home split panel
Ctrl+P -> Prompt chrome
Ctrl+P -> Prompt lead string
Ctrl+P -> Prompt status placement
Ctrl+P -> Chat presentation
```

You can also inspect the active profile from the CLI:

```bash
mend tui status
mend tui profile
mend tui preview
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
