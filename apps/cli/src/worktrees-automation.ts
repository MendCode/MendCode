import type { StorageCleanResult, StorageWorktreesReport } from "@mendcode/protocol"
import type { WorktreesAutomation } from "./worktrees-args"
import type { AutomationDeps } from "./automation"
import { formatBytes } from "./view/storage-page"

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
const KINDS = ["sandbox", "loop", "fanout", "workflow", "merge", "compound", "external"] as const

/** One line per worktree: size, what it is, and why it is kept (or that cleaning would remove it). */
export function worktreesListText(report: StorageWorktreesReport) {
  if (report.worktrees.length === 0) return "no worktrees\n"
  const lines = report.worktrees.map((tree) => {
    const status = tree.occupied ? "in use" : tree.removable ? "removable" : "kept"
    const facts = [tree.state, tree.clean ? "clean" : "changes", `idle ${tree.idleDays}d`].join(" · ")
    return `${(tree.bytesKnown === false ? "?" : formatBytes(tree.bytes)).padStart(9)}  ${(tree.kind ?? "sandbox").padEnd(8)} ${status.padEnd(9)} ${facts}  ${clean(tree.branch ?? "(detached)")}  ${clean(tree.directory)}${tree.keep ? `\n${" ".repeat(11)}kept: ${tree.keep}` : ""}`
  })
  const unmeasured = report.unmeasured ? `\n${report.unmeasured} not measured yet (shown as ?): \`worktrees size\` measures them\n` : "\n"
  return `${lines.join("\n")}${unmeasured}`
}

export function worktreesSizeText(report: StorageWorktreesReport) {
  const lines = [`worktrees: ${formatBytes(report.totalBytes)} in ${report.worktrees.length} · removable ${formatBytes(report.removableBytes)} · trash ${formatBytes(report.trashBytes)}`]
  for (const kind of KINDS) {
    const trees = report.worktrees.filter((tree) => (tree.kind ?? "sandbox") === kind)
    if (trees.length) lines.push(`  ${kind.padEnd(9)} ${String(trees.length).padStart(3)}  ${formatBytes(trees.reduce((sum, tree) => sum + tree.bytes, 0)).padStart(9)}  removable ${formatBytes(trees.filter((tree) => tree.removable).reduce((sum, tree) => sum + tree.bytes, 0))}`)
  }
  if (report.capBytes) lines.push(`cap: ${formatBytes(report.managedBytes ?? 0)} of ${formatBytes(report.capBytes)}${(report.managedBytes ?? 0) > report.capBytes ? " (over the cap: mendcode worktrees gc --yes frees what is safe)" : ""}`)
  if (report.artifacts) lines.push(`heavy ignored output in idle worktrees: ${formatBytes(report.artifactBytes ?? 0)} in ${report.artifacts.length} (worktrees gc --artifacts --yes removes it)`)
  return `${lines.join("\n")}\n`
}

export function worktreesArtifactsText(report: StorageWorktreesReport) {
  return (report.artifacts ?? []).map((item) => `${formatBytes(item.bytes).padStart(9)}  ${item.kind === "bun-build" ? "bun-build" : "ignored  "}  ${clean(item.directory)}/${clean(item.path)}`).join("\n") + (report.artifacts?.length ? "\n" : "")
}

export function worktreesGcText(result: StorageCleanResult, command: WorktreesAutomation) {
  const what = command.artifacts ? "ignored output entries" : "worktrees/trash entries"
  return `${result.dryRun ? "would remove" : "removed"} ${result.worktreesRemoved ?? 0} ${what} · ${formatBytes(result.worktreeBytes ?? 0)}${result.dryRun ? "\nrun again with --yes to remove them\n" : "\n"}`
}

const PROGRESS_EVERY_MS = 1500

/** The full measuring runs as one long request; meanwhile quick listings (which read what it has measured so far) tell how many are left. */
async function withProgress(ctx: Pick<AutomationDeps, "client"> & { err?: { write(text: string): unknown } }, command: WorktreesAutomation & { json?: boolean }, idle: { idleDays?: number }) {
  let total: number | undefined
  let polling = false
  const timer = setInterval(async () => {
    if (polling || command.json) return
    polling = true
    try {
      const peek = await ctx.client.send({ type: "storage.worktrees", external: true, measure: "cached", ...idle })
      if (!peek.ok) return
      const report = peek.result as unknown as StorageWorktreesReport
      total ??= report.worktrees.length
      ctx.err?.write(`measuring worktrees: ${total - (report.unmeasured ?? 0)}/${total}\n`)
    } finally { polling = false }
  }, PROGRESS_EVERY_MS)
  try { return await ctx.client.send({ type: "storage.worktrees", external: true, artifacts: true, measure: "full", ...idle }) }
  finally { clearInterval(timer) }
}

export function createWorktreesAutomation(ctx: Pick<AutomationDeps, "client"> & { err?: { write(text: string): unknown }; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }) {
  return async (command: WorktreesAutomation & { json?: boolean }) => {
    const idle = command.idleDays === undefined ? {} : { idleDays: command.idleDays }
    if (command.action !== "gc") {
      // `list` answers at once with the sizes the daemon knows; `size` waits for the measuring and says how far it is.
      const reply = command.action === "list"
        ? await ctx.client.send({ type: "storage.worktrees", external: true, measure: "cached", ...idle })
        : await withProgress(ctx, command, idle)
      if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
      const report = reply.result as unknown as StorageWorktreesReport
      return ctx.result(reply.result ?? {}, command.action === "list" ? worktreesListText(report) : worktreesSizeText(report) + worktreesArtifactsText(report))
    }
    // Show what would go first (also with --yes the listing is what the user approved by passing the flag), then act.
    const preview = await ctx.client.send({ type: "storage.worktrees", external: !command.artifacts, measure: "cached", ...(command.artifacts ? { artifacts: true } : {}), ...idle })
    if (!preview.ok) return ctx.fail(preview.error.message, 1, preview.error.code)
    const report = preview.result as unknown as StorageWorktreesReport
    const reply = await ctx.client.send({ type: "storage.clean", olderThanDays: 0, worktreesOnly: true, ...(command.artifacts ? { artifacts: true } : { worktrees: true, external: true }), ...(command.yes ? {} : { dryRun: true }), ...(command.idleDays === undefined ? {} : { worktreeIdleDays: command.idleDays }) })
    if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
    const listing = command.artifacts ? worktreesArtifactsText(report) : worktreesListText({ ...report, worktrees: report.worktrees.filter((tree) => tree.removable) })
    return ctx.result({ ...reply.result, ...(command.artifacts ? { artifacts: report.artifacts ?? [] } : { worktrees: report.worktrees.filter((tree) => tree.removable) }) }, `${listing}${worktreesGcText(reply.result as unknown as StorageCleanResult, command)}`)
  }
}
