Last release: v0.1.21
Target ref: v0.1.22

## Updates

- Show the startup update modal for patch releases by default instead of silently attempting an automatic update; explicit `autoupdate: true` keeps silent patch upgrades available.
- Add regression coverage for the `0.1.20` to `0.1.21` update path.

## Extensibility

- Added public documentation for project-local and package-shared custom tool calls, including typed arguments, execution context, metadata, permission checks, and package distribution.

## Interruption and recovery

- Fixed manual `Esc` cancellation restarting after late background-task notifications or stale prompt deliveries.
- Refresh session state and pending questions after terminal transport recovery from system sleep or reconnect.
- Mark shell commands interrupted by connection loss or timeout as unknown-result operations with safe retry guidance and bounded force-kill cleanup.
