import { assertCanvas, MERMAID_NOTES } from "./core"
import { cells, textWidth, wrap } from "../wrap"
// Shared parsing and grid primitives from the v1 terminal renderer.
function uncomment(raw: string) {
  let quote = ""
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char === "\\") {
      i++
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
    } else if (char === '"' || char === "`") quote = char
    else if (raw.startsWith("%%", i)) return raw.slice(0, i).trimEnd()
  }
  return raw
}

export function preparedMermaidLines(input: string) {
  const lines: string[] = []
  let inFrontmatter = false
  let inDirective = false
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (lines.length === 0 && !inFrontmatter && line === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === "---") inFrontmatter = false
      continue
    }
    if (inDirective) {
      if (line.includes("}%%")) inDirective = false
      continue
    }
    if (line.startsWith("%%{")) {
      if (!line.includes("}%%")) inDirective = true
      continue
    }
    if (line.startsWith("%%")) continue
    const content = uncomment(raw).trim()
    if (content) lines.push(content)
  }
  return lines
}

export function cleanLabel(input: string | undefined) {
  return (input ?? "")
    .replace(/[`"'{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function cleanConnectorLabel(input: string | undefined) {
  return (input ?? "")
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function renderBox(label: string) {
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "step"
  const width = Math.max(10, Bun.stringWidth(text) + 2)
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

export function renderEntityBox(label: string, fields: string[]) {
  if (fields.length === 0) return renderBox(label)

  const name = cleanMermaidLabel(label) || cleanLabel(label) || "entity"
  const fieldLines = fields.map((field) => cleanMermaidLabel(field) || cleanLabel(field)).filter(Boolean)
  const width = Math.max(10, Bun.stringWidth(name) + 2, ...fieldLines.map((field) => Bun.stringWidth(field) + 2))
  const center = centerVisual(name, width)
  const rows = fieldLines.map((field) => {
    const padded = ` ${field} `
    return `│${padded}${" ".repeat(Math.max(0, width - Bun.stringWidth(padded)))}│`
  })

  return [
    `╭${"─".repeat(width)}╮`,
    `│${center}│`,
    `├${"─".repeat(width)}┤`,
    ...rows,
    `╰${"─".repeat(width)}╯`,
  ]
}

export function renderCompactBox(label: string, minWidth = 8) {
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "item"
  const width = Math.max(minWidth, Bun.stringWidth(text) + 2)
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

export type FlowchartEdge = { from: string; to: string; label?: string | undefined }

export type FlowchartNodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "circle"
  | "double-circle"
  | "diamond"
  | "cylinder"
  | "subroutine"
  | "parallelogram"
  | "trapezoid"
  | "hexagon"
  | "asymmetric"
  | (string & {})

export type ConnectorDirection = "up" | "down" | "left" | "right"

export function connectorGlyph(directions: Set<ConnectorDirection>) {
  const up = directions.has("up")
  const down = directions.has("down")
  const left = directions.has("left")
  const right = directions.has("right")

  if (up && down && left && right) return "┼"
  if (up && down && left) return "┤"
  if (up && down && right) return "├"
  if (down && left && right) return "┬"
  if (up && left && right) return "┴"
  if (down && right) return "┌"
  if (down && left) return "┐"
  if (up && right) return "└"
  if (up && left) return "┘"
  if (left || right) return "─"
  if (up || down) return "│"
  return " "
}

export function addConnectorDirection(
  cells: Set<ConnectorDirection>[][],
  row: number,
  column: number,
  direction: ConnectorDirection,
) {
  const cell = cells[row]!?.[column]!
  if (cell) cell.add(direction)
}

export function drawVerticalConnector(
  cells: Set<ConnectorDirection>[][],
  column: number,
  start: number,
  end: number,
) {
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  for (let row = low; row <= high; row++) {
    if (row > low) addConnectorDirection(cells, row, column, "up")
    if (row < high) addConnectorDirection(cells, row, column, "down")
  }
}

export function drawHorizontalConnector(
  cells: Set<ConnectorDirection>[][],
  row: number,
  start: number,
  end: number,
) {
  const low = Math.min(start, end)
  const high = Math.max(start, end)
  for (let column = low; column <= high; column++) {
    if (column > low) addConnectorDirection(cells, row, column, "left")
    if (column < high) addConnectorDirection(cells, row, column, "right")
  }
}

export function flowchartRanks(nodes: string[], edges: FlowchartEdge[]) {
  const outgoing = new Map<string, FlowchartEdge[]>()
  const incoming = new Map<string, number>()
  for (const node of nodes) {
    outgoing.set(node, [])
    incoming.set(node, 0)
  }
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  const ranks = new Map(nodes.map((node) => [node, 0]))
  const queue = nodes.filter((node) => incoming.get(node) === 0)
  const processed = new Set<string>()

  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]!
    if (!node) continue
    processed.add(node)
    for (const edge of outgoing.get(node) ?? []) {
      ranks.set(edge.to, Math.max(ranks.get(edge.to) ?? 0, (ranks.get(node) ?? 0) + 1))
      const remaining = (incoming.get(edge.to) ?? 0) - 1
      incoming.set(edge.to, remaining)
      if (remaining === 0) queue.push(edge.to)
    }
  }

  if (processed.size !== nodes.length) return undefined
  return ranks
}

export function flowchartLayoutEdges(nodes: string[], edges: FlowchartEdge[]) {
  const outgoing = new Map<string, FlowchartEdge[]>()
  for (const node of nodes) outgoing.set(node, [])
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])

  const state = new Map<string, "visiting" | "visited">()
  const layoutEdges: FlowchartEdge[] = []
  const deferredEdges: FlowchartEdge[] = []
  const visit = (node: string) => {
    state.set(node, "visiting")
    for (const edge of outgoing.get(node) ?? []) {
      if (state.get(edge.to) === "visiting") {
        deferredEdges.push(edge)
        continue
      }

      layoutEdges.push(edge)
      if (!state.has(edge.to)) visit(edge.to)
    }
    state.set(node, "visited")
  }

  for (const node of nodes) {
    if (!state.has(node)) visit(node)
  }

  return { layoutEdges, deferredEdges }
}

export function putOverlay(canvas: Map<number, string>, width: number, row: number, start: number, text: string) {
  let column = start
  for (const cell of cells(text)) {
    if (column >= 0 && column + cell.width <= width) {
      canvas.set(row * width + column, cell.text)
      for (let k = 1; k < cell.width; k++) canvas.set(row * width + column + k, "")
    }
    column += cell.width
  }
}

export function stripAngleBracketMarkup(input: string) {
  let output = ""
  let insideTag = false
  for (const character of input) {
    if (character === "<") {
      insideTag = true
      continue
    }
    if (character === ">" && insideTag) {
      insideTag = false
      continue
    }
    if (!insideTag) output += character
  }
  return output
}

export function cleanMermaidLabel(input: string | undefined) {
  return stripAngleBracketMarkup(
    (input ?? "")
      .trim()
      .replace(/^(?:["'`])([\s\S]*)(?:["'`])$/, "$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/#(quot|apos|amp|lt|gt);/gi, (_match, entity: string) => {
        const values: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" }
        return values[entity.toLowerCase()]! ?? _match
      })
      .replace(/&quot;|&apos;|&amp;|&lt;|&gt;/gi, (match) => {
        const values: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" }
        return values[match.toLowerCase()]! ?? match
      }),
  )
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .replace(/\\(["'`])/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" / ")
    .replace(/\s+/g, " ")
    .trim()
}

export function topLevelMask(input: string) {
  const output = [...input]
  const stack: string[] = []
  let quote: string | undefined
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}" }

  for (let index = 0; index < output.length; index++) {
    const character = output[index]!
    if (quote) {
      output[index]! = " "
      if (character === quote && input[index - 1]! !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      output[index]! = " "
      quote = character
      continue
    }
    if (stack.length > 0) {
      output[index]! = " "
      if (character === stack[stack.length - 1]!) stack.pop()
      else if (pairs[character]!) stack.push(pairs[character]!)
      continue
    }
    if (pairs[character]!) {
      output[index]! = " "
      stack.push(pairs[character]!)
    }
  }

  return output.join("")
}

export function splitMermaidTopLevel(input: string, separator: string) {
  const parts: string[] = []
  let start = 0
  let quote: string | undefined
  const stack: string[] = []
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}" }

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!
    if (quote) {
      if (character === quote && input[index - 1]! !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (stack.length > 0) {
      if (character === stack[stack.length - 1]!) stack.pop()
      else if (pairs[character]!) stack.push(pairs[character]!)
      continue
    }
    if (pairs[character]!) {
      stack.push(pairs[character]!)
      continue
    }
    if (input.startsWith(separator, index)) {
      parts.push(input.slice(start, index).trim())
      start = index + separator.length
      index += separator.length - 1
    }
  }
  parts.push(input.slice(start).trim())
  return parts.filter(Boolean)
}

export function flowchartShapeForExpression(expression: string): FlowchartNodeShape {
  if (expression.startsWith("(((") && expression.endsWith(")))")) return "double-circle"
  if (expression.startsWith("((") && expression.endsWith("))")) return "circle"
  if (expression.startsWith("([") && expression.endsWith("])")) return "stadium"
  if (expression.startsWith("{{") && expression.endsWith("}}")) return "hexagon"
  if (expression.startsWith("[(") && expression.endsWith(")]")) return "cylinder"
  if (expression.startsWith("[[") && expression.endsWith("]]")) return "subroutine"
  if (expression.startsWith("[/\\") && expression.endsWith("\\/]")) return "trapezoid"
  if (expression.startsWith("[/") && expression.endsWith("/]") || expression.startsWith("[\\") && expression.endsWith("\\]")) {
    return "parallelogram"
  }
  if (expression.startsWith("[>") && expression.endsWith("]")) return "asymmetric"
  if (expression.startsWith("[") && expression.endsWith("]")) return "rect"
  if (expression.startsWith("(") && expression.endsWith(")")) return "round"
  if (expression.startsWith("{") && expression.endsWith("}")) return "diamond"
  return "rect"
}

export function parseFlowchartNodeExpression(expression: string): { id: string; label: string; shape: FlowchartNodeShape } | undefined {
  const text = expression
    .trim()
    .replace(/\s*:::[A-Za-z_][\w-]*\s*$/, "")
    .replace(/;\s*$/, "")
    .trim()
  const idMatch = /^([A-Za-z_][\w.:-]*)/.exec(text)
  if (!idMatch) return undefined
  const id = idMatch[1]!
  const rest = text.slice(id.length).trim()
  if (!rest) return { id, label: id, shape: "rect" }

  if (rest.startsWith("@{") && rest.endsWith("}")) {
    const values = new Map<string, string>()
    for (const item of splitMermaidTopLevel(rest.slice(2, -1), ",")) {
      const separator = item.indexOf(":")
      if (separator < 0) continue
      values.set(item.slice(0, separator).trim().toLowerCase(), cleanMermaidLabel(item.slice(separator + 1)))
    }
    const shapeName = values.get("shape")?.toLowerCase()
    const shapeAliases: Record<string, FlowchartNodeShape> = {
      bang: "bang",
      rect: "rect",
      proc: "rect",
      process: "rect",
      rectangle: "rect",
      rounded: "round",
      event: "round",
      stadium: "stadium",
      pill: "stadium",
      terminal: "stadium",
      circle: "circle",
      circ: "circle",
      dbl_circle: "double-circle",
      "dbl-circ": "double-circle",
      "double-circle": "double-circle",
      diamond: "diamond",
      diam: "diamond",
      decision: "diamond",
      question: "diamond",
      hexagon: "hexagon",
      hex: "hexagon",
      prepare: "hexagon",
      cylinder: "cylinder",
      cyl: "cylinder",
      database: "cylinder",
      db: "cylinder",
      subroutine: "subroutine",
      subproc: "fr-rect",
      subprocess: "fr-rect",
      "framed-rectangle": "fr-rect",
      "fr-rect": "fr-rect",
      parallelogram: "parallelogram",
      trapezoid: "trapezoid",
      "trap-b": "trap-b",
      "trap-t": "trap-t",
      priority: "trap-b",
      "trapezoid-bottom": "trap-b",
      "inv-trapezoid": "trap-t",
      manual: "trap-t",
      "trapezoid-top": "trap-t",
      "notch-rect": "notch-rect",
      card: "notch-rect",
      "notched-rectangle": "notch-rect",
      cloud: "cloud",
      hourglass: "hourglass",
      collate: "hourglass",
      bolt: "bolt",
      "com-link": "bolt",
      "lightning-bolt": "bolt",
      brace: "brace",
      "brace-l": "brace",
      comment: "brace",
      "brace-r": "brace-r",
      braces: "braces",
      "lean-r": "lean-r",
      "in-out": "lean-r",
      "lean-right": "lean-r",
      "lean-l": "lean-l",
      "out-in": "lean-l",
      "lean-left": "lean-l",
      datastore: "datastore",
      "data-store": "datastore",
      delay: "delay",
      "half-rounded-rectangle": "delay",
      "h-cyl": "h-cyl",
      das: "h-cyl",
      "horizontal-cylinder": "h-cyl",
      "lin-cyl": "lin-cyl",
      disk: "lin-cyl",
      "lined-cylinder": "lin-cyl",
      "curv-trap": "curv-trap",
      display: "curv-trap",
      "curved-trapezoid": "curv-trap",
      "div-rect": "div-rect",
      "div-proc": "div-rect",
      "divided-process": "div-rect",
      "divided-rectangle": "div-rect",
      doc: "doc",
      document: "doc",
      tri: "tri",
      extract: "tri",
      triangle: "tri",
      fork: "fork",
      join: "fork",
      "win-pane": "win-pane",
      "internal-storage": "win-pane",
      "window-pane": "win-pane",
      "f-circ": "f-circ",
      "filled-circle": "f-circ",
      junction: "f-circ",
      "lin-doc": "lin-doc",
      "lined-document": "lin-doc",
      "lin-rect": "lin-rect",
      "lin-proc": "lin-rect",
      "lined-process": "lin-rect",
      "lined-rectangle": "lin-rect",
      "shaded-process": "lin-rect",
      "notch-pent": "notch-pent",
      "loop-limit": "notch-pent",
      "notched-pentagon": "notch-pent",
      "flip-tri": "flip-tri",
      "flipped-triangle": "flip-tri",
      "manual-file": "flip-tri",
      "sl-rect": "sl-rect",
      "manual-input": "sl-rect",
      "sloped-rectangle": "sl-rect",
      "multi-document": "docs",
      docs: "docs",
      documents: "docs",
      "st-doc": "docs",
      "stacked-document": "docs",
      "multi-process": "st-rect",
      "st-rect": "st-rect",
      processes: "st-rect",
      procs: "st-rect",
      "stacked-rectangle": "st-rect",
      flag: "flag",
      "paper-tape": "flag",
      "bow-rect": "bow-rect",
      "bow-tie-rectangle": "bow-rect",
      "stored-data": "bow-rect",
      "sm-circ": "sm-circ",
      "small-circle": "sm-circ",
      start: "sm-circ",
      "fr-circ": "fr-circ",
      "framed-circle": "fr-circ",
      stop: "fr-circ",
      "cross-circ": "cross-circ",
      "crossed-circle": "cross-circ",
      summary: "cross-circ",
      "tag-doc": "tag-doc",
      "tagged-document": "tag-doc",
      "tag-rect": "tag-rect",
      "tag-proc": "tag-rect",
      "tagged-process": "tag-rect",
      "tagged-rectangle": "tag-rect",
      odd: "odd",
      text: "text",
      icon: "icon",
      image: "image",
    }
    const shape = shapeAliases[shapeName ?? ""]! ?? (values.has("img") ? "image" : values.has("icon") ? "icon" : "rect")
    const label = values.get("label") || values.get("text") || (shape === "image" ? "image" : id)
    return { id, label, shape }
  }

  const shape = flowchartShapeForExpression(rest)
  const delimiters: Array<[string, string]> = [
    ["(((", ")))"] ,
    ["((", "))"],
    ["([", "])"],
    ["{{", "}}"],
    ["[(", ")]"],
    ["[[", "]]"],
    ["[/\\", "\\/]"],
    ["[/", "/]"],
    ["[\\", "\\]"],
    ["[>", "]"],
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ]
  const delimiter = delimiters.find(([opening, closing]) => rest.startsWith(opening) && rest.endsWith(closing))
  if (!delimiter) return { id, label: id, shape: "rect" }
  return { id, label: cleanMermaidLabel(rest.slice(delimiter[0]!.length, rest.length - delimiter[1]!.length)) || id, shape }
}

export type FlowchartOperator = {
  start: number
  end: number
  label?: string | undefined
}

export function flowchartOperators(input: string): FlowchartOperator[] {
  const mask = topLevelMask(input)
  const operators: FlowchartOperator[] = []
  const occupied: Array<[number, number]> = []
  const labeled = /(?:--|-\.|==)\s+(.+?)\s+(\.-+[>xo]|\.-+|-{2,}>|--[xo]|=+>|={2,}|-{3,})/g

  for (const match of mask.matchAll(labeled)) {
    const start = match.index ?? 0
    const end = start + match[0]!.length
    operators.push({ start, end, label: cleanMermaidLabel(input.slice(start + (match[0]!.indexOf(match[1]! ?? "") || 0), start + (match[0]!.indexOf(match[1]! ?? "") || 0) + (match[1]!?.length ?? 0))) || undefined })
    occupied.push([start, end])
  }

  const direct = /[xo][-=.]+[xo]|<[-=.]+>|-+\.-+>|=+>|-+!?[>xo]|-+\.-+|={3,}|-{3,}|[—–-]*→/g
  for (const match of mask.matchAll(direct)) {
    const start = match.index ?? 0
    if (occupied.some(([low, high]) => start >= low && start < high)) continue
    let end = start + match[0]!.length
    let label: string | undefined
    if (input[end]! === "|") {
      const close = input.indexOf("|", end + 1)
      if (close >= 0) {
        label = cleanMermaidLabel(input.slice(end + 1, close)) || undefined
        end = close + 1
      }
    }
    operators.push({ start, end, label })
    occupied.push([start, end])
  }

  return operators.sort((left, right) => left.start - right.start)
}

export function parseFlowchartEdgeLine(
  line: string,
  labels: Map<string, string>,
  shapes?: Map<string, FlowchartNodeShape> | undefined,
  nodes?: Set<string> | undefined,
) {
  const edges: FlowchartEdge[] = []
  const operators = flowchartOperators(line)
  if (operators.length === 0) {
    if (!/^subgraph\b|^end$/i.test(line.trim())) {
      const node = parseFlowchartNodeExpression(line)
      if (node) {
        labels.set(node.id, node.label)
        shapes?.set(node.id, node.shape)
        nodes?.add(node.id)
      }
    }
    return edges
  }

  const segments: string[] = []
  let cursor = 0
  for (const operator of operators) {
    segments.push(line.slice(cursor, operator.start))
    cursor = operator.end
  }
  segments.push(line.slice(cursor))
  const groups = segments.map((segment) =>
    splitMermaidTopLevel(segment, "&")
      .map((item) => parseFlowchartNodeExpression(item))
      .filter((item): item is { id: string; label: string; shape: FlowchartNodeShape } => Boolean(item)),
  )

  for (const group of groups) {
    for (const node of group) {
      if (node.label !== node.id || !labels.has(node.id)) labels.set(node.id, node.label)
      if (node.shape !== "rect" || !shapes?.has(node.id)) shapes?.set(node.id, node.shape)
      nodes?.add(node.id)
    }
  }

  for (let index = 0; index < operators.length; index++) {
    const operator = operators[index]!
    const sources = groups[index]! ?? []
    const targets = groups[index + 1]! ?? []
    for (const source of sources) {
      for (const target of targets) {
        edges.push({ from: source.id, to: target.id, label: operator.label })
      }
    }
  }
  return edges
}

export function padVisual(input: string, width: number) {
  return input + " ".repeat(Math.max(0, width - Bun.stringWidth(input)))
}

export function centerVisual(input: string, width: number) {
  const inputWidth = Bun.stringWidth(input)
  if (inputWidth >= width) return input
  const left = Math.floor((width - inputWidth) / 2)
  return `${" ".repeat(left)}${input}${" ".repeat(width - inputWidth - left)}`
}

/** Spans the whole gap so the connector touches both boxes; end markers (◇ ◁ ▶ …) stay at their end. */
function stretchConnector(connector: string, width: number) {
  const chars = [...connector]
  const isLine = (char: string) => char === "─" || char === "╌"
  const fill = chars.find(isLine) ?? "─"
  const lead = chars[0] !== undefined && !isLine(chars[0]) ? chars[0] : ""
  const trail = chars.length > 1 && !isLine(chars.at(-1)!) ? chars.at(-1)! : ""
  const body = Math.max(0, width - Bun.stringWidth(lead) - Bun.stringWidth(trail))
  return `${lead}${fill.repeat(body)}${trail}`
}

export function renderConnectedDiagramBoxes(input: {
  left: string[]
  right: string[]
  connector: string
  label?: string | undefined
}) {
  const leftWidth = Math.max(...input.left.map((line) => Bun.stringWidth(line)), 1)
  const rightWidth = Math.max(...input.right.map((line) => Bun.stringWidth(line)), 1)
  const label = cleanConnectorLabel(input.label)
  const gapWidth = Math.max(12, Bun.stringWidth(input.connector) + 2, Bun.stringWidth(label) + 2)
  const height = Math.max(input.left.length, input.right.length, 3)
  const rows: string[] = []

  for (let row = 0; row < height; row++) {
    const left = padVisual(input.left[row]! ?? " ".repeat(leftWidth), leftWidth)
    const right = padVisual(input.right[row]! ?? " ".repeat(rightWidth), rightWidth)
    const middle = row === 0 ? centerVisual(label, gapWidth) : row === 1 ? stretchConnector(input.connector, gapWidth) : " ".repeat(gapWidth)
    rows.push(`${left}${middle}${right}`.trimEnd())
  }

  return rows
}

export function flowchartShapeMarker(shape: FlowchartNodeShape | undefined) {
  if (!shape || shape === "rect" || shape === "round" || shape === "stadium") return ""
  const markers: Record<string, string> = {
    diamond: "◇",
    diam: "◇",
    decision: "◇",
    circle: "◯",
    "double-circle": "◎",
    "dbl-circ": "◎",
    "fr-circ": "◉",
    "sm-circ": "·",
    "f-circ": "●",
    cylinder: "▱",
    cyl: "▱",
    datastore: "▤",
    "h-cyl": "▱",
    "lin-cyl": "▤",
    hexagon: "⬡",
    hex: "⬡",
    subroutine: "▣",
    "fr-rect": "▣",
    "framed-rectangle": "▣",
    parallelogram: "▱",
    trapezoid: "⏢",
    "trap-b": "⏢",
    "trap-t": "⏢",
    "curv-trap": "⌒",
    "lean-r": "▰",
    "lean-l": "◀",
    "sl-rect": "▱",
    "lin-rect": "▤",
    "div-rect": "▥",
    "st-rect": "▦",
    "tag-rect": "▣",
    "notch-rect": "▰",
    "bow-rect": "◈",
    "win-pane": "▥",
    "docs": "▤",
    "lin-doc": "▤",
    "tag-doc": "▤",
    doc: "▤",
    "notch-pent": "⬟",
    "flip-tri": "◢",
    tri: "△",
    flag: "⚑",
    bolt: "ϟ",
    brace: "{",
    "brace-r": "}",
    braces: "{}",
    odd: "◇",
    delay: "◒",
    fork: "▰",
    hourglass: "⌛",
    "cross-circ": "⊗",
    cloud: "☁",
    bang: "‼",
    text: "▤",
    icon: "◆",
    image: "▧",
  }
  return markers[shape]! ?? "◇"
}

export function renderFlowchartBox(label: string, shape: FlowchartNodeShape | undefined) {
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "step"
  const marker = flowchartShapeMarker(shape)
  return renderBox(marker ? `${marker} ${text}` : text)
}

/** Grid positions are terminal cells, including continuation cells for CJK and emoji. */
export function writeVisual(target: string[], start: number, input: string) {
  let at = start
  for (const cell of cells(input)) {
    if (at >= target.length) break
    if (at >= 0 && at + cell.width <= target.length) {
      target[at] = cell.text
      for (let next = 1; next < cell.width; next++) target[at + next] = ""
    }
    at += cell.width
  }
}

export function blankRow(width: number) {
  if (!Number.isSafeInteger(width) || width > 1600 || width < 0) throw new Error(MERMAID_NOTES.tooComplex)
  return Array.from({ length: width }, () => " ")
}

export type MermaidIndentedEntry = {
  depth: number
  label: string
  description?: string | undefined
  raw: string
}

export function preparedMermaidSourceLines(input: string) {
  const lines: string[] = []
  let inFrontmatter = false
  let inDirective = false
  for (const raw of input.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (lines.length === 0 && !inFrontmatter && trimmed === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (trimmed === "---") inFrontmatter = false
      continue
    }
    if (inDirective) {
      if (trimmed.includes("}%%")) inDirective = false
      continue
    }
    if (trimmed.startsWith("%%{")) {
      if (!trimmed.includes("}%%")) inDirective = true
      continue
    }
    if (trimmed.startsWith("%%")) continue
    const content = uncomment(raw.replace(/\r$/, ""))
    if (content.trim()) lines.push(content)
  }
  return lines
}

export function mermaidIndentWidth(input: string) {
  return input.replace(/\t/g, "  ").match(/^\s*/)?.[0]!.length ?? 0
}

export function mermaidIndentedLabel(input: string) {
  const source = input
    .replace(/\s+:::[A-Za-z_][\w-]*/g, "")
    .replace(/\s+@\{[^}]*\}\s*$/g, "")
    .replace(/::icon\([^)]*\)/gi, "")
    .trim()
  const description = /\s+##\s+(.+)$/.exec(source)?.[1]!
  const withoutDescription = source.replace(/\s+##\s+.+$/, "").trim()
  const node = parseFlowchartNodeExpression(withoutDescription)
  const label =
    node && /[()[\]{}]/.test(withoutDescription.slice(node.id.length))
      ? node.label
      : cleanMermaidLabel(withoutDescription) || withoutDescription
  return { label: label || "item", description: description ? cleanMermaidLabel(description) : undefined }
}

export function parseMermaidIndentedEntries(input: string, head: RegExp): MermaidIndentedEntry[] | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!head.test(lines[0]!?.trim() ?? "")) return undefined
  const body = lines.slice(1)
  if (body.length === 0) return undefined

  const baseIndent = Math.min(...body.map(mermaidIndentWidth))
  const entries: MermaidIndentedEntry[] = []
  const indents: number[] = []
  for (const raw of body) {
    const expanded = raw.replace(/\t/g, "  ")
    const trimmed = expanded.trim()
    if (!trimmed || /^(?:title|accTitle|accDescr|config|classDef|style|click|linkStyle)\b/i.test(trimmed)) continue
    const boxDrawing = /^(.*?)(?:├──|└──|┣━━|┗━━)\s*(.+)$/.exec(expanded)
    const indent = Math.max(0, mermaidIndentWidth(expanded) - baseIndent)
    while (indents.length && indents.at(-1)! > indent) indents.pop()
    if (indents.at(-1) !== indent) indents.push(indent)
    const depth = boxDrawing
      ? Math.max(0, Math.floor((boxDrawing[1]?.replace(/[│┃]/g, "  ").length ?? 0) / 4) + 1)
      : indents.length - 1
    if (depth > 16) return undefined
    const parsed = mermaidIndentedLabel(boxDrawing?.[2]! ?? trimmed)
    entries.push({ depth, label: parsed.label, description: parsed.description, raw: trimmed })
  }
  return entries.length > 0 ? entries : undefined
}

