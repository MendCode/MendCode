export type AsciiGraphMarker = "braille" | "ascii"
export type AsciiGraphLabelMode = "none" | "selected" | "neighbors" | "all"
export type AsciiGraphCellKind = "empty" | "edge" | "conflict" | "node" | "selected" | "label"

export type AsciiGraphNode = {
  id: string
  label?: string
  group?: string
  layoutGroup?: string
  weight?: number
}

export type AsciiGraphEdge = {
  from: string
  to: string
  kind?: string
}

export type AsciiGraphViewport = {
  x?: number
  y?: number
  zoom?: number
}

export type AsciiGraphPoint = {
  x: number
  y: number
}

export type AsciiGraphLayoutNode = AsciiGraphNode & AsciiGraphPoint & {
  degree: number
}

export type AsciiGraphScene = {
  nodes: AsciiGraphLayoutNode[]
  edges: AsciiGraphEdge[]
  bounds: {
    minX: number
    maxX: number
    minY: number
    maxY: number
  }
  totalNodes: number
  hiddenNodes: number
}

export type AsciiGraphCell = {
  char: string
  kind: AsciiGraphCellKind
  group?: string
  nodeID?: string
  relation?: string
}

export type AsciiGraphRun = Omit<AsciiGraphCell, "char"> & {
  text: string
}

export type AsciiGraphFrame = {
  rows: string[]
  cells: AsciiGraphCell[][]
  nodeCells: Record<string, { x: number; y: number }>
  selectedID?: string
  marker: AsciiGraphMarker
  transform: {
    centerX: number
    centerY: number
    scale: number
    scaleX: number
    scaleY: number
    pixelWidth: number
    pixelHeight: number
    dotsX: number
    dotsY: number
  }
}

export type LayoutAsciiGraphInput = {
  nodes: AsciiGraphNode[]
  edges: AsciiGraphEdge[]
  maxNodes?: number
  selectedID?: string
  iterations?: number
  centerGroups?: string[]
}

export type RenderAsciiGraphInput = {
  width: number
  height: number
  marker?: AsciiGraphMarker
  viewport?: AsciiGraphViewport
  selectedID?: string
  labelMode?: AsciiGraphLabelMode
  labelMaxLength?: number
}

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

