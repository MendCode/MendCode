import type { Client } from "@mendcode/client"
import type { ModelChoice, ModelInfo, ModelsReport, ReasoningEffort, SessionDetail } from "@mendcode/protocol"
import { findModel } from "@mendcode/protocol/wire"
import type { SessionSelection } from "./session-args"

export function sessionHuman(session: SessionDetail) {
  return [
    `${session.sessionId}  ${session.title}`,
    `State: ${session.status}`,
    `Agent: ${session.agent ?? (session.permission === "plan" ? "plan" : "build")}`,
    `Model: ${session.model ? `${session.model.model}${session.model.variant ? ` (${session.model.variant})` : ""}` : "runtime default"}`,
    `Directory: ${session.directory}`,
    `Updated: ${new Date(session.updatedAt).toISOString()}`,
    ...(session.archivedAt !== undefined ? [`Archived: ${new Date(session.archivedAt).toISOString()}`] : []),
  ].join("\n") + "\n"
}

/** List matching is by prefix and does not require the model to remain in today's catalog. */
export function sessionModelPrefix(model: string) {
  const [provider, ...rest] = model.split("/")
  if (!rest.length) return model
  const prefix = rest.join("/")
  return ["openai", "codex", "chatgpt"].includes(provider!) ? prefix : `${provider}:${prefix}`
}

export async function sessionSelection(client: Pick<Client, "send">, selection: SessionSelection, target: { directory?: string; sessionId?: import("@mendcode/protocol").SessionId }): Promise<{ ok: true; model?: ModelChoice; agent?: string } | { ok: false; message: string }> {
  if (!selection.model && !selection.variant && !selection.effort) return { ok: true as const, ...(selection.agent ? { agent: selection.agent } : {}) }
  // `models.list` is scoped by session only: a session that does not exist yet (create) reads the daemon's catalog.
  const reply = await client.send({ type: "models.list", ...(target.sessionId ? { sessionId: target.sessionId } : {}) })
  if (!reply.ok) return { ok: false as const, message: reply.error.message }
  const report = reply.result as unknown as ModelsReport
  let choice: ModelChoice | undefined = report.effective ?? report.session ?? report.roles.main ?? report.defaults
  if (selection.model) {
    const asked = selection.model
    const [provider, ...rest] = asked.split("/")
    const model = rest.join("/")
    // `reference` is the name `mendcode models` prints (`claude/claude-sonnet`): what is listed can be asked for.
    const found = report.models.find((entry) => entry.id === asked || (entry as { reference?: string }).reference === asked || model && (entry.id === `${provider}:${model}` || entry.id === model && (entry.provider === provider || !entry.provider && ["openai", "codex", "chatgpt"].includes(provider!)))) ?? findModel(report.models, asked)
    if (!found) return { ok: false as const, message: `unknown model ${asked}` }
    choice = { model: found.id }
  }
  if (!choice) return { ok: false as const, message: "no runtime model selected" }
  if (selection.effort) {
    const problem = effortProblem(findModel(report.models, choice.model), selection.effort, selection.variant)
    if (problem) return { ok: false as const, message: problem }
  }
  return { ok: true as const, model: { ...choice, ...(selection.variant ? { variant: selection.variant } : {}), ...(selection.effort ? { effort: selection.effort } : {}) }, ...(selection.agent ? { agent: selection.agent } : {}) }
}

/**
 * Why `--effort` cannot be used with this model (and `--variant`), or undefined. A model the report does not list is left to the daemon.
 * A Claude Code model's variant naming one of its efforts is that effort, and a native variant may carry its own: asking for another effort too is a conflict, not a silent override.
 */
function effortProblem(info: ModelInfo | undefined, effort: ReasoningEffort, variant: string | undefined): string | undefined {
  if (!info) return undefined
  if (!info.efforts.length) return `${info.id} has no selectable reasoning effort; omit --effort`
  if (!info.efforts.includes(effort)) return `unknown effort ${effort} for ${info.id}; use ${info.efforts.join(", ")}`
  const implied = info.engine ? (info.efforts.includes(variant as ReasoningEffort) ? variant : undefined) : variant ? info.variants?.[variant]?.effort : undefined
  if (implied && implied !== effort) return `--variant ${variant} sets effort ${implied}, which conflicts with --effort ${effort}; use one of them`
  return undefined
}
