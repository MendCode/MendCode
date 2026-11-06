# Worktree manager (B30)

Use `/worktrees` to inspect the current Git checkout, linked worktrees, registry ownership, dirty state, session counts and saved plans. Open the page and select a worktree with the arrows.

## Inspect and preview worktrees

| Key | Does |
|---|---|
| Arrows | Select a worktree; scroll details and previews. |
| `c` | Open the name/branch/base/path/focus form. Tab changes fields; Enter saves a preview. |
| `o` or Enter | Resolve the selected target. |
| `a` | Adopt the selected target. |
| `x` | Preview removal. |
| `z` | Preview reset. |
| `d` | Run doctor. |
| `r` | Refresh. |
| Escape | Close the detail before leaving the page. |
| Tab | Switch list/detail focus. |
| Page Up/Down | Scroll details and previews. |

Saved plans stay visible in the detail panel.

From the balanced tier `/worktrees` and `/warp` open under the tabs of the [Git page](git.md); the workspace picker marks the rows with uncommitted changes (`dirty`, from `worktree.query`). Nothing else changes.

What worktrees cost on disk, and the merged/clean/idle cleanup (`storage --worktrees`, `worktreeGcDays`), is in
[storage.md](storage.md). `mendcode worktrees list|size|gc` shows and cleans them from the command line.

## A new session in its own worktree

Set `git.newSessionWorktree: true` to make `/new` and `/bg` create the session in a fresh workspace. The setting is off by default and needs the Git page, so it is available in balanced and full. With it off, nothing changes.

The new workspace starts from the project's current commit. Uncommitted changes stay where they are; they are not copied.

- If the project is not a Git repository, or the workspace cannot be made (the limit, git failing, a full disk), the session is created in the project folder as usual. One line says why.
- Remote clients do not use it.

### How the workspace is created

Before entering the new session, the terminal:

1. Asks for a worktree workspace (`workspace-create`, `type: "worktree"`, `branch: null`, no name).
2. Warps the new session into it (`workspace-warp`).

These are the same two requests `/warp` → New workspace sends. The daemon gives the folder and the `mend/` branch the names it gives there; there is no second worktree creator.

### Cleanup

These are ordinary daemon-created worktrees, listed in the Worktrees tab. Age-based cleanup (`worktreeGcDays`, `storage --worktrees`) uses the same rules: removal only when merged, clean, unused by any session and idle long enough. No separate cleanup exists.

A workspace holding a session is kept ("a session, loop or workflow works in it"). An unused one is removed after the idle days only when its branch has nothing unmerged.

## Move a session with `/warp`

`/warp` opens the workspace picker, backed by `project.rest` ([project-rest.md](project-rest.md)). It lists `New workspace`, the local project and the project's workspaces, with branch, current marker and missing-directory state.

1. Select a workspace.
2. Press Enter. The current session and its children move to it (`workspace-warp`), and the page returns to chat. The chat follows the `session.workspace.changed` event.

To create or register a workspace, press `c` or Enter on `New workspace`. The form takes a Name and an optional Directory:

| Input | Result |
|---|---|
| Name alone | Create a Git worktree workspace on a daemon-assigned branch. |
| Directory | Register that existing folder as a local workspace. |

The new workspace is warped into at once.

| Action | Does |
|---|---|
| `x` twice | Remove the selected workspace; the daemon refuses while sessions still live there. |
| `/warp NAME` | Move directly by name, branch, id or path. |
| `/warp local` | Move directly to the local project. |

Busy sessions, active turns and other daemon refusals show inside the page. Read-only remote peers get no workspace access: nothing is sent.

`/worktrees` is unchanged and stays preview-only; its open does not switch the session. The opt-in [TSM adapter](tsm.md) provides separate gated open/create previews.

## Preview from the command line

```text
mendcode --dir DATA [control-plane] worktree status|doctor --project PROJECT
mendcode --dir DATA [control-plane] worktree plan|create NAME --project PROJECT
  [--branch BRANCH] [--base REF] [--path PATH] [--focus auto|codex|claude|gemini|kimi|deepseek|mistral]
mendcode --dir DATA [control-plane] worktree open|adopt|remove|reset TARGET --project PROJECT
```

All commands support `--json` and the existing CLI envelope. Targets are ids, branches or paths.

