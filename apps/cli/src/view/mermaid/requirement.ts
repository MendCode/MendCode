// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, renderEntityBox, renderConnectedDiagramBoxes } from "./legacy-shared"

export function renderRequirementDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^requirementDiagram$/i.test(lines[0]! ?? "")) return undefined

  const requirements = new Map<string, { kind: string; fields: string[] }>()
  const relations: Array<{ from: string; to: string; type: string; reverse: boolean }> = []
  let current: string | undefined
  for (const line of lines.slice(1)) {
    const block = /^(requirement|functionalRequirement|performanceRequirement|interfaceRequirement|physicalRequirement|designConstraint|element)\s+([A-Za-z][\w-]*)\s*\{?$/i.exec(line)
    if (block) {
      current = block[2]!
      requirements.set(current, { kind: block[1]!, fields: [] })
      continue
    }
    if (line === "}") {
      current = undefined
      continue
    }
    const field = /^(id|text|risk|verifymethod|verifyMethod|type|docref|docRef):\s*(.+)$/i.exec(line)
    if (field && current) {
      const item = requirements.get(current)
      if (item) item.fields.push(`${field[1]!}: ${cleanLabel(field[2]!)}`)
      continue
    }
    const relation = /^([A-Za-z][\w-]*)\s+(<-|-)\s*(contains|copies|derives|satisfies|verifies|refines|traces)\s*(->|-)\s+([A-Za-z][\w-]*)$/i.exec(line)
    if (!relation) return undefined
    relations.push({ from: relation[1]!, to: relation[5]!, type: relation[3]!, reverse: relation[2]! === "<-" })
  }
  if (current || requirements.size === 0 || relations.some((relation) => !requirements.has(relation.from) || !requirements.has(relation.to))) return undefined
  const boxFor = (id: string) => {
    const requirement = requirements.get(id)
    return renderEntityBox(`«${requirement?.kind ?? "requirement"}» ${id}`, requirement?.fields ?? [])
  }
  const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]))
  const output: string[] = ["Requirement diagram"]
  for (const [index, relation] of relations.entries()) {
    if (index > 0) output.push("")
    output.push(...renderConnectedDiagramBoxes({
      left: boxFor(relation.from),
      right: boxFor(relation.to),
      connector: relation.reverse ? "◀────" : "────▶",
      label: relation.type,
    }))
  }
  for (const id of requirements.keys()) {
    if (related.has(id)) continue
    if (output.length > 1) output.push("")
    output.push(...boxFor(id))
  }
  return output.join("\n")
}
