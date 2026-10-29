# Worktree manager (B30)

`/worktrees` reads the current Git checkout, linked worktrees, registry ownership,
dirty state, session counts and saved plans. Select with arrows; `c` opens the
name/branch/base/path/focus form, Tab changes fields, and Enter saves a preview.
`o` or Enter resolves the selected target; `a` adopts it; `x` and `z` preview
remove and reset. `d` runs doctor, `r` refreshes, and Escape closes the detail
before leaving the page. Tab switches list/detail focus; details and previews
scroll with arrows or Page Up/Down. Saved plans stay visible in the detail panel.

From the balanced tier `/worktrees` and `/warp` open under the tabs of the [Git page](git.md); the workspace picker marks the rows with uncommitted changes (`dirty`, from `worktree.query`). Nothing else changes.

What worktrees cost on disk, and the merged/clean/idle cleanup (`storage --worktrees`, `worktreeGcDays`), is in
[storage.md](storage.md).

## A new session in its own worktree

`git.newSessionWorktree: true` (a setting, off by default; it needs the Git page, so balanced and full) makes `/new` and `/bg` create the session in a fresh workspace. The terminal asks for a worktree workspace (`workspace-create`, `type: "worktree"`, `branch: null`, no name) and warps the new session into it (`workspace-warp`) before it enters the session: the same two requests `/warp` → New workspace sends, so the daemon gives the folder and the `mend/` branch the names it gives there (no second worktree creator). With the setting off nothing changes.

The new workspace starts from the project's current commit: uncommitted changes stay where they are, they are not copied. If the project is not a Git repository, or the workspace cannot be made (the limit, git failing, a full disk), the session is created in the project folder as usual and one line says why. Remote clients do not use it.

These worktrees are ordinary daemon-created worktrees: the Worktrees tab lists them, and the age-based cleanup (`worktreeGcDays`, `storage --worktrees`) covers them with the same rules (removed only when merged, clean, unused by any session and idle long enough). No separate cleanup exists. A workspace holding a session is kept ("a session, loop or workflow works in it"); an unused one is removed after the idle days only when its branch has nothing unmerged.

`/warp` opens the workspace picker, backed by `project.rest` ([project-rest.md](project-rest.md)):
`New workspace`, the local project and the project's workspaces (with branch, current
marker and missing-directory state). Enter moves the current session and its children
to the selected workspace (`workspace-warp`) and returns to the chat, which follows the
`session.workspace.changed` event. `c` (or Enter on `New workspace`) takes a Name and an
optional Directory: Name alone creates a Git worktree workspace on a daemon-assigned
branch; a Directory registers that existing folder as a local workspace. The new
workspace is warped into at once. `x` twice removes the selected workspace (the daemon
refuses while sessions still live there). `/warp NAME` (name, branch, id or path) or
`/warp local` moves directly. Busy sessions, active turns and other daemon refusals show
inside the page. Read-only remote peers get no workspace access: nothing is sent.
`/worktrees` is unchanged and stays preview-only; its open does not switch the session.
The opt-in [TSM adapter](tsm.md) provides separate gated open/create previews.

```text
mendcode --dir DATA [control-plane] worktree status|doctor --project PROJECT
mendcode --dir DATA [control-plane] worktree plan|create NAME --project PROJECT
  [--branch BRANCH] [--base REF] [--path PATH] [--focus auto|codex|claude|gemini|kimi|deepseek|mistral]
mendcode --dir DATA [control-plane] worktree open|adopt|remove|reset TARGET --project PROJECT
```

All support `--json` and the existing CLI envelope. Targets are ids, branches or
paths. An unsuccessful preview exits 1; invalid arguments exit 64. `--execute`
and `--force` are intentionally unavailable. Like v1 stable, create/open/remove/
reset are **preview-only**. No branch, checkout, shell or session is changed.
`plan`/`create` save a bounded plan; `adopt` saves ownership in the daemon's
`<dir>/worktree-manager/<repository-id>.json`. The id uses the canonical common
Git directory, so linked checkouts share one registry. Defaults follow the v2
project focus; the default target lives under `<dir>/worktrees`, not a donor tree.

Removal/reset previews require owned/adopted, clean, non-base, non-stale targets.
Changed branches are reported as drifted. Adoption is explicit and keeps a
manual-only cleanup policy. Doctor reports Git availability, stale/drifted
records, branch-prefix warnings and the execution gate. Nothing claims real
execution approval. Git reads have per-probe time/output limits; corrupt
registries fail without being overwritten. Registry updates are serialized and
atomic. Only `worktree.query` is allowed for read-only remote peers;
`worktree.change` is not. The TUI blocks registry writes in read-only mode.

Pages load lazily and render `Line[]` through the shared panel grid, with header
hints and bordered single-column layouts below 70 columns. App-harness evidence:
`bun scripts/render-frames.ts .agents-frames/B30 --b30 100x30 180x50`.

## The `worktree` tool (model-callable)

`/experimental worktree_tool on` (setting `experimental.worktree_tool`, off by default) gives the main agent a `worktree` tool, so it can isolate work the way `/warp` does for the user. `enter [name]` creates a daemon-owned Git worktree on a new `mend/<name>` branch under `<dir>/worktrees` (the same `workspace-create` as `/warp`'s New workspace) and moves the session into it; `exit [remove]` moves back to the project checkout and, with `remove`, deletes the worktree only when it is clean and its branch is merged (otherwise it is kept and the answer says why); `status` says where the session works and how branches are named. `enter` and `exit` are write actions: the user approves each one (smart mode always asks), and the approval shows the plan or the problem. Nothing is edited in the user's checkout.

Handoff and housekeeping, all through the same approvals: `list` (read, no approval) shows the project's worktrees with the session's own marked; `handoff target` moves the session into an **existing** worktree (target: name, branch, id or directory from `list`; also from one worktree straight to another) under the same refusals as `enter`; `close [target]` deletes a worktree that is clean, merged and has no session in it (the session's own is left first, so it equals `exit remove`; the approval shows what will be deleted); `enter` takes `base` (a branch or ref to start from, so a change can be stacked on another branch; a ref that does not resolve refuses before anything is created) and `branch`. The user-side counterpart is `/warp` (move this session and its children into a workspace and back) and `/worktrees` (preview-only manager).

Branch naming (`worktreeBranch` setting, in the settings file): `{ "mode": "static" }` (default) names the branch `<prefix><name>` with `prefix` `mend/` unless set (`"prefix": "team/"`) and ignores the model's `branch`; `"semantic"` makes the model pass a short type (`fix`, `feat`, `chore`: lowercase letters, digits, dashes) and the branch is `<type>/<name>`; `"custom"` makes the model name the whole branch, following the user's `"instruction"` text (shown to the model by `status`). A missing or invalid `branch` falls back to the static prefix (or is refused when it is unsafe); a branch that already exists is refused rather than reused. Names are checked with `git check-ref-format`.

Unlike `/warp`, the move happens while the model's turn runs: the turn is not interrupted, file and shell tools of the following calls use the new directory, and the session's approvals are dropped (they were given for the old directory). The system prompt and project instructions of the turn were built for the old directory; the next turn uses the worktree's. The move is refused (the tool answers with the reason, and a half-created worktree is removed) for a sub-agent session, a session already in a worktree, a running child task, background command or interactive process, an unfinished goal, a pending request or an active loop or workflow of that directory. `/undo` still covers files changed with the edit tools; changes a shell command makes in the worktree are not snapshotted. `/warp` and `/worktrees` see the same workspace.