const CELL_PRIORITY: Record<AsciiGraphCellKind, number> = {
  empty: 0,
  edge: 1,
  label: 2,
  conflict: 3,
  node: 4,
  selected: 5,
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

function graphBounds(nodes: AsciiGraphLayoutNode[]) {
  if (!nodes.length) return { minX: -50, maxX: 50, minY: -30, maxY: 30 }
  if (nodes.length === 1) {
    const node = nodes[0]!
    return { minX: node.x - 20, maxX: node.x + 20, minY: node.y - 12, maxY: node.y + 12 }
  }
  const minX = Math.min(...nodes.map((node) => node.x))
  const maxX = Math.max(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxY = Math.max(...nodes.map((node) => node.y))
  const paddingX = Math.max(8, (maxX - minX) * 0.12)
  const paddingY = Math.max(6, (maxY - minY) * 0.12)
  return {
    minX: minX - paddingX,
    maxX: maxX + paddingX,
    minY: minY - paddingY,
    maxY: maxY + paddingY,
  }
}

export function layoutAsciiGraph(input: LayoutAsciiGraphInput): AsciiGraphScene {
  const uniqueNodes = Array.from(new Map(input.nodes.map((node) => [node.id, node])).values())
  const knownIDs = new Set(uniqueNodes.map((node) => node.id))
  const validEdges = input.edges.filter((edge) => edge.from !== edge.to && knownIDs.has(edge.from) && knownIDs.has(edge.to))
  const degrees = new Map<string, number>()
  for (const edge of validEdges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1)
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
  }
  const maxNodes = Math.max(1, Math.floor((input.maxNodes ?? uniqueNodes.length) || 1))
  const selected = input.selectedID ? uniqueNodes.find((node) => node.id === input.selectedID) : undefined
  const ranked = [...uniqueNodes].sort((a, b) =>
    (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0) ||
    (b.weight ?? 0) - (a.weight ?? 0) ||
    a.id.localeCompare(b.id),
  )
  const visible = ranked.slice(0, maxNodes)
  if (selected && !visible.some((node) => node.id === selected.id)) visible[visible.length - 1] = selected
  const visibleIDs = new Set(visible.map((node) => node.id))
  const edges = validEdges.filter((edge) => visibleIDs.has(edge.from) && visibleIDs.has(edge.to))
  const groupIDs = Array.from(new Set(visible.map((node) => node.layoutGroup ?? node.group ?? ""))).sort()
  const centeredGroups = new Set(input.centerGroups ?? [])
  const outerGroups = groupIDs.filter((group) => !centeredGroups.has(group))
  const groupCenters = new Map([
    ...groupIDs.filter((group) => centeredGroups.has(group)).map((group) => [group, { x: 0, y: 0 }] as const),
    ...outerGroups.map((group, index) => {
      const angle = outerGroups.length === 1 ? 0 : (index / outerGroups.length) * Math.PI * 2 - Math.PI / 2
      return [group, { x: Math.cos(angle) * 46, y: Math.sin(angle) * 30 }] as const
    }),
  ])
  const nodes = visible.map((node, index): AsciiGraphLayoutNode => {
    const seed = hash(node.id)
    const base = groupCenters.get(node.layoutGroup ?? node.group ?? "") ?? { x: 0, y: 0 }
    const angle = ((seed % 10_000) / 10_000) * Math.PI * 2
    const radius = visible.length === 1 ? 0 : 14 + ((seed >>> 12) % 24)
    return {
      ...node,
      degree: degrees.get(node.id) ?? 0,
      x: base.x + Math.cos(angle) * radius + (index % 3) * 0.01,
      y: base.y + Math.sin(angle) * radius,
    }
  })
  const nodeByID = new Map(nodes.map((node) => [node.id, node]))
  const iterations = Math.max(0, Math.min(320, Math.floor(input.iterations ?? 140)))
  const ideal = Math.max(16, Math.min(42, Math.sqrt(24_000 / Math.max(1, nodes.length))))

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const displacement = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]))
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex]!
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex]!
        const rawX = left.x - right.x
        const rawY = left.y - right.y
        const distance = Math.max(0.35, Math.hypot(rawX, rawY))
        const force = (ideal * ideal) / distance
        const x = (rawX / distance) * force
        const y = (rawY / distance) * force
        displacement.get(left.id)!.x += x
        displacement.get(left.id)!.y += y
        displacement.get(right.id)!.x -= x
        displacement.get(right.id)!.y -= y
      }
    }
    for (const edge of edges) {
      const from = nodeByID.get(edge.from)
      const to = nodeByID.get(edge.to)
      if (!from || !to) continue
      const rawX = from.x - to.x
      const rawY = from.y - to.y
      const distance = Math.max(0.35, Math.hypot(rawX, rawY))
      const relationStrength = edge.kind === "supports" || edge.kind === "supersedes" ? 1.12 : edge.kind === "conflicts" ? 0.82 : 1
      const force = ((distance * distance) / ideal) * relationStrength
      const x = (rawX / distance) * force
      const y = (rawY / distance) * force
      displacement.get(from.id)!.x -= x
      displacement.get(from.id)!.y -= y
      displacement.get(to.id)!.x += x
      displacement.get(to.id)!.y += y
    }
    const temperature = 10 * (1 - iteration / Math.max(1, iterations)) + 0.15
    for (const node of nodes) {
      const shift = displacement.get(node.id)!
      const groupCenter = groupCenters.get(node.layoutGroup ?? node.group ?? "") ?? { x: 0, y: 0 }
      shift.x += (groupCenter.x - node.x) * 0.18 - node.x * 0.025
      shift.y += (groupCenter.y - node.y) * 0.18 - node.y * 0.025
      const distance = Math.max(0.01, Math.hypot(shift.x, shift.y))
      node.x += (shift.x / distance) * Math.min(distance, temperature)
      node.y += (shift.y / distance) * Math.min(distance, temperature)
    }
  }

  return {
    nodes,
    edges,
    bounds: graphBounds(nodes),
    totalNodes: uniqueNodes.length,
    hiddenNodes: Math.max(0, uniqueNodes.length - nodes.length),
  }
}

function linePoints(from: AsciiGraphPoint, to: AsciiGraphPoint) {
  const points: AsciiGraphPoint[] = []
  const dx = Math.abs(Math.round(to.x) - Math.round(from.x))
  const dy = -Math.abs(Math.round(to.y) - Math.round(from.y))
  const sx = from.x < to.x ? 1 : -1
  const sy = from.y < to.y ? 1 : -1
  let error = dx + dy
  let x = Math.round(from.x)
  let y = Math.round(from.y)
  while (true) {
    points.push({ x, y })
    if (x === Math.round(to.x) && y === Math.round(to.y)) return points
    const doubled = 2 * error
    if (doubled >= dy) {
      error += dy
      x += sx
    }
    if (doubled <= dx) {
      error += dx
      y += sy
    }
  }
}

function edgeVisible(kind: string | undefined, index: number) {
  if (kind === "related") return index % 3 !== 1
  if (kind === "conflicts") return index % 5 < 3
  return true
}

