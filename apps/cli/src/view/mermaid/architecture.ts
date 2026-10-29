import { graphScene, sceneText } from "./graph-scene"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel } from "./legacy-shared"

export function renderArchitectureDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^architecture-beta$/i.test(lines[0]! ?? "")) return undefined

  const body = lines.slice(1)
  const groups = new Map<string, { label: string; icon: string; parent?: string | undefined }>()
  const nodes = new Map<string, { label: string; icon: string; group?: string | undefined; junction: boolean }>()
  const relations: Array<{ from: string; to: string; connector: string }> = []
  for (const line of body) {
    const service = /^(?:service)\s+([A-Za-z][\w-]*)\(([^)]+)\)\[([^\]]+)\](?:\s+in\s+([A-Za-z][\w-]*))?$/i.exec(line)
    if (service) {
      nodes.set(service[1]!, { label: cleanLabel(service[3]!), icon: cleanLabel(service[2]!), group: service[4]!, junction: false })
      continue
    }
    const group = /^group\s+([A-Za-z][\w-]*)\(([^)]+)\)\[([^\]]+)\](?:\s+in\s+([A-Za-z][\w-]*))?$/i.exec(line)
    if (group) {
      groups.set(group[1]!, { label: cleanLabel(group[3]!), icon: cleanLabel(group[2]!), parent: group[4]! })
      continue
    }
    const junction = /^junction\s+([A-Za-z][\w-]*)(?:\s+in\s+([A-Za-z][\w-]*))?$/i.exec(line)
    if (junction) {
      nodes.set(junction[1]!, { label: junction[1]!, icon: "junction", group: junction[2]!, junction: true })
      continue
    }
    const edge = /^([A-Za-z][\w-]*)(?:\{[^}]+\})?(?::[A-Z])?\s*(<-->|<--|-->|---|--|<->)\s*(?:[A-Z]:)?([A-Za-z][\w-]*)(?:\{[^}]+\})?$/i.exec(line)
    if (!edge) return undefined
    relations.push({ from: edge[1]!, to: edge[3]!, connector: edge[2]! })
  }

  const groupLabel = (id: string | undefined): string | undefined => {
    if (!id) return undefined
    const names: string[] = []
    const seen = new Set<string>()
    while (id) {
      if (seen.has(id)) throw new Error("cyclic group")
      seen.add(id)
      const group = groups.get(id)
      if (!group) throw new Error("unknown group")
      names.unshift(`${group.label} · ${group.icon}`)
      id = group.parent
    }
    return names.join(" / ")
  }
  const sceneNodes = [...nodes].map(([id, node]) => ({ id, label: node.junction ? `◆ ${node.label}` : node.label, fields: node.junction ? [] : [node.icon], ...(node.group ? { group: groupLabel(node.group) ?? node.group } : {}) }))
  const sceneEdges = relations.map((relation) => ({ from: relation.connector === "<--" ? relation.to : relation.from, to: relation.connector === "<--" ? relation.from : relation.to, head: relation.connector === "--" || relation.connector === "---" ? "─" : "◀", ...(["<-->", "<->"].includes(relation.connector) ? { tail: "▶" } : {}) }))
  const result = sceneText(graphScene(sceneNodes, sceneEdges, width))
  return result ? "Architecture\n" + result : undefined
}
