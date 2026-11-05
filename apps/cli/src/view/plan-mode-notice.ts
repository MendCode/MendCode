import type { ModelsReport, PermissionMode } from "@mendcode/protocol"
import { externalEngine } from "./fast-mode"
import { modelLabel } from "./model-label"

/** What the footer calls each permission mode; leaving plan mode names the one the session landed in. */
const MODE_NAME: Readonly<Record<PermissionMode, string>> = { ask: "ask before edits", smart: "smart approval", edits: "auto edits", full: "full access", plan: "plan mode" }

/**
 * The model plan mode runs on. Only the daemon's own engine switches to the `plan` role; Claude Code, Codex, pi and ACP agents run the
 * whole session on its model, so for those it is the session's own, whatever the role says.
 */
export function planModelId(report: ModelsReport | undefined, sessionModel: string | undefined): string | undefined {
  if (sessionModel?.startsWith("acp:") || externalEngine(sessionModel, report)) return sessionModel
  return report?.roles.plan?.model ?? sessionModel
}

/** The one-line notice for a permission change that enters or leaves plan mode; undefined for every other change. */
export function planModeNotice(input: { from: PermissionMode; to: PermissionMode; report: ModelsReport | undefined; planModel: string | undefined; buildModel: string | undefined; agent: string | undefined }): string | undefined {
  const label = (id: string | undefined) => id ? modelLabel(id, input.report) : undefined
  if (input.to === "plan" && input.from !== "plan") {
    const model = label(input.planModel)
    return `Plan mode: read-only · ${model ?? "the model"} plans · you review first`
  }
  if (input.from === "plan" && input.to !== "plan") {
    const model = label(input.buildModel)
    return `Plan mode off: ${input.agent ?? "build"}${model ? ` runs on ${model}` : ""} · ${MODE_NAME[input.to]}`
  }
  return undefined
}
