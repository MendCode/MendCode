import type { LoopBudget, LoopTemplateInfo, LoopTrigger } from "@mendcode/protocol"
import { describeTrigger } from "./schedule"

/**
 * A named starting point for a loop (ported from v1's loop templates). Everything it fills in can be overridden at
 * creation; `rules` and `stopWhen` (v1's gates and stop conditions) are written into the objective so every run reads them.
 */
export type LoopTemplate = {
  id: string
  name: string
  description: string
  objective: string
  rules: readonly string[]
  stopWhen: readonly string[]
  trigger: LoopTrigger
  budget: LoopBudget
  reportOnly?: boolean
}

const MINUTE = 60_000

export const LOOP_TEMPLATES: readonly LoopTemplate[] = [
  {
    id: "pr-watch",
    name: "PR Watch",
    description: "Poll a PR/checks/review cycle and surface only actionable next steps.",
    objective: "Monitor the active PR or requested PR until checks and review feedback are resolved. Make safe local fixes when possible and ask before push/merge/release.",
    rules: ["checks green", "review feedback addressed", "user approval before push or merge"],
    stopWhen: ["PR merged", "user stops the loop", "blocked by credentials or external approval"],
    trigger: { kind: "adaptive", everyMs: 15 * MINUTE, minMs: 5 * MINUTE, maxMs: 2 * 60 * MINUTE },
    budget: { mode: "goal", maxRuns: 100 },
  },
  {
    id: "ci-repair",
    name: "CI Repair",
    description: "Keep inspecting failing checks, patch locally, and wait between attempts.",
    objective: "Investigate failing CI or test output, implement focused fixes, run the narrow validation locally, and checkpoint progress after every iteration.",
    rules: ["local focused tests pass", "no unrelated files staged", "user approval before push"],
    stopWhen: ["all targeted checks pass", "failure is external or needs credentials"],
    trigger: { kind: "interval", everyMs: 10 * MINUTE },
    budget: { mode: "goal", maxRuns: 50 },
  },
  {
    id: "research-digest",
    name: "Research Digest",
    description: "Periodically research a topic and keep a durable journal of findings.",
    objective: "Research the requested topic from primary sources, summarize changes since the previous iteration, and keep a concise journal with links and open questions.",
    rules: ["cite primary/current sources", "separate verified facts from inference"],
    stopWhen: ["user confirms enough research", "no material changes after repeated iterations"],
    trigger: { kind: "adaptive", everyMs: 60 * MINUTE, minMs: 30 * MINUTE, maxMs: 24 * 60 * MINUTE },
    budget: { mode: "monitor" },
    reportOnly: true,
  },
  {
    id: "repo-maintenance",
    name: "Repo Maintenance",
    description: "Run periodic repo hygiene without broad refactors.",
    objective: "Check the repository for focused maintenance opportunities, run narrow validation, fix small safe issues, and report any risky work instead of doing it silently.",
    rules: ["no broad refactors without approval", "preserve dirty user changes", "focused tests before completion"],
    stopWhen: ["no safe maintenance remains", "blocked by user decision"],
    trigger: { kind: "interval", everyMs: 30 * MINUTE },
    budget: { mode: "monitor" },
  },
]

export function getLoopTemplate(id: string | undefined): LoopTemplate | undefined {
  return id ? LOOP_TEMPLATES.find((template) => template.id === id) : undefined
}

/** The objective a template creates: its text plus the rules and stop conditions, and what the user asked on top. */
export function templateObjective(template: LoopTemplate, extra?: string): string {
  return [
    template.objective,
    ...(extra?.trim() ? ["", `Specifically: ${extra.trim()}`] : []),
    "",
    `Rules:\n${template.rules.map((rule) => `- ${rule}`).join("\n")}`,
    "",
    `Stop and report when:\n${template.stopWhen.map((condition) => `- ${condition}`).join("\n")}`,
  ].join("\n")
}

/** What a template fills in for a goal loop: the first stop condition is what "done" means. */
export function templateCriteria(template: LoopTemplate): string | undefined {
  return template.budget.mode === "goal" ? template.stopWhen[0] : undefined
}

export function describeTemplate(template: LoopTemplate): LoopTemplateInfo {
  const budget = template.budget.mode === "goal" ? "until the goal is met" : template.budget.mode === "monitor" ? "until stopped" : `${template.budget.maxRuns} runs`
  return { id: template.id, name: template.name, description: template.description, summary: `${describeTrigger(template.trigger)}, ${budget}${template.reportOnly ? ", report-only" : ""}` }
}
