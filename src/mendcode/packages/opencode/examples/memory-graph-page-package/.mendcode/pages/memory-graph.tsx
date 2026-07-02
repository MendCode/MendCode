/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@mendcode/plugin/tui"

const nodes = [
  { id: "policy", label: "Policy", x: 10, y: 2, glyph: "●" },
  { id: "project", label: "Project", x: 30, y: 1, glyph: "◆" },
  { id: "dream", label: "Dream", x: 48, y: 3, glyph: "■" },
  { id: "retrieval", label: "Retrieval", x: 18, y: 7, glyph: "▲" },
  { id: "global", label: "Global", x: 42, y: 8, glyph: "◇" },
]

const edges = [
  ["policy", "project"],
  ["project", "dream"],
  ["policy", "retrieval"],
  ["retrieval", "global"],
  ["dream", "global"],
]

function linePoints(from: { x: number; y: number }, to: { x: number; y: number }) {
  const points: Array<{ x: number; y: number }> = []
  const dx = Math.abs(to.x - from.x)
  const dy = -Math.abs(to.y - from.y)
  const sx = from.x < to.x ? 1 : -1
  const sy = from.y < to.y ? 1 : -1
  let error = dx + dy
  let x = from.x
  let y = from.y
  while (true) {
    points.push({ x, y })
    if (x === to.x && y === to.y) return points
    const doubleError = 2 * error
    if (doubleError >= dy) {
      error += dy
      x += sx
    }
    if (doubleError <= dx) {
      error += dx
      y += sy
    }
  }
}

function graphRows(width: number) {
  const canvasWidth = Math.max(28, Math.min(62, width - 4))
  const canvas = Array.from({ length: 10 }, () => Array.from({ length: canvasWidth }, () => " "))
  const nodeByID = new Map(nodes.map((node) => [node.id, node]))
  for (const [fromID, toID] of edges) {
    const from = nodeByID.get(fromID)
    const to = nodeByID.get(toID)
    if (!from || !to) continue
    for (const point of linePoints(from, to).slice(1, -1)) {
      if (point.y >= 0 && point.y < canvas.length && point.x >= 0 && point.x < canvasWidth && canvas[point.y]?.[point.x] === " ") canvas[point.y]![point.x] = "·"
    }
  }
  for (const node of nodes) {
    if (node.y >= 0 && node.y < canvas.length && node.x >= 0 && node.x < canvasWidth) canvas[node.y]![node.x] = node.glyph
  }
  return canvas.map((row) => row.join("").replace(/\s+$/, ""))
}

export default {
  id: "memory-graph-page-example.page",
  async tui(api: TuiPluginApi) {
    api.route.register([
      {
        name: "example-memory-graph",
        render() {
          const rows = graphRows(72)
          return (
            <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
              <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
                <text fg={api.theme.current.primary} wrapMode="none">Memory Graph Example</text>
                <text fg={api.theme.current.textMuted} wrapMode="none">q/esc via command palette back</text>
              </box>
              <box flexDirection="row" minHeight={0} flexGrow={1} gap={1}>
                <box flexDirection="column" flexGrow={1} minWidth={0} borderStyle="single" borderColor={api.theme.current.border} padding={1}>
                  <text fg={api.theme.current.textMuted} wrapMode="none">Terminal-native graph canvas</text>
                  {rows.map((row) => <text fg={api.theme.current.primary} wrapMode="none">{row || " "}</text>)}
                  <text fg={api.theme.current.textMuted} wrapMode="none">{nodes.length} nodes · {edges.length} links · static demo data</text>
                </box>
                <box flexDirection="column" width={32} borderStyle="single" borderColor={api.theme.current.border} padding={1} gap={1}>
                  <text fg={api.theme.current.textMuted} wrapMode="none">Legend</text>
                  {nodes.map((node) => <text fg={api.theme.current.text} wrapMode="none">{node.glyph} {node.label}</text>)}
                  <text fg={api.theme.current.textMuted} wrapMode="word">Use this shape as a starting point for package-owned custom pages.</text>
                </box>
              </box>
            </box>
          )
        },
      },
    ])

    api.command.register(() => [
      {
        title: "Example Memory Graph",
        value: "example.memory.graph",
        description: "Open the package-owned custom graph page.",
        category: "Examples",
        onSelect() {
          api.route.navigate("example-memory-graph")
        },
      },
    ])
  },
}
