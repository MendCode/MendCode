import type { TsmReport } from "@mendcode/protocol"

export function tsmDetails(report: TsmReport): string[] {
  return [
    `TSM ${report.lifecycle} · ${report.enabled ? "enabled" : "disabled"}`,
    `Binary: ${report.binaryPath ?? "not installed"}`,
    `Version: ${report.detectedVersion ?? "unknown"}`,
    `Worktree support: ${report.worktreeCapable ? "available" : "unavailable"}`,
    `Mux: ${report.defaultMuxBackend}`,
    ...report.failures, ...report.warnings,
    `Project: ${report.workspace.currentPath}`,
    `Branch: ${report.workspace.currentBranch ?? "detached"}`,
    `Repository: ${report.workspace.repoRoot ?? "unavailable"}`,
    `Checkout: ${report.workspace.isLinkedWorktree ? "linked worktree" : "base"}`,
    `Git: ${report.rootGit ? report.gitHead ? "committed" : "no commits" : "unavailable"}`,
    `Policy: ${report.policy.mode} · liveSync ${report.policy.liveSync ? "on" : "off"}`,
    ...report.policy.neverSync.map((value) => `Never sync: ${value}`),
    `State: ${report.managedFiles.state}`, `Plan: ${report.managedFiles.plan}`, `Policy file: ${report.managedFiles.policy}`,
  ]
}
export function tsmPlanText(report: TsmReport): string[] {
  return report.plan ? ["Install/setup · dry-run", ...report.plan.install.commands, `Activate: ${report.plan.activation.command}`, `Remove scaffold: ${report.plan.removal.command}`, `Saved: ${report.plan.path}`] : ["No saved setup plan"]
}
export function tsmPreviewText(report: TsmReport): string[] {
  const preview = report.preview
  return preview ? [`${preview.action} · ${preview.blocked ? "blocked" : "preview"}`, preview.target, `Branch: ${preview.branch ?? "detached"}`, ...preview.commands.flatMap((command) => [`cwd: ${command.cwd}`, [command.tool, ...command.argv].map((arg) => /^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ")]), ...preview.blockReasons, "Session launch: off"] : []
}
export function tsmText(report: TsmReport): string {
  return [
    `TSM · ${report.operation} · ${report.ok ? "ok" : "blocked"}`,
    ...tsmDetails(report), ...(report.plan ? tsmPlanText(report) : []), ...tsmPreviewText(report),
    ...(report.archivedTo ? [`Scaffold recycled: ${report.archivedTo}`] : []),
    "Install: off · Session launch: off · Worktree removal: off",
  ].join("\n") + "\n"
}
