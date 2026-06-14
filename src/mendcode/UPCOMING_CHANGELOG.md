Last release: v0.1.8
Target ref: v0.1.9

## CLI Surface
### Changed
- Make `mendcode --help` workflow-first: open the terminal harness, run with an initial intent, use packages, mflow, worktrees, TSM, setup, and status.
- Move low-level/debug commands out of normal help, including TUI profile internals, runtime adapter/upstream/export/config plumbing, and prompt/runtime internals.
- Keep legacy aliases such as `init`, `sync`, `package`, and `prompts` callable with deprecation warnings instead of presenting them as product workflows.

### Bugfixes
- Suggest close matches for typo-prone commands, including `mendcode tui prewview` -> `mendcode tui preview`.

## Compaction
### Bugfixes
- Stop replaying the latest real user message as a new visible user turn after overflow compaction; resume from the summary and a synthetic internal continue prompt instead.
- Avoid the ugly double-compaction path where auto resume immediately re-adds the same user request before continuing.

## Terminal
### Bugfixes
- Release mouse tracking, bracketed paste, and raw input mode before suspending or exiting the TUI so the parent shell does not receive scroll/click escape sequences.
