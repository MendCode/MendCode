import type { ModelsReport, PermissionMode } from "@mendcode/protocol"
import { modelLabel } from "./model-label"

/** The model plan mode runs on: the `plan` role when one is set, else the session's own model (what the engine resolves for the plan role). */
export function planModelId(report: ModelsReport | undefined, sessionModel: string | undefined): string | undefined {
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
    return `Plan mode off: ${input.agent ?? "build"}${model ? ` runs on ${model}` : ""}`
  }
  return undefined
}
