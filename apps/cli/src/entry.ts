#!/usr/bin/env bun
export {}

// Keep daemon validation and storage out of the terminal client's startup graph.
if (process.argv[2] === "__daemon") await import("../../../packages/daemon/src/main")
// The sandboxed process a workflow script runs in: it loads only the script runtime, never the CLI or the daemon.
else if (process.argv[2] === "__script-host") await (await import("../../../packages/workflows/src/script-host")).runScriptHost()
else await import("./main")
