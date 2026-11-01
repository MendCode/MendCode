import type { AIConfigAdvisor, ModelInfo } from "@mendcode/protocol"
import { providerName } from "./provider-presets"

/**
 * How the advisor reads in text (docs/advisor.md): `/advisor` and the AI config page's Advisor row. Usage, not money:
 * most people pay a ChatGPT or Claude subscription, so the line says which account the consultations draw on.
 */

export const ADVISOR_USAGE = "usage: /advisor [status|off|<model>[#effort]]"

/** The advisor choice and whether it applies: `off`, `gpt-6.1-sol · high · applied`, or `… · not applied: <reason>`. */
export function advisorSummary(advisor: AIConfigAdvisor | undefined): string {
  if (!advisor || advisor === "off") return "off"
  return [advisor.model, ...(advisor.effort ? [advisor.effort] : []), advisor.applied ? "applied" : `not applied: ${advisor.reason ?? "unknown reason"}`].join(" · ")
}

/** Which account a model's calls draw on. */
export function advisorAccount(model: ModelInfo | undefined): string {
  if (!model) return "account unknown"
  if (model.provider) return `API key · ${providerName(model.provider)}`
  if (model.engine === "claude") return "Claude subscription quota (Claude Code)"
  if (model.engine) return `${model.engine} account`
  return "ChatGPT subscription quota"
}

const count = (value: number) => value.toLocaleString("en-US")

/** The full `/advisor` status line. */
export function advisorStatusText(input: { advisor: AIConfigAdvisor | undefined; model: ModelInfo | undefined; usage: { calls: number; input: number; output: number }; maxCallsPerSession: number; checkpoints: readonly string[] }): string {
  if (!input.advisor || input.advisor === "off") return "advisor off · /advisor <model> picks one (it uses extra tokens on each consultation)"
  return [
    `advisor ${advisorSummary(input.advisor)}`,
    `checkpoints ${input.checkpoints.length ? input.checkpoints.join(", ") : "none (tool only)"}`,
    `${input.usage.calls}/${input.maxCallsPerSession} consultations this session`,
    `${count(input.usage.input)} in / ${count(input.usage.output)} out tokens`,
    advisorAccount(input.model),
  ].join(" · ")
}
