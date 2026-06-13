Last release: latest
Target ref: pending release

## TUI
### Features
- Show `Today` plus contextual day, month, and year information in welcome Agent View timestamps instead of only showing the time.

### Bugfixes
- Show the local package version in the welcome screen instead of `local` when running from source.
- Clarified that Tab cycles the active primary agent, such as Build or Plan, not the persistent prompt context.
- Renamed the persistent `minimal`/`focus`/`full` selector to "Prompt context" across the command palette and dialog.
- Hid the low-value "Cycle prompt mode" command from Ctrl+P so the palette no longer shows confusing "Next mode" entries.

## SDK/API
### Bugfixes
- Wrapped generated SDK `throwOnError` values in real `Error` objects while preserving the original structured body and status in `cause`.
- Aligned legacy and Effect HTTP API Basic Auth defaults on the MendCode username.

## Providers
### Bugfixes
- Isolated provider model plugin hooks from internal provider state so plugin-side mutations cannot rename providers or zero model pricing globally.

## Subagents
### Bugfixes
- Store the delegated subagent name on task child sessions so resumed/background-visible task sessions keep the correct agent identity.

## Sessions
### Bugfixes
- Avoid a shell-cancel race by cancelling an existing session runner even during short busy-state transitions instead of marking the session idle too early.

## MCP
### Bugfixes
- Added `cwd` support for local MCP servers, resolving relative paths from the active MendCode project directory.
- Applied configured MCP timeouts to prompt and resource discovery so hung servers do not stall those lists.
- Paginate MCP tool, prompt, and resource catalogs; skip prompt/resource listing when a server does not advertise those capabilities; tolerate broken tool `outputSchema` metadata during discovery; and forward tool-call abort signals to MCP servers.
- Added OAuth `callbackPort` shorthand and include configured OAuth `scope` in MCP client metadata.
- Preserve configured remote MCP headers during manual OAuth authentication flows.

## Release
### Bugfixes
- Passed the release workflow version into the build scripts through `MENDCODE_VERSION` and `OPENCODE_VERSION` so release binaries are stamped with the requested version.
- Updated changelog generation to include release workflow changes in release notes.