function asciiEdgeChar(from: AsciiGraphPoint, to: AsciiGraphPoint, kind: string | undefined) {
  if (kind === "related") return "."
  if (kind === "conflicts") return "x"
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  if (dx > dy * 2) return "-"
  if (dy > dx * 2) return "|"
  return (to.x - from.x) * (to.y - from.y) > 0 ? "\\" : "/"
}

function mergeCell(current: AsciiGraphCell | undefined, next: Omit<AsciiGraphCell, "char">, char: string) {
  if (!current || CELL_PRIORITY[next.kind] >= CELL_PRIORITY[current.kind]) return { ...next, char }
  return current
}

function labelIDs(scene: AsciiGraphScene, selectedID: string | undefined, mode: AsciiGraphLabelMode) {
  if (mode === "none") return new Set<string>()
  if (mode === "all") return new Set(scene.nodes.map((node) => node.id))
  if (!selectedID) return new Set<string>()
  if (mode === "selected") return new Set([selectedID])
  return new Set([
    selectedID,
    ...scene.edges.flatMap((edge) => edge.from === selectedID ? [edge.to] : edge.to === selectedID ? [edge.from] : []),
  ])
}

export function renderAsciiGraph(scene: AsciiGraphScene, input: RenderAsciiGraphInput): AsciiGraphFrame {
  const width = Math.max(8, Math.floor(input.width))
  const height = Math.max(3, Math.floor(input.height))
  const marker = input.marker ?? "braille"
  const dotsX = marker === "braille" ? 2 : 1
  const dotsY = marker === "braille" ? 4 : 1
  const pixelWidth = width * dotsX
  const pixelHeight = height * dotsY
  const graphCenterX = (scene.bounds.minX + scene.bounds.maxX) / 2
  const graphCenterY = (scene.bounds.minY + scene.bounds.maxY) / 2
  const centerX = input.viewport?.x ?? graphCenterX
  const centerY = input.viewport?.y ?? graphCenterY
  const zoom = Math.max(0.1, Math.min(20, input.viewport?.zoom ?? 1))
  const graphWidth = Math.max(1, scene.bounds.maxX - scene.bounds.minX)
  const graphHeight = Math.max(1, scene.bounds.maxY - scene.bounds.minY)
  const fitX = (pixelWidth - dotsX * 4) / graphWidth
  const fitY = (pixelHeight - dotsY * 2) / graphHeight
  const scale = Math.max(0.01, Math.min(fitX, fitY) * zoom)
  const scaleX = Math.max(0.01, Math.min(fitX, Math.min(fitX, fitY) * 2.25) * zoom)
  const scaleY = Math.max(0.01, Math.min(fitY, Math.min(fitX, fitY) * 1.15) * zoom)
  const screen = (point: AsciiGraphPoint) => ({
    x: Math.round((point.x - centerX) * scaleX + pixelWidth / 2),
    y: Math.round((point.y - centerY) * scaleY + pixelHeight / 2),
  })
  const masks = new Uint8Array(width * height)
  const cells = Array.from({ length: height }, () => Array.from<AsciiGraphCell | undefined>({ length: width }).fill(undefined))
  const overlays = new Map<number, string>()
  const plot = (x: number, y: number, cell: Omit<AsciiGraphCell, "char">, char = "") => {
    if (x < 0 || y < 0 || x >= pixelWidth || y >= pixelHeight) return
    const cellX = Math.floor(x / dotsX)
    const cellY = Math.floor(y / dotsY)
    const index = cellY * width + cellX
    if (marker === "braille") masks[index] = masks[index]! | BRAILLE_BITS[y % 4]![x % 2]!
    if (char) overlays.set(index, char)
    cells[cellY]![cellX] = mergeCell(cells[cellY]![cellX], cell, char)
  }
  const nodeByID = new Map(scene.nodes.map((node) => [node.id, node]))
  const nodeCells: Record<string, { x: number; y: number }> = {}

  for (const edge of scene.edges) {
    const fromNode = nodeByID.get(edge.from)
    const toNode = nodeByID.get(edge.to)
    if (!fromNode || !toNode) continue
    const from = screen(fromNode)
    const to = screen(toNode)
    const kind = edge.kind === "conflicts" ? "conflict" : "edge"
    const char = marker === "ascii" ? asciiEdgeChar(from, to, edge.kind) : ""
    for (const [index, point] of linePoints(from, to).entries()) {
      if (!edgeVisible(edge.kind, index)) continue
      plot(point.x, point.y, { kind, relation: edge.kind }, char)
    }
    if (edge.kind === "supersedes") {
      const point = linePoints(from, to)[Math.max(0, Math.floor(linePoints(from, to).length * 0.7))]
      if (point) plot(point.x, point.y, { kind: "edge", relation: edge.kind }, ">")
    }
  }

  for (const node of scene.nodes) {
    const point = screen(node)
    nodeCells[node.id] = { x: Math.floor(point.x / dotsX), y: Math.floor(point.y / dotsY) }
    const selected = node.id === input.selectedID
    if (marker === "ascii") {
      plot(point.x, point.y, {
        kind: selected ? "selected" : "node",
        group: node.group,
        nodeID: node.id,
      }, selected ? "@" : node.degree > 3 ? "O" : "o")
      continue
    }
    plot(point.x, point.y, {
      kind: selected ? "selected" : "node",
      group: node.group,
      nodeID: node.id,
    }, selected ? "◉" : node.degree > 0 ? "●" : "•")
  }

  const labels = labelIDs(scene, input.selectedID, input.labelMode ?? "selected")
  for (const node of scene.nodes.filter((item) => labels.has(item.id)).sort((a, b) => Number(b.id === input.selectedID) - Number(a.id === input.selectedID))) {
    const point = nodeCells[node.id]
    if (!point) continue
    const label = (node.label || node.id).replace(/\s+/g, " ").trim().slice(0, Math.max(4, input.labelMaxLength ?? 24))
    const starts = [point.x + 2, point.x - label.length - 2]
    const startX = starts.find((candidate) =>
      point.y >= 0 &&
      point.y < height &&
      candidate >= 0 &&
      candidate + label.length <= width &&
      Array.from({ length: label.length }, (_, index) => cells[point.y]?.[candidate + index]?.kind)
        .every((kind) => kind !== "node" && kind !== "selected" && kind !== "label"),
    )
    if (startX === undefined) continue
    for (let index = 0; index < label.length && startX + index < width; index += 1) {
      const x = startX + index
      const cellIndex = point.y * width + x
      overlays.set(cellIndex, label[index]!)
      cells[point.y]![x] = {
        char: label[index]!,
        kind: "label",
        group: node.group,
        nodeID: node.id,
      }
      masks[cellIndex] = 0
    }
  }

  const finalized = cells.map((row, y) => row.map((cell, x): AsciiGraphCell => {
    const index = y * width + x
    const char = overlays.get(index) ?? (marker === "braille" && masks[index] ? String.fromCodePoint(0x2800 + masks[index]!) : cell?.char || " ")
    return cell ? { ...cell, char } : { char, kind: "empty" }
  }))
  return {
    rows: finalized.map((row) => row.map((cell) => cell.char).join("").replace(/\s+$/, "")),
    cells: finalized,
    nodeCells,
    selectedID: input.selectedID,
    marker,
    transform: { centerX, centerY, scale, scaleX, scaleY, pixelWidth, pixelHeight, dotsX, dotsY },
  }
}

