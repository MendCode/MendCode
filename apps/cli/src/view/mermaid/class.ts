// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, renderConnectedDiagramBoxes, renderEntityBox } from "./legacy-shared"
import { graphScene, horizontalScene, sceneText } from "./graph-scene"

function classRelationConnector(relation: string) {
  const connectors: Record<string, string> = {
    "<|--": "◁────",
    "--|>": "────▷",
    "*--": "◆────",
    "--*": "────◆",
    "o--": "◇────",
    "--o": "────◇",
    "-->": "────▶",
    "<--": "◀────",
    "..>": "╌╌╌▶",
    "<..": "◀╌╌╌",
    "..|>": "╌╌╌▷",
    "<|..": "◁╌╌╌",
    "--": "─────",
    "..": "╌╌╌╌╌",
  }
  return connectors[relation]! ?? relation
}

export function renderClassDiagram(input: string, width: number): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^classDiagram(?:-v2)?$/i.test(lines[0]! ?? "")) return undefined

  const classes = new Map<string, string[]>()
  const relations: Array<{ from: string; to: string; relation: string; label?: string | undefined }> = []
  let currentClass: string | undefined
  const namespaces: string[] = []
  const groups = new Map<string, string>()
  let direction = "TB"
  let explicitDirection = false

  const ensureClass = (name: string) => {
    if (!classes.has(name)) classes.set(name, [])
    if (namespaces.length) groups.set(name, namespaces.join(" / "))
  }

  for (const line of lines.slice(1)) {
    if (line === "}") {
      if (currentClass) currentClass = undefined
      else if (!namespaces.pop()) return undefined
      continue
    }

    const dir = /^direction\s+(TB|BT|LR|RL)$/i.exec(line)
    if (dir) {
      direction = dir[1]!.toUpperCase()
      explicitDirection = true
      continue
    }
    const namespace = /^namespace\s+([\w.-]+)\s*\{$/.exec(line)
    if (namespace && !currentClass) {
      namespaces.push(namespace[1]!)
      continue
    }

    if (currentClass) {
      classes.set(currentClass, [...(classes.get(currentClass) ?? []), cleanLabel(line)])
      continue
    }

    const blockStart = /^class\s+([A-Za-z][\w-]*)\s*\{$/.exec(line)
    if (blockStart) {
      currentClass = blockStart[1]!
      ensureClass(currentClass)
      continue
    }

    const cardinality = /^([A-Za-z][\w-]*)\s+"([^\"]+)"\s+(\S+)\s+"([^\"]+)"\s+([A-Za-z][\w-]*)(?:\s*:\s*(.+))?$/.exec(line)
    if (cardinality) {
      ensureClass(cardinality[1]!)
      ensureClass(cardinality[5]!)
      relations.push({ from: cardinality[1]!, to: cardinality[5]!, relation: cardinality[3]!, label: `${cardinality[2]} → ${cardinality[4]} ${cleanLabel(cardinality[6])}` })
      continue
    }

    const relation = /^([A-Za-z][\w-]*)\s+(<\|--|--\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|\.\.\|>|<\|\.\.|\.\.|--)\s+([A-Za-z][\w-]*)(?:\s*:\s*(.+))?$/.exec(line)
    if (relation) {
      ensureClass(relation[1]!)
      ensureClass(relation[3]!)
      relations.push({ from: relation[1]!, to: relation[3]!, relation: relation[2]!, label: cleanLabel(relation[4]!) || undefined })
      continue
    }

    const member = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(line)
    if (member) {
      ensureClass(member[1]!)
      classes.set(member[1]!, [...(classes.get(member[1]!) ?? []), cleanLabel(member[2]!)])
      continue
    }

    const classLine = /^class\s+([A-Za-z][\w-]*)/.exec(line)
    if (classLine) {
      ensureClass(classLine[1]!)
      continue
    }
    if (/^(?:classDef|style|click|linkStyle|cssClass|annotation)\b/.test(line)) continue
    return undefined
  }

  if (currentClass || namespaces.length || (classes.size === 0 && relations.length === 0)) return undefined
  const scene = () => {
    const nodes = [...classes].map(([id, fields]) => ({ id, label: id, fields, ...(groups.has(id) ? { group: groups.get(id)! } : {}) }))
    const edges = relations.map((relation) => {
      const connector = classRelationConnector(relation.relation)
      const head = connector.at(-1)!
      const tail = connector[0]!
      return { from: relation.from, to: relation.to, ...(relation.label ? { label: relation.label } : {}), dashed: relation.relation.includes(".."), head: head === "▶" ? "◀" : head === "▷" ? "◁" : /[◆◇]/.test(head) ? head : "─", ...(/[◀◁◆◇]/.test(tail) ? { tail } : {}) }
    })
    return sceneText(direction === "LR" || direction === "RL" ? horizontalScene(nodes, edges, width, direction === "RL") : graphScene(direction === "BT" ? nodes.reverse() : nodes, edges, width))
  }
  if (groups.size || explicitDirection) return scene()
  const related = new Set(relations.flatMap((relation) => [relation.from, relation.to]))
  const blocks = relations.slice(0).flatMap((relation, index) => {
    const block = renderConnectedDiagramBoxes({
      left: renderEntityBox(relation.from, classes.get(relation.from) ?? []),
      right: renderEntityBox(relation.to, classes.get(relation.to) ?? []),
      connector: classRelationConnector(relation.relation),
      label: relation.label,
    })
    return index === 0 ? block : ["", ...block]
  })
  for (const [name, members] of classes) {
    if (related.has(name)) continue
    blocks.push(...(blocks.length > 0 ? [""] : []), ...renderEntityBox(name, members))
  }
  const output = blocks.join("\n")
  return output.split("\n").some((row) => Bun.stringWidth(row) > width) ? scene() : output
}
