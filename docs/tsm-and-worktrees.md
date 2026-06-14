# TSM and Worktrees

MendCode has two related but separate concepts:

- Worktree management: MendCode-owned registry, dry-run plans, adoption, and safety previews.
- TSM integration: optional external terminal-session/worktree executor.

TSM is not required to use MendCode. It is an optional accelerator when installed and activated.

## Worktree Commands

```bash
mendcode worktree status
mendcode worktree plan feature-name --branch feature/feature-name
mendcode worktree create feature-name
mendcode worktree open <id|branch|path>
mendcode worktree adopt <path|branch>
mendcode worktree remove <id|branch|path>
mendcode worktree reset <id|branch|path>
mendcode worktree doctor
```

Current safety posture:

- `plan` writes a dry-run plan.
- `create` currently reports `executesGit: false`.
- `open` does not execute Git or TSM.
- external worktrees are visible but not owned.
- destructive actions return previews and report `executesGit: false`.
- external worktrees must be adopted before MendCode treats them as owned.

## `mendcode --worktree`

```bash
mendcode --worktree [branch|path|id]
```

This shortcut opens MendCode in a known git worktree. If no target is passed, MendCode resolves a safe target only when the current repo state is unambiguous. If multiple targets exist, pass the branch, path, or registry id.

## TSM Lifecycle

Inspect:

```bash
mendcode tsm status
mendcode tsm plan
mendcode tsm doctor
```

Setup/activate/deactivate/remove:

```bash
mendcode tsm setup
mendcode tsm activate
mendcode tsm deactivate
mendcode tsm remove
```

TSM status detects a `tsm` binary but does not install it. The TSM plan includes install suggestions, but `executesInstall` is false.

## `mendcode --tsm`

```bash
mendcode --tsm [branch|path|id]
mendcode --tsm --all
```

This shortcut requires:

- TSM lifecycle is `active`.
- detected TSM binary advertises worktree support.
- target resolves to a branch-backed worktree, unless `--all` is used.

When valid, MendCode runs:

```bash
tsm wt open <branch> --split mendcode
```

or for all:

```bash
tsm wt open --split mendcode
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
mendcode worktree status
mendcode worktree doctor
mendcode tsm status
mendcode tsm doctor
```

Do not treat unowned external worktrees as disposable. Adopt them first, then use preview output before destructive operations.
