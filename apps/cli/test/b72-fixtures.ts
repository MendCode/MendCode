import type { TsmReport } from "@mendcode/protocol"
import { appHarness, NOW, tempDir } from "./session-ui-harness"

export function b72Report(lifecycle: TsmReport["lifecycle"] = "installed-inactive"): TsmReport {
  const available = lifecycle !== "not-installed" && lifecycle !== "degraded"
  return { operation: "status", ok: lifecycle !== "degraded", lifecycle, enabled: lifecycle === "active" || lifecycle === "degraded", workspace: { currentPath: "/work/mendcode", currentBranch: "main", repoRoot: "/work/mendcode", isLinkedWorktree: false }, repository: "https://github.com/adibhanna/tsm", supportedRange: "worktree-capable build", recommendedVersion: "v0.6.7+ with `tsm wt`", binaryPath: available ? "/fixtures/bin/tsm" : null, detectedVersion: available ? "v0.7.0" : null, worktreeCapable: available, capabilities: ["tsm wt", "tsm wt open", "tsm wt add/rm", "tsm wt move", "tsm wt prune"], defaultMuxBackend: "auto", managedFiles: { state: "/tmp/b72-data/tsm/repository/state.json", plan: "/tmp/b72-data/tsm/repository/plan.json", policy: "/tmp/b72-data/tsm-policy/repository.json" }, policy: { mode: "off", liveSync: false, neverSync: [] }, rootGit: true, gitHead: true, safety: { installsTsm: false, startsSessions: false, killsSessions: false, removesWorktrees: false, explicitActivationRequired: true, statusExecutesVersionProbe: available }, warnings: available ? [] : ["TSM binary not found on PATH"], failures: [] }
}
export function b72Harness(width = 100, height = 30, readOnly = false) {
  let report = b72Report(), error = ""
  const harness = appHarness({ width, height, dataDir: tempDir("mendcode-b72-ui-"), directory: report.workspace.currentPath, ...(readOnly ? { remote: { host: "fixture.invalid", readOnly: true } } : {}), reply: (command) => {
    if (command.type !== "tsm.query" && command.type !== "tsm.change") return undefined
    if (error) return { ok: false, error: { code: "invalid_command", message: error } }
    const operation = command.type === "tsm.query" ? command.query : command.change
    const result = structuredClone(report)
    result.operation = operation.operation
    if (command.type === "tsm.change") {
      const change = command.change
      if (["plan", "install", "setup"].includes(change.operation)) result.plan = { version: 1, status: "dry-run", generatedAt: new Date(NOW).toISOString(), path: result.managedFiles.plan, repository: result.repository, supportedRange: result.supportedRange, recommendedVersion: result.recommendedVersion, install: { executesInstall: false, commands: ["brew tap adibhanna/tsm", "brew install adibhanna/tsm/tsm", "gh release download --repo adibhanna/tsm # choose the asset for this platform"] }, activation: { command: "mendcode tsm activate", requiresDetectedBinary: true, delegatesWorktreesImmediately: false }, removal: { command: "mendcode tsm remove", removesExternalTsm: false, killsSessions: false } }
      if (change.operation === "activate") {
        if (!result.worktreeCapable) return { ok: false, error: { code: "invalid_command", message: "Cannot activate TSM: binary not found" } }
        result.enabled = true
        result.lifecycle = "active"
        result.defaultMuxBackend = change.muxBackend ?? "auto"
      }
      if (change.operation === "deactivate" || change.operation === "remove") {
        result.enabled = false
        result.lifecycle = result.binaryPath ? "installed-inactive" : "not-installed"
        if (change.operation === "remove") { delete result.plan; result.defaultMuxBackend = "auto"; result.archivedTo = "/tmp/b72-data/trash/tsm/repository-fixture" }
      }
      report = structuredClone(result)
      delete report.archivedTo
    } else if (operation.operation === "doctor") {
      result.failures = [...(!result.rootGit ? ["Project must be a Git checkout before TSM worktree approval"] : []), ...(result.policy.liveSync ? ["TSM worktree execution must not start while liveSync=true"] : []), ...(result.lifecycle === "degraded" ? ["TSM integration is active but binary/capabilities are unavailable"] : [])]
      result.ok = result.failures.length === 0
    } else if (operation.operation === "open" || operation.operation === "create") {
      const reasons = result.enabled && result.worktreeCapable ? [] : ["TSM integration is not active"]
      const create = operation.operation === "create"
      const branch = create ? operation.input.branch ?? `mend/${operation.input.name}` : "main"
      result.preview = { action: operation.operation, target: create ? `/tmp/b72-data/worktrees/${operation.input.name}` : result.workspace.currentPath, branch, commands: [{ tool: "tsm", argv: ["wt", ...(create ? ["add"] : []), branch], cwd: result.workspace.repoRoot!, destructive: false }], blocked: reasons.length > 0, blockReasons: reasons, executesTsm: false }
      result.ok = !result.preview.blocked
    }
    return { ok: true, result }
  } })
  const keys = async (...values: string[]) => { for (const key of values) await harness.app.onKey(key); await harness.type("") }
  const reopen = async (command = "/tsm") => { await keys("q"); await harness.type(command + "\r") }
  return { ...harness, keys, reopen, report: () => report, setReport: (value: TsmReport) => { report = value }, error: (value: string) => { error = value } }
}