| Result or option | Behavior |
|---|---|
| Unsuccessful preview | Exit 1. |
| Invalid arguments | Exit 64. |
| `--execute`, `--force` | Intentionally unavailable. |

Like v1 stable, create/open/remove/reset are **preview-only**. No branch, checkout, shell or session is changed. Nothing claims real execution approval.

### Plans and ownership

`plan`/`create` save a bounded plan. `adopt` saves ownership in the daemon's `<dir>/worktree-manager/<repository-id>.json`.

The id uses the canonical common Git directory, so linked checkouts share one registry. Defaults follow the v2 project focus; the default target lives under `<dir>/worktrees`, not a donor tree.

- Removal/reset previews require owned/adopted, clean, non-base, non-stale targets.
- Changed branches are reported as drifted.
- Adoption is explicit and keeps a manual-only cleanup policy.

Doctor reports Git availability, stale/drifted records, branch-prefix warnings and the execution gate.

### Registry safeguards

Git reads have per-probe time/output limits. Corrupt registries fail without being overwritten; registry updates are serialized and atomic.

Only `worktree.query` is allowed for read-only remote peers; `worktree.change` is not. The TUI blocks registry writes in read-only mode.

### Page implementation

Pages load lazily and render `Line[]` through the shared panel grid, with header hints and bordered single-column layouts below 70 columns. App-harness evidence: `bun scripts/render-frames.ts .agents-frames/B30 --b30 100x30 180x50`.

## The `worktree` tool (model-callable)

Enable `/experimental worktree_tool on` to give the main agent a `worktree` tool. The setting `experimental.worktree_tool` is off by default; it lets the agent isolate work the way `/warp` does for you.

| Action | Does |
|---|---|
| `enter [name]` | Create a daemon-owned Git worktree on a new `mend/<name>` branch under `<dir>/worktrees` and move the session into it. This uses the same `workspace-create` as `/warp`'s New workspace. |
| `exit [remove]` | Move back to the project checkout. With `remove`, delete the worktree only when clean and its branch merged; otherwise keep it and say why. |
| `status` | Show where the session works and how branches are named. |

`enter` and `exit` are write actions. You approve each one (smart mode always asks), and the approval shows the plan or the problem. Nothing is edited in your checkout.

### Handoff and housekeeping

These actions use the same approvals, except the read-only `list`:

| Action | Does |
|---|---|
| `list` | Show the project's worktrees with the session's own marked; read, no approval. |
| `handoff target` | Move into an **existing** worktree, including straight from another worktree. Target is a name, branch, id or directory from `list`; the same refusals as `enter` apply. |
| `close [target]` | Delete a clean, merged worktree with no session in it. Leave the session's own first, making this equal to `exit remove`. The approval shows what will be deleted. |
| `enter` with `base` | Start from a branch or ref, so a change can be stacked on another branch. An unresolved ref refuses before anything is created. |
| `enter` with `branch` | Supply the branch according to the naming mode below. |

The user-side counterparts are `/warp` (move this session and its children into a workspace and back) and `/worktrees` (preview-only manager).

### Branch naming

Set `worktreeBranch` in the settings file:

| Mode | Naming |
|---|---|
| `{ "mode": "static" }` (default) | `<prefix><name>`, with `prefix` `mend/` unless set (`"prefix": "team/"`). Ignores the model's `branch`. |
| `"semantic"` | The model passes a short type (`fix`, `feat`, `chore`: lowercase letters, digits, dashes); the branch is `<type>/<name>`. |
| `"custom"` | The model names the whole branch following your `"instruction"` text, shown to the model by `status`. |

A missing or invalid `branch` falls back to the static prefix, or is refused when unsafe. An existing branch is refused rather than reused. Names are checked with `git check-ref-format`.

### What changes during a turn

Unlike `/warp`, the move happens while the model's turn runs. The turn is not interrupted; following file and shell tool calls use the new directory. The session's approvals are dropped because they were given for the old directory.

The turn's system prompt and project instructions were built for the old directory. The next turn uses the worktree's.

The move is refused for:

- A sub-agent session or a session already in a worktree.
- A running child task, background command or interactive process.
- An unfinished goal or a pending request.
- An active loop or workflow of that directory.

The tool answers with the reason, and a half-created worktree is removed.

`/undo` still covers files changed with the edit tools. Changes a shell command makes in the worktree are not snapshotted. `/warp` and `/worktrees` see the same workspace.
