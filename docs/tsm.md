`/tsm` opens the v1 manager actions in v2's panel grid. Use it to inspect the adapter, save a dry-run plan or opt into activation.

## Terminal-session adapter (B72)

1. Run `/tsm` to open the panel grid.
2. Select an action with the arrows, then press Enter to open details or perform the action.
3. Press Tab to switch between actions and scrollable details.

| Key | Does |
|---|---|
| `m` | Choose the mux for activation |
| `r` | Refresh |
| `d` | Run doctor |
| Escape | Return to actions, then chat |
| `y` | Confirm removal |
| `n`/Escape | Keep the scaffold instead of removing it |

Under 70 columns only the focused panel is shown.

## Run commands from the CLI

```text
mendcode --dir DATA [control-plane] tsm status|plan|install|setup|doctor --project PROJECT
mendcode --dir DATA [control-plane] tsm activate --project PROJECT [--mux auto|cmux|kitty|ghostty|wezterm]
mendcode --dir DATA [control-plane] tsm deactivate|remove --project PROJECT
mendcode --dir DATA [control-plane] tsm open TARGET --project PROJECT
mendcode --dir DATA [control-plane] tsm create NAME --project PROJECT [--branch B] [--base REF] [--path PATH] [--focus F]
```

Every operation supports `--json` and the existing CLI envelope. Failed reports
exit 1; invalid arguments exit 64.

| Result | Exit code |
|---|---|
| Failed report | 1 |
| Invalid arguments | 64 |

Slash arguments use the same parser:

| Slash command | Action |
|---|---|
| `/tsm setup` | Save a dry-run setup plan |
| `/tsm activate --mux kitty` | Activate with the kitty mux selected |
| `/tsm doctor` | Check the adapter |
| `/tsm open TARGET` | Preview opening the target |

## Plan and activate

**Note:** As in v1 stable, **plan, install and setup only save a dry-run plan**. The plan contains v1's manual install suggestions; they are not executed or verified against a current release.

Native worktrees/loops remain the default. Activation is opt-in and initially off.

### Activation requirements

Activation requires a worktree-capable TSM binary on PATH or an absolute `MENDCODE_TSM_BINARY`.

- Only `--version` and `wt --help` are probed, with one-second deadlines and a 16 KiB output limit.
- Raw executable output is not returned.
- Version ≥0.7 or successful worktree help supplies the v1 capability gate.

The selected mux is saved as adapter state; it is not guessed as a CLI flag to TSM.

### Open and create previews

Open/create return the v1 `tsm wt BRANCH` / `tsm wt add BRANCH` previews, with native worktree validation and a liveSync gate.

No session is started or switched and no Git operation is executed.

## Check and remove the adapter

Doctor checks the checkout, degraded activation and unsafe liveSync. Missing Git commits are reported as a warning, matching v1.

Remove moves only the MendCode scaffold into `<dir>/trash/tsm/`. It preserves:

- Policy.
- External TSM.
- Sessions and worktrees.

## How it works

### Storage and writes

| File | Holds |
|---|---|
| `<dir>/tsm/<repository-id>/{state,plan}.json` | State and plan |
| `<dir>/tsm-policy/<repository-id>.json` | Optional policy, with `{"mode":"off","liveSync":false,"neverSync":[]}` defaults |

Linked worktrees share the canonical Git registry identity. Corrupt/redirected managed files fail without being overwritten. Writes are serialized and atomic.

### Access and dependencies

TSM queries and changes are denied to read-only peers because queries probe an external executable. Existing daemon authentication and transport remain in use.

No network listener/service or dependency is added.

### Evidence and frames

Evidence uses local fakes only. Render frames with:

```sh
bun scripts/render-frames.ts .agents-frames/B72 --b72 100x30 180x50
```
