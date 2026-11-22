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
  if (connectors[relation]) return connectors[relation]!
  // Any other pairing of ends (`<-->`, `*--o`, `()--`, `<..>`): each end drawn as it is on a one-ended relation.
  const ends = /^(<\||\*|o|<|\(\))?(--|\.\.)(\|>|\*|o|>|\(\))?$/.exec(relation)
  if (!ends) return relation
  const left = ({ "<|": "◁", "*": "◆", o: "◇", "<": "◀", "()": "○" } as Record<string, string>)[ends[1] ?? ""] ?? (ends[2] === ".." ? "╌" : "─")
  const right = ({ "|>": "▷", "*": "◆", o: "◇", ">": "▶", "()": "○" } as Record<string, string>)[ends[3] ?? ""] ?? (ends[2] === ".." ? "╌" : "─")
  return left + (ends[2] === ".." ? "╌╌╌" : "───") + right
}

/** A class name as written: `Shape`, `shapes.Circle`, `List~T~`, or any text between backticks. */
const NAME = String.raw`(?:\x60[^\x60]+\x60|[\p{L}_][\p{L}\p{N}_.-]*(?:~[^~]+~)?)`
const RELATION = String.raw`(?:<\||\*|o|<|\(\))?(?:--|\.\.)(?:\|>|\*|o|>|\(\))?`
const CLASS_BLOCK = new RegExp(String.raw`^class\s+(${NAME})(?:\s*\[\s*"?([^"\]]*)"?\s*\])?(?:\s*:::[\w-]+)?\s*\{(.*)$`, "u")
const CLASS_RELATION = new RegExp(String.raw`^(${NAME})\s*(?:"([^"]*)"\s*)?(${RELATION})\s*(?:"([^"]*)"\s*)?(${NAME})(?:\s*:\s*(.+))?$`, "u")
const CLASS_ANNOTATED = new RegExp(String.raw`^<<\s*([^>]+?)\s*>>\s+(${NAME})$`, "u")
const CLASS_MEMBER = new RegExp(String.raw`^(${NAME})\s*:\s*(.+)$`, "u")
const CLASS_LINE = new RegExp(String.raw`^class\s+(${NAME})`, "u")
/** `List~T~` is drawn `List<T>`; backticks and a `:::style` are dropped. */
const className = (raw: string) => raw.replace(/^\x60|\x60$/g, "").replace(/~([^~]+)~/g, "<$1>")

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

    const blockStart = CLASS_BLOCK.exec(line)
    if (blockStart) {
      const name = className(blockStart[1]!)
      ensureClass(name)
      const inline = blockStart[3]!.trim()
      // `class A { +x; +y() }` on one line holds its members between the braces.
      if (inline.endsWith("}")) classes.set(name, [...classes.get(name)!, ...inline.slice(0, -1).split(/[;\n]/).map(cleanLabel).filter(Boolean)])
      else {
        currentClass = name
        if (inline) classes.set(name, [...classes.get(name)!, cleanLabel(inline)])
      }
      continue
    }

    const cardinality = CLASS_RELATION.exec(line)
    if (cardinality) {
      const from = className(cardinality[1]!)
      const to = className(cardinality[5]!)
      ensureClass(from)
      ensureClass(to)
      const counted = cardinality[2] !== undefined || cardinality[4] !== undefined
      const label = counted ? `${cardinality[2] ?? ""} → ${cardinality[4] ?? ""} ${cleanLabel(cardinality[6])}`.trim() : cleanLabel(cardinality[6]) || undefined
      relations.push({ from, to, relation: cardinality[3]!, label })
      continue
    }

    const annotated = CLASS_ANNOTATED.exec(line)
    if (annotated) {
      const name = className(annotated[2]!)
      ensureClass(name)
      classes.set(name, [`«${annotated[1]}»`, ...classes.get(name)!])
      continue
    }

    const member = CLASS_MEMBER.exec(line)
    if (member) {
      const name = className(member[1]!)
      ensureClass(name)
      classes.set(name, [...(classes.get(name) ?? []), cleanLabel(member[2]!)])
      continue
    }

    const classLine = CLASS_LINE.exec(line)
    if (classLine) {
      ensureClass(className(classLine[1]!))
      continue
    }
    // Notes, links and styling have no place in the boxes; the classes and their relations are the diagram.
    if (/^(?:classDef|style|click|link|callback|linkStyle|cssClass|annotation|note|title|accTitle|accDescr)\b/.test(line)) continue
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
    // A row of classes wider than the room is stacked instead: every class and relation is still drawn.
    const sideways = direction === "LR" || direction === "RL" ? sceneText(horizontalScene(nodes, edges, width, direction === "RL")) : undefined
    return sideways ?? sceneText(graphScene(direction === "BT" ? nodes.reverse() : nodes, edges, width))
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
