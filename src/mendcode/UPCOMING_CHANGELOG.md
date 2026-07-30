Last release: v0.1.20
Target ref: v0.1.21

## Extensibility

- Added public documentation for project-local and package-shared custom tool calls, including typed arguments, execution context, metadata, permission checks, and package distribution.

## Interruption and recovery

- Fixed manual `Esc` cancellation restarting after late background-task notifications or stale prompt deliveries.
- Refresh session state and pending questions after terminal transport recovery from system sleep or reconnect.
- Mark shell commands interrupted by connection loss or timeout as unknown-result operations with safe retry guidance and bounded force-kill cleanup.
