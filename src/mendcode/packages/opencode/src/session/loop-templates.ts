import type { LoopWorkflow } from "@/session/loop"

export type LoopTemplate = {
  id: string
  name: string
  description: string
  objective: string
  trigger?: LoopWorkflow.CreateDraftInput["trigger"]
  gates?: string[]
  stopWhen?: string[]
  policy?: LoopWorkflow.CreateDraftInput["policy"]
}

export const templates: LoopTemplate[] = [
  {
    id: "pr-watch",
    name: "PR Watch",
    description: "Poll a PR/checks/review cycle and surface only actionable next steps.",
    objective: "Monitor the active PR or requested PR until checks and review feedback are resolved. Make safe local fixes when possible and ask before push/merge/release.",
    trigger: { mode: "interval", intervalMs: 15 * 60 * 1000 },
    gates: ["checks green", "review feedback addressed", "user approval before push or merge"],
    stopWhen: ["PR merged", "user stops the loop", "blocked by credentials or external approval"],
  },
  {
    id: "ci-repair",
    name: "CI Repair",
    description: "Keep inspecting failing checks, patch locally, and wait between attempts.",
    objective: "Investigate failing CI or test output, implement focused fixes, run the narrow validation locally, and checkpoint progress after every iteration.",
    trigger: { mode: "interval", intervalMs: 10 * 60 * 1000 },
    gates: ["local focused tests pass", "no unrelated files staged", "user approval before push"],
    stopWhen: ["all targeted checks pass", "failure is external or needs credentials"],
  },
  {
    id: "research-digest",
    name: "Research Digest",
    description: "Periodically research a topic and keep a durable journal of findings.",
    objective: "Research the requested topic from primary sources, summarize changes since the previous iteration, and keep a concise journal with links and open questions.",
    trigger: { mode: "interval", intervalMs: 60 * 60 * 1000 },
    gates: ["cite primary/current sources", "separate verified facts from inference"],
    stopWhen: ["user confirms enough research", "no material changes after repeated iterations"],
  },
  {
    id: "repo-maintenance",
    name: "Repo Maintenance",
    description: "Run periodic repo hygiene without broad refactors.",
    objective: "Check the repository for focused maintenance opportunities, run narrow validation, fix small safe issues, and report any risky work instead of doing it silently.",
    trigger: { mode: "interval", intervalMs: 30 * 60 * 1000 },
    gates: ["no broad refactors without approval", "preserve dirty user changes", "focused tests before completion"],
    stopWhen: ["no safe maintenance remains", "blocked by user decision"],
  },
]

export function get(id: string | null | undefined) {
  if (!id) return undefined
  return templates.find((template) => template.id === id)
}

export function format(template: LoopTemplate) {
  return `${template.id.padEnd(16)} ${template.name} - ${template.description}`
}

export * as LoopTemplates from "./loop-templates"
