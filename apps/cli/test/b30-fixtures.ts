import type { WorktreePreview, WorktreeRecord, WorktreeReport } from "@mendcode/protocol"
import { appHarness, NOW, tempDir } from "./session-ui-harness"

export function b30Report(): WorktreeReport {
  const record = (id: string, branch: string, clean = true): WorktreeRecord => ({ id, path: `/work/${id === "base" ? "mendcode" : id}`, branch, head: "a".repeat(40), ownership: "external", dirty: { clean, summary: clean ? "Clean" : "Uncommitted changes", checkedAt: NOW }, drift: [], creator: "git", executor: "native", baseRef: null, cleanupPolicy: "manual-only", sessions: [], createdAt: 0 })
  return { operation: "status", ok: true, workspace: { currentPath: "/work/mendcode", currentBranch: "main", repoRoot: "/work/mendcode", isLinkedWorktree: false }, registryPath: "/tmp/b30-data/worktree-manager/repository.json", records: [record("base", "main"), record("client", "mend/client"), record("daemon", "mend/daemon", false)], plans: [], failures: [], warnings: ["Create, open, remove and reset are previews; no Git mutation or shell launch"], truncated: false, mode: "preview", executesGit: false, executesTsm: false }
}
export function b30Harness(width = 100, height = 30, readOnly = false) {
  let report = b30Report()
  let error = ""
  const harness = appHarness({ width, height, dataDir: tempDir(), directory: report.workspace.currentPath, ...(readOnly ? { remote: { host: "test.invalid", readOnly: true } } : {}), reply: (command) => {
    if (command.type !== "worktree.query" && command.type !== "worktree.change") return undefined
    if (error) return { ok: false, error: { code: "invalid_command", message: error } }
    const operation = command.type === "worktree.query" ? command.query : command.change
    const result = structuredClone(report)
    result.operation = operation.operation
    if ("target" in operation) {
      const target = result.records.find((record) => [record.id, record.branch, record.path].includes(operation.target))
      if (!target) return { ok: false, error: { code: "invalid_command", message: "Unknown worktree target" } }
      if (operation.operation === "adopt") { target.ownership = "adopted"; target.creator = "user-adopted"; report = result }
      else {
        const destructive = operation.operation !== "open"
        const blockReasons = destructive ? [...(target.ownership === "external" ? ["Target is external; adopt it first"] : []), ...(!target.dirty.clean ? ["Target is dirty: Uncommitted changes"] : []), ...(target.id === "base" ? ["Cannot remove or reset the base checkout"] : [])] : []
        const commands: WorktreePreview["commands"] = operation.operation === "remove" ? [{ tool: "git", argv: ["worktree", "remove", "--force", target.path], cwd: "/work/mendcode", destructive: true }, ...(target.branch ? [{ tool: "git" as const, argv: ["branch", "-D", target.branch], cwd: "/work/mendcode", destructive: true }] : [])] : operation.operation === "reset" ? [{ tool: "git", argv: ["reset", "--hard", target.baseRef ?? "default-branch"], cwd: target.path, destructive: true }, { tool: "git", argv: ["clean", "-ffdx"], cwd: target.path, destructive: true }] : []
        result.preview = { action: operation.operation, target, commands, stateWrites: destructive ? [result.registryPath] : [], blocked: blockReasons.length > 0, blockReasons, forceConfirmation: destructive ? target.path : null, executesGit: false, executesTsm: false }
        result.ok = !result.preview.blocked
      }
    } else if ("input" in operation) {
      const values = operation.input
      const target = { ...result.records[0]!, id: values.name, path: values.path ?? `/tmp/b30-data/worktrees/${values.name}`, branch: values.branch ?? `mend/${values.name}`, head: null, ownership: "owned" as const, creator: "mendcode" as const, dirty: { clean: true, summary: "Not created", checkedAt: NOW }, baseRef: values.base ?? null, cleanupPolicy: "remove-when-clean" as const, sessions: [], createdAt: NOW }
      const preview: WorktreePreview = { action: "create", target, commands: [{ tool: "git", argv: ["worktree", "add", "--no-checkout", "-b", target.branch!, target.path, ...(values.base ? [values.base] : [])], cwd: "/work/mendcode", destructive: false }], stateWrites: [result.registryPath], blocked: !result.ok, blockReasons: result.failures, forceConfirmation: null, executesGit: false, executesTsm: false }
      result.preview = preview
      if (command.type === "worktree.change" && result.ok) { result.plans.push({ id: values.name, focus: values.focus ?? "codex", createdAt: NOW, preview }); report = { ...result }; delete report.preview }
    }
    return { ok: true, result }
  } })
  const keys = async (...values: string[]) => { for (const key of values) await harness.app.onKey(key); await harness.type("") }
  return { ...harness, keys, report: () => report, setReport: (value: WorktreeReport) => { report = value }, error: (value: string) => { error = value } }
}

/** Fake project.rest backend for the /warp workspace picker. */
export function warpHarness(options: { width?: number; height?: number; readOnly?: boolean; failWarp?: string } = {}) {
  const wsId = (letter: string) => `ws_${letter.repeat(24)}`
  const workspaces: { id: string; type: string; name: string; branch: string | null; directory: string; extra: unknown; projectID: string }[] = [{ id: wsId("a"), type: "worktree", name: "review", branch: "mend/review", directory: "/work/project-review", extra: null, projectID: "p1" }]
  const statuses = new Map<string, string>([[wsId("a"), "connected"]])
  const calls: Record<string, any>[] = []
  const harness = appHarness({ width: options.width ?? 100, height: options.height ?? 30, dataDir: tempDir(), directory: "/work/project", ...(options.readOnly ? { remote: { host: "test.invalid", readOnly: true } } : {}), reply: (command) => {
    if (command.type !== "project.rest") return undefined
    const op = command.input as Record<string, any>
    calls.push(op)
    switch (op.operation) {
      case "workspace-list": return { ok: true, result: { workspaces } }
      case "workspace-status": return { ok: true, result: { statuses: workspaces.map((item) => ({ workspaceID: item.id, status: statuses.get(item.id) })) } }
      case "current": return { ok: true, result: { project: { id: "p1", worktree: "/work/project" } } }
      case "workspace-create": {
        const extra = op.input.extra ?? {}
        const created = { id: wsId("b"), type: op.input.type, name: extra.name ?? "local", branch: null, directory: extra.directory ?? `/work/${extra.name}`, extra, projectID: "p1" }
        workspaces.push(created)
        statuses.set(created.id, "connected")
        return { ok: true, result: { workspace: created } }
      }
      case "workspace-warp": return options.failWarp ? { ok: false, error: { code: "busy", message: options.failWarp } } : { ok: true, result: {} }
      case "workspace-remove": { const at = workspaces.findIndex((item) => item.id === op.id); if (at >= 0) workspaces.splice(at, 1); return { ok: true, result: {} } }
    }
    return { ok: true, result: {} }
  } })
  const keys = async (...values: string[]) => { for (const key of values) await harness.app.onKey(key); await harness.type("") }
  return { ...harness, keys, calls, warps: () => calls.filter((call) => call.operation === "workspace-warp") }
}
