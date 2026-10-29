import type { MflowReport } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { appHarness, NOW, tempDir, type HarnessOptions } from "./session-ui-harness"

export function b73Report(): MflowReport {
  return { operation: "status", ok: true, mode: "disabled", config: { enabled: false, room: "source/mflow", relayMode: "local", signaling: "embedded", hookPriority: 0, tokenConfigured: false }, daemon: { running: false, checked: false, output: "Mflow disabled" }, peers: [], locks: [], failures: [], warnings: [], statePath: "/tmp/b73-data/mflow/state.json" }
}
export function b73Harness(options: Pick<HarnessOptions, "width" | "height" | "remote"> = {}) {
  let report = b73Report(), fail = false
  const harness = appHarness({ ...options, dataDir: tempDir(), directory: "/work/source", reply: (command) => {
    if (command.type !== "mflow.query" && command.type !== "mflow.change") return
    if (fail) { fail = false; return { ok: false, error: { code: "invalid_command", message: "Relay unavailable; check token file" } } as CommandReply }
    if (command.type === "mflow.change") {
      const change = command.change
      if (change.operation === "activate" || change.operation === "setup") report = { ...report, mode: "enabled-stopped", config: { ...report.config, enabled: true, room: change.input.room ?? report.config.room, signaling: change.input.signaling ?? report.config.signaling, hookPriority: change.input.hookPriority ?? report.config.hookPriority, tokenConfigured: Boolean(change.input.tokenFile) }, daemon: { running: false, checked: true, output: "Configured; start required" } }
      if (change.operation === "start") {
        if (!report.config.enabled) return { ok: false, error: { code: "invalid_command", message: "Configure and activate Mflow before starting" } }
        report = { ...report, mode: "running", daemon: { running: true, checked: true, output: "Coordination running" }, peers: [{ owner: "daemon-7cf8", expiresAt: NOW + 120_000 }, { owner: "peer-8162", expiresAt: NOW + 35_000 }], locks: [{ leaseId: "lease-one", owner: "peer-8162", files: ["src/client/connection.ts", "src/client/reconnect.ts"], mode: "write", expiresAt: NOW + 35_000 }] }
      }
      if (change.operation === "stop") report = { ...report, mode: "enabled-stopped", daemon: { running: false, checked: true, output: "Configured; start required" }, peers: [], locks: [] }
      if (change.operation === "deactivate") report = { ...report, mode: "disabled", config: { ...report.config, enabled: false }, daemon: { running: false, checked: false, output: "Mflow disabled" }, peers: [], locks: [] }
      if (change.operation === "remove") report = b73Report()
      if (change.operation === "plan") report = { ...report, planPath: "/tmp/b73-data/mflow/plan.json", plan: { dryRun: true, startsDaemon: false, syncsFiles: false, neverSync: [".git", ".env*", "node_modules"], commands: ["mendcode control-plane mflow activate", "mendcode control-plane mflow start"] } }
      report.operation = change.operation
    } else {
      const operation = command.query.operation
      report = { ...report, operation, warnings: [] }
      delete report.relays
      delete report.guide
      delete report.legacy
      if (operation === "scan") report.relays = [{ url: "http://127.0.0.1:8787", health: "healthy", roomCount: 1, peerCount: report.peers.length }]
      if (operation === "relay-guide") report.guide = { recommendedUrl: "http://127.0.0.1:8787", commands: ["mendcode remote token create --dir RELAY_DATA --name mflow", "bun packages/daemon/src/main.ts --dir RELAY_DATA --cwd PROJECT --engine faux --mflow-listen 127.0.0.1:8787", "mendcode control-plane mflow activate --url http://127.0.0.1:8787 --token-file PRIVATE_FILE", "mendcode control-plane mflow start"], note: "v2 coordination protocol; external mflow-cli relays require an adapter. File sync is off." }
      if (operation === "doctor") report.warnings = ["File sync and external mflow-cli compatibility are unavailable"]
      if (operation === "legacy-status") report.legacy = { enabled: false, liveSync: false, integration: "v2-coordination; legacy file sync unavailable" }
    }
    return { ok: true, result: structuredClone(report) as unknown as Record<string, never> }
  } })
  harness.app.applySettings({ onboarded: true })
  const keys = async (...keys: string[]) => { for (const key of keys) await harness.app.onKey(key); harness.app.render() }
  return { ...harness, keys, report: () => report, failNext: () => { fail = true } }
}
