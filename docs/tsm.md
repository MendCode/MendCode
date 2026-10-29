# Terminal-session adapter (B72)

`/tsm` opens the v1 manager actions in v2's panel grid. Arrows select, Enter
opens details or performs the action, Tab switches between actions and scrollable
details, `m` chooses the mux for activation, `r` refreshes and `d` runs doctor.
Escape returns to actions, then chat. Under 70 columns only the focused panel
is shown. Removal requires `y`; `n`/Escape keeps the scaffold.

```text
mendcode --dir DATA [control-plane] tsm status|plan|install|setup|doctor --project PROJECT
mendcode --dir DATA [control-plane] tsm activate --project PROJECT [--mux auto|cmux|kitty|ghostty|wezterm]
mendcode --dir DATA [control-plane] tsm deactivate|remove --project PROJECT
mendcode --dir DATA [control-plane] tsm open TARGET --project PROJECT
mendcode --dir DATA [control-plane] tsm create NAME --project PROJECT [--branch B] [--base REF] [--path PATH] [--focus F]
```

Every operation supports `--json` and the existing CLI envelope. Failed reports
exit 1; invalid arguments exit 64. Slash arguments use the same parser:
`/tsm setup`, `/tsm activate --mux kitty`, `/tsm doctor`, `/tsm open TARGET`.

As in v1 stable, **plan, install and setup only save a dry-run plan**. The plan
contains v1's manual install suggestions; they are not executed or verified
against a current release. Native worktrees/loops remain the default. Activation
is opt-in, initially off, and requires a worktree-capable TSM binary on PATH or
an absolute `MENDCODE_TSM_BINARY`. Only `--version` and `wt --help` are probed
(one-second deadlines, 16 KiB output limit); raw executable output is not returned.
Version ≥0.7 or successful worktree help supplies the v1 capability gate.
The selected mux is saved as adapter state; it is not guessed as a CLI flag to
TSM. Open/create return the v1 `tsm wt BRANCH` / `tsm wt add BRANCH` previews,
with native worktree validation and a liveSync gate. No session is started or
switched and no Git operation is executed.

State and plan live at `<dir>/tsm/<repository-id>/{state,plan}.json`; linked
worktrees share the canonical Git registry identity. Optional policy lives at
`<dir>/tsm-policy/<repository-id>.json` with
`{"mode":"off","liveSync":false,"neverSync":[]}` defaults. Doctor checks
the checkout, degraded activation and unsafe liveSync; missing Git commits are
reported as a warning, matching v1. Corrupt/redirected managed files fail without
being overwritten. Writes are serialized and atomic. Remove moves only the
MendCode scaffold into `<dir>/trash/tsm/`; it preserves policy, external TSM,
sessions and worktrees. No network listener/service or dependency is added.
TSM queries and changes are denied to read-only peers because queries probe an
external executable. Existing daemon authentication and transport remain in use.

Evidence uses local fakes only. Frames: `bun scripts/render-frames.ts
.agents-frames/B72 --b72 100x30 180x50`.
