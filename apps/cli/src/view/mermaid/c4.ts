// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, renderEntityBox, renderConnectedDiagramBoxes } from "./legacy-shared"

function stripMermaidCallArguments(input: string) {
  const inside = input
  const parts: string[] = []
  let current = ""
  let quoted = false
  for (const char of inside) {
    if (char === '"') quoted = !quoted
    if (char === "," && !quoted) {
      parts.push(cleanLabel(current))
      current = ""
      continue
    }
    current += char
  }
  if (current) parts.push(cleanLabel(current))
  if (quoted) throw new Error("unclosed argument")
  return parts
}

export function renderC4Diagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^C4/i.test(lines[0]! ?? "")) return undefined

  const body = lines.slice(1)
  const entityPattern = /^(Person(?:_Ext)?|System(?:_Ext|Db(?:_Ext)?|Queue(?:_Ext)?|_Boundary)?|Enterprise_Boundary|Container(?:_Ext|Db(?:_Ext)?|Queue(?:_Ext)?|_Boundary)?|Component(?:_Ext|Db(?:_Ext)?|Queue(?:_Ext)?)|Boundary|Deployment_Node|Node(?:_L|_R)?)\s*\((.+)\)\s*\{?$/i
  const entities = new Map<string, { label: string; kind: string; description?: string | undefined }>()
  for (const line of body) {
    const entity = entityPattern.exec(line)
    if (!entity) continue
    const args = stripMermaidCallArguments(entity[2]!)
    const id = args[0]! || "item"
    entities.set(id, { label: args[1]! || id, kind: entity[1]!, description: args[2]! })
  }

  const output: string[] = [`C4 ${cleanLabel(lines[0]!).replace(/^C4\s*/i, "") || "diagram"}`]
  const relations: Array<{ from: string; to: string; label: string }> = []
  for (const line of body) {
    const relation = /^(RelIndex|Rel(?:_[A-Za-z]+)?|BiRel)\s*\((.+)\)$/i.exec(line)
    if (relation) {
      const args = stripMermaidCallArguments(relation[2]!)
      const offset = relation[1]!.toLowerCase() === "relindex" ? 1 : 0
      relations.push({ from: args[offset]! || "from", to: args[offset + 1]! || "to", label: args[offset + 2]! || "relates" })
      continue
    }

    const entity = entityPattern.exec(line)
    if (entity) {
      const args = stripMermaidCallArguments(entity[2]!)
      const id = args[0]! || "item"
      const label = args[1]! || id
      entities.set(id, { label, kind: entity[1]!, description: args[2]! })
    }
  }
  const boxFor = (id: string) => {
    const entity = entities.get(id)
    return renderEntityBox(`${entity?.kind ?? "Element"} · ${entity?.label ?? id}`, entity?.description ? [entity.description] : [])
  }
  const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]))
  for (const [index, relation] of relations.entries()) {
    if (index > 0) output.push("")
    output.push(...renderConnectedDiagramBoxes({ left: boxFor(relation.from), right: boxFor(relation.to), connector: "────▶", label: relation.label }))
  }
  for (const id of entities.keys()) {
    if (related.has(id)) continue
    if (output.length > 1) output.push("")
    output.push(...boxFor(id))
  }
  if (relations.some((relation) => !entities.has(relation.from) || !entities.has(relation.to))) return undefined
  return output.length > 1 ? output.join("\n") : undefined
}
