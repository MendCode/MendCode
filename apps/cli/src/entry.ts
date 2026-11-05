#!/usr/bin/env bun
export {}

// Keep daemon validation and storage out of the terminal client's startup graph.
if (process.argv[2] === "__daemon") await import("../../../packages/daemon/src/main")
// The sandboxed process a workflow script runs in: it loads only the script runtime, never the CLI or the daemon.
// A first code graph build scans its files there, with every JIT tier on (packages/codegraph/src/scan-host.ts).
else if (process.argv[2] === "__codegraph-scan") await (await import("../../../packages/codegraph/src/scan-host")).runScanHost()
else if (process.argv[2] === "__script-host") await (await import("../../../packages/workflows/src/script-host")).runScriptHost()
else {
  // Before main reads the data directory: an earlier version's ~/.mendcode-v2 becomes ~/.mendcode once (data-dir-move.ts).
  await (await import("./data-dir-move")).moveDataDirAtStart()
  await import("./main")
}