export function renderBoxedHierarchy(title: string, entries: MermaidIndentedEntry[], width = 1600) {
  const visible = entries.slice(0)
  const boxes = visible.map((entry) => renderCompactBox(entry.description ? `${entry.label} · ${entry.description}` : entry.label, 12))
  const nodeWidth = Math.max(...boxes.flatMap((box) => box.map((line) => Bun.stringWidth(line))), 12)
  const columnStride = nodeWidth + 10
  const rowStride = 4
  const maxDepth = Math.max(...visible.map((entry) => entry.depth), 0)
  const canvasWidth = (maxDepth + 1) * columnStride - 10
  const rowCount = visible.length * rowStride - 1
  assertCanvas(canvasWidth, rowCount)
  if (canvasWidth > width) {
    const output = [title]
    for (const entry of visible) {
      const prefix = entry.depth ? "│  ".repeat(entry.depth - 1) + "├──" : ""
      const room = Math.min(48, width - Bun.stringWidth(prefix) - 4)
      if (room < 4) throw new Error(MERMAID_NOTES.tooWide)
      const label = entry.description ? `${entry.label} · ${entry.description}` : entry.label
      const body = wrap(label, room)
      output.push(prefix + "┌" + "─".repeat(room + 2) + "┐")
      for (const row of body) output.push("│  ".repeat(entry.depth) + "│ " + padVisual(row, room) + " │")
      output.push("│  ".repeat(entry.depth) + "└" + "─".repeat(room + 2) + "┘")
    }
    return output.join("\n")
  }
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectors = Array.from({ length: rowCount }, () => Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()))
  const boxCells = new Set<number>()
  const overlays = new Map<number, string>()
  const positions: Array<{ left: number; right: number; center: number; parent?: number | undefined }> = []
  const lastAtDepth = new Map<number, number>()

  visible.forEach((entry, index) => {
    const box = boxes[index]! ?? renderBox(entry.label)
    const boxWidth = Math.max(...box.map((line) => Bun.stringWidth(line)))
    const left = entry.depth * columnStride + Math.floor((nodeWidth - boxWidth) / 2)
    const top = index * rowStride
    box.forEach((line, offset) => {
      writeVisual(rows[top + offset]!, left, line)
      for (let column = 0; column < boxWidth; column++) boxCells.add((top + offset) * canvasWidth + left + column)
    })
    const parent = entry.depth > 0 ? lastAtDepth.get(entry.depth - 1) : undefined
    positions.push({ left, right: left + boxWidth - 1, center: top + 1, parent })
    lastAtDepth.set(entry.depth, index)
    for (const depth of [...lastAtDepth.keys()]) if (depth > entry.depth) lastAtDepth.delete(depth)
  })

  positions.forEach((position) => {
    if (position.parent === undefined) return
    const parent = positions[position.parent]!
    if (!parent) return
    const source = parent.right + 1
    const target = position.left - 1
    const elbow = Math.floor((source + target) / 2)
    drawHorizontalConnector(connectors, parent.center, source, elbow)
    drawVerticalConnector(connectors, elbow, parent.center, position.center)
    drawHorizontalConnector(connectors, position.center, elbow, target)
    putOverlay(overlays, canvasWidth, position.center, target, "▶")
  })
  const rendered = rows.map((row, rowIndex) => row.map((character, column) => {
    const cell = rowIndex * canvasWidth + column
    if (boxCells.has(cell)) return character
    const overlay = overlays.get(cell)
    if (overlay) return overlay
    const directions = connectors[rowIndex]!?.[column]!
    return character === " " && directions?.size ? connectorGlyph(directions) : character
  }).join("").trimEnd())
  return [title, ...rendered].join("\n")
}

/** Put a chart annotation only in free cells; nearby crowded points cannot erase earlier labels. */
export function placeLabel(rows: string[][], x: number, y: number, label: string) {
  const length = textWidth(label)
  const width = rows[0]?.length ?? 0
  if (length >= width - 2) throw new Error(MERMAID_NOTES.tooWide)
  for (let distance = 0; distance < rows.length; distance++) {
    for (const row of new Set([y - distance, y + distance])) {
      if (row < 1 || row >= rows.length - 1) continue
      const center = Math.max(1, Math.min(width - length - 1, x))
      for (let offset = 0; offset < width; offset++) {
        for (const column of new Set([center + offset, center - offset])) {
          if (column < 1 || column + length >= width) continue
          if (!rows[row]!.slice(column - 1, column + length + 1).every((cell) => cell === " ")) continue
          writeVisual(rows[row]!, column, label)
          return
        }
      }
    }
  }
  throw new Error(MERMAID_NOTES.tooComplex)
}
