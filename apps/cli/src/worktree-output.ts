import type { WorktreeReport, WorktreePreview } from "@mendcode/protocol"

export function worktreePreviewText(preview: WorktreePreview): string[] {
  return [
    `${preview.action} · ${preview.blocked ? "Blocked" : "Preview only"}`,
    preview.target.path,
    `Branch: ${preview.target.branch ?? "detached"}`,
    `Ownership: ${preview.target.ownership} · ${preview.target.dirty.summary}`,
    ...preview.commands.flatMap((command) => [`cwd: ${command.cwd}`, [command.tool, ...command.argv].map((arg) => /^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ")]),
    ...preview.stateWrites.map((file) => `Registry: ${file}`),
    ...preview.blockReasons,
    ...(preview.forceConfirmation ? [`Force confirmation: ${preview.forceConfirmation}`] : []),
    "Git execution: off · TSM: off",
  ]
}

export function worktreeText(report: WorktreeReport): string {
  return [
    `Worktrees · ${report.operation} · ${report.ok ? "ok" : "blocked"}`,
    `${report.workspace.isLinkedWorktree ? "Worktree" : "Base"}: ${report.workspace.currentPath}`,
    `Branch: ${report.workspace.currentBranch ?? "detached"}`,
    `Repository: ${report.workspace.repoRoot ?? "unavailable"}`,
    `Registry: ${report.registryPath}`,
    ...report.records.map((record) => `${record.id} · ${record.ownership} · ${record.branch ?? "detached"} · ${record.dirty.summary}\n  ${record.path}${record.drift.length ? `\n  ${record.drift.join("; ")}` : ""}`),
    ...report.plans.map((plan) => `Plan: ${plan.id} · ${plan.preview.target.branch} · focus ${plan.focus}`),
    ...(report.preview ? worktreePreviewText(report.preview) : []),
    ...report.failures, ...report.warnings,
    ...(report.truncated ? ["Results truncated"] : []),
  ].join("\n") + "\n"
}