export function asciiGraphRuns(cells: AsciiGraphCell[]) {
  return cells.reduce<AsciiGraphRun[]>((runs, cell) => {
    const previous = runs.at(-1)
    if (previous && previous.kind === cell.kind && previous.group === cell.group && previous.nodeID === cell.nodeID && previous.relation === cell.relation) {
      previous.text += cell.char
      return runs
    }
    runs.push({ text: cell.char, kind: cell.kind, group: cell.group, nodeID: cell.nodeID, relation: cell.relation })
    return runs
  }, [])
}

export function asciiGraphCellToWorld(frame: AsciiGraphFrame, x: number, y: number) {
  return {
    x: ((x + 0.5) * frame.transform.dotsX - frame.transform.pixelWidth / 2) / frame.transform.scaleX + frame.transform.centerX,
    y: ((y + 0.5) * frame.transform.dotsY - frame.transform.pixelHeight / 2) / frame.transform.scaleY + frame.transform.centerY,
  }
}

export function asciiGraphNearestNode(scene: AsciiGraphScene, selectedID: string | undefined, direction: AsciiGraphPoint) {
  const selected = scene.nodes.find((node) => node.id === selectedID) ?? scene.nodes[0]
  if (!selected) return undefined
  const length = Math.hypot(direction.x, direction.y)
  if (!length) return selected.id
  return scene.nodes
    .filter((node) => node.id !== selected.id)
    .map((node) => {
      const x = node.x - selected.x
      const y = node.y - selected.y
      const distance = Math.max(0.01, Math.hypot(x, y))
      const alignment = (x * direction.x + y * direction.y) / (distance * length)
      return { id: node.id, score: distance + (1 - alignment) * 120, alignment }
    })
    .filter((node) => node.alignment > 0.15)
    .sort((a, b) => a.score - b.score)[0]?.id ?? selected.id
}

export function asciiGraphWithNodePosition(scene: AsciiGraphScene, id: string, point: AsciiGraphPoint): AsciiGraphScene {
  const nodes = scene.nodes.map((node) => node.id === id ? { ...node, ...point } : node)
  return { ...scene, nodes, bounds: graphBounds(nodes) }
}
