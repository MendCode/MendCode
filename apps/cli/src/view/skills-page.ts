import type { SkillsReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid, clip } from "./deck"
import { pickerFrame } from "./picker-frame"
import { fuzzyScore } from "./fuzzy"
import { wrap } from "./wrap"
export type SkillsState = { query: string; selected: number; body?: string; scroll: number }
export const createSkillsState = (): SkillsState => ({ query: "", selected: 0, scroll: 0 })
export function skillOptions(report: SkillsReport | undefined, query: string) {
  // `user-invocable: false` hides a skill from this page and the slash menu; the model still sees it.
  return (report?.skills ?? []).filter((skill) => skill.userInvocable !== false).flatMap((skill) => {
    const score = fuzzyScore(query, `${skill.name} ${skill.description} ${skill.source} ${skill.pkg ?? ""}`)
    return score === undefined ? [] : [{ skill, score }]
  }).sort((a, b) => query ? b.score - a.score : a.skill.name.localeCompare(b.skill.name)).map((entry) => entry.skill)
}
type SkillRow = NonNullable<SkillsReport["skills"][number]>
/** What the file declared and what MendCode did with it: layer, model-invocation, ignored fields, notes and what it overrides. */
export function skillFacts(skill: SkillRow, report: SkillsReport | undefined): string[] {
  const findings = report?.findings
  return [
    ...(skill.layer ? [`layer: ${skill.layer}`] : []),
    ...(skill.disableModelInvocation ? ["only you can run it: /" + skill.name] : []),
    ...(skill.ignoredFields?.length ? [`ignored fields: ${skill.ignoredFields.join(", ")}`] : []),
    ...(skill.notes ?? []).map((note) => `note: ${note}`),
    ...(findings?.overridden ?? []).filter((entry) => entry.kind === "skill" && entry.name === skill.name).map((entry) => `overrides ${entry.layer}`),
  ]
}
export function renderSkillsPage(input: { state: SkillsState; report: SkillsReport | undefined; error: string; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const skills = skillOptions(input.report, state.query)
  const selected = skills[state.selected]
  const room = Math.max(0, height - 2)
  const content = (w: number): Line[] => [...wrap(state.body ?? selected?.description ?? "", w).map((text): Line => [{ text, fg: "text" }]), ...(state.body ? [] : selected ? [[], ...wrap(selected.dir, w).map((text): Line => [{ text, fg: "muted" }]), ...skillFacts(selected, input.report).flatMap((fact) => wrap(fact, w).map((text): Line => [{ text, fg: "muted" }]))] : [])]
  const list = (w: number): Line[] => [...(skills.length ? skills.flatMap((skill, i): Line[] => [clip([{ text: `${i === state.selected ? "› " : "  "}[${skill.enabled ? "on" : "off"}] ${skill.name} · ${skill.pkg ?? skill.source}`, fg: i === state.selected ? "primary" : "text" }], w), ...wrap(skill.description, w - 2).slice(0, 1).map((text): Line => [{ text: `  ${text}`, fg: "muted" }])]) : [[{ text: input.error || (input.report ? "No matching skills" : "Loading skills…"), fg: input.error ? "error" : "muted" }]] as Line[])]
  const body = state.body ? [[{ title: selected?.name ?? "Skill", body: content, scroll: state.scroll }]] : [[{ title: "Skills", body: list, weight: 3, scroll: Math.max(0, state.selected * 2 - room + 6), active: true }, ...(width >= 110 ? [{ title: "Instructions", body: content, weight: 2 }] : [])]]
  return pickerFrame("Skills", state.body ? "↑↓ scroll · esc back" : width < 70 ? "↑↓ · enter toggle · ctrl+l load · esc back" : "↑↓ · enter/space toggle · ctrl+l load · tab insert · esc back", width, height, panelGrid({ width, compact: false, padding: true, ...(width < 70 ? { maxColumns: 1 } : {}), heights: [room], rows: body }), state.body ? selected?.name ?? "" : `Search / ${state.query}${input.error ? ` · ${input.error}` : ""}`)
}
