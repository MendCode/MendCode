import { realpath } from "node:fs/promises"
import path from "node:path"
import type { ChangesReport, SessionSummary } from "@mendcode/protocol"
import type { ApplyAutomation } from "./apply-args"
import type { AutomationDeps } from "./automation"
import { planApply, writePlan } from "./apply-patch"

const MARK = { create: "A", modify: "M", delete: "D", rename: "R" } as const

/** `apply`: the files a session changed, written onto another checkout (the session's own project is refused). */
export function createApplyAutomation(ctx: Pick<AutomationDeps, "client"> & { directory: string; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }) {
  return async (command: ApplyAutomation) => {
    let session = command.session
    if (!session) {
      const listed = await ctx.client.send({ type: "session.list", directory: ctx.directory, roots: true, limit: 1 })
      if (!listed.ok) return ctx.fail(listed.error.message, 1, listed.error.code)
      session = (listed.result?.sessions as SessionSummary[] | undefined)?.[0]?.sessionId
      if (!session) return ctx.fail("this project has no session to apply", 1, "no_session")
    }
    const reply = await ctx.client.send({ type: "session.changes", sessionId: session as never })
    if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
    const report = reply.result as unknown as ChangesReport
    if (report.complete === false) return ctx.fail("the session's changes were not fully recorded (snapshot disabled, pruned or incomplete); nothing was applied", 1, "incomplete")
    if (report.omittedFiles > 0) return ctx.fail(`${report.omittedFiles} more files changed than the report holds; nothing was applied`, 1, "incomplete")
    const target = await realpath(path.resolve(ctx.directory, command.to ?? ".")).catch(() => undefined)
    if (!target) return ctx.fail(`target ${command.to} is not a directory`, 1, "bad_target")
    if (target === await realpath(report.root).catch(() => report.root)) return ctx.fail("the target is the session's own project; pass --to another checkout", 1, "bad_target")
    if (!report.files.length) return ctx.result({ session, target, changes: [], applied: false }, "the session changed no files\n")
    const plan = await planApply({ files: report.files, target })
    if (!plan.ok) return ctx.fail(`cannot apply to ${target}; nothing was written:\n  ${plan.problems.join("\n  ")}`, 1, "conflict")
    if (!command.check) await writePlan({ changes: plan.changes, target })
    const lines = plan.changes.map((change) => `  ${MARK[change.action]} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}${change.note ? ` (${change.note})` : ""}`)
    return ctx.result(
      { session, target, applied: !command.check, changes: plan.changes.map(({ content: _content, ...change }) => change) },
      `${command.check ? "would apply" : "applied"} ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"} from session ${session} to ${target}\n${lines.join("\n")}\n`,
    )
  }
}
