# TSM and Worktrees

MendCode has two related but separate concepts:

- Worktree management: MendCode-owned registry, dry-run plans, adoption, and safety previews.
- TSM integration: optional external terminal-session/worktree executor.

TSM is not required to use MendCode. It is an optional accelerator when installed and activated.

## Worktree Commands

```bash
mend worktree status
mend worktree plan feature-name --branch mend/feature-name
mend worktree create feature-name
mend worktree open <id|branch|path>
mend worktree adopt <path|branch>
mend worktree remove <id|branch|path>
mend worktree reset <id|branch|path>
mend worktree doctor
```

Current safety posture:

- `plan` writes a dry-run plan.
- `create` currently reports `executesGit: false`.
- `open` does not execute Git or TSM.
- external worktrees are visible but not owned.
- destructive actions return previews and report `executesGit: false`.
- external worktrees must be adopted before MendCode treats them as owned.

## `mend --worktree`

```bash
mend --worktree [branch|path|id]
```

This shortcut opens MendCode in a known git worktree. If no target is passed, MendCode resolves a safe target only when the current repo state is unambiguous. If multiple targets exist, pass the branch, path, or registry id.

## TSM Lifecycle

Inspect:

```bash
mend tsm status
mend tsm plan
mend tsm doctor
```

Setup/activate/deactivate/remove:

```bash
mend tsm setup
mend tsm activate
mend tsm deactivate
mend tsm remove
```

TSM status detects a `tsm` binary but does not install it. The TSM plan includes install suggestions, but `executesInstall` is false.

## `mend --tsm`

```bash
mend --tsm [branch|path|id]
mend --tsm --all
```

This shortcut requires:

- TSM lifecycle is `active`.
- detected TSM binary advertises worktree support.
- target resolves to a branch-backed worktree, unless `--all` is used.

When valid, MendCode runs:

```bash
tsm wt open <branch> --split mend
```

or for all:

```bash
tsm wt open --split mend
```

## TSM Is an Executor, Not Source of Truth

MendCode owns:

- worktree registry
- adoption/ownership state
- safety previews
- package projections
- mflow mode
- cleanup policy

TSM provides optional terminal/session execution. It should not independently decide what worktrees are safe to delete, reset, or mutate.

## Safety Checklist

Before live worktree operations, check:

```bash
mend worktree status
mend worktree doctor
mend tsm status
mend tsm doctor
```

Do not treat unowned external worktrees as disposable. Adopt them first, then use preview output before destructive operations.
