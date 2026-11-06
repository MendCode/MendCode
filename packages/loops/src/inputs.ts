import type { CreateLoopInput } from "./service"
import { getLoopTemplate, templateCriteria, templateObjective } from "./templates"

/** What a create input becomes once its template (if any) has filled in what it left out; call after `createProblems` found nothing. */
export function resolveCreateInput(input: CreateLoopInput) {
  const template = getLoopTemplate(input.template)
  return {
    template,
    objective: template ? templateObjective(template, input.objective) : input.objective!,
    trigger: input.trigger ?? template!.trigger,
    budget: input.budget ?? template!.budget,
    criteria: input.criteria ?? (template && !input.budget ? templateCriteria(template) : undefined),
    reportOnly: input.reportOnly ?? template?.reportOnly,
  }
}

/** Why a create input cannot make a loop (unknown template, missing pieces, contradictory options), or undefined when it can. */
export function createProblems(input: CreateLoopInput): string | undefined {
  const template = input.template ? getLoopTemplate(input.template) : undefined
  if (input.template && !template) return `unknown loop template "${input.template}"`
  if (!template && !(input.objective && input.trigger && input.budget)) return "a loop needs an objective, a trigger and a budget (or a template that supplies them)"
  if ((input.reportOnly ?? template?.reportOnly) && input.workspace === "worktree") return "a report-only loop never edits, so it needs no worktree"
  if ((input.rubric?.criteria.length || input.rubric?.mandatoryBlockers?.length) && (input.budget ?? template?.budget)?.mode !== "goal") return "a rubric needs a goal loop"
  return undefined
}
