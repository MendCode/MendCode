Last release: latest
Target ref: pending release

## TUI
### Features
- Show contextual day, month, and year information in the welcome Agent View timestamps instead of only showing the time for older sessions.

### Bugfixes
- Clarified that Tab cycles the active primary agent, such as Build or Plan, not the persistent prompt context.
- Renamed the persistent `minimal`/`focus`/`full` selector to "Prompt context" across the command palette and dialog.
- Hid the low-value "Cycle prompt mode" command from Ctrl+P so the palette no longer shows confusing "Next mode" entries.

## Release
### Bugfixes
- Passed the release workflow version into the build scripts through `MENDCODE_VERSION` and `OPENCODE_VERSION` so release binaries are stamped with the requested version.
- Updated changelog generation to include release workflow changes in release notes.
