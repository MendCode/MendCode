import { assertCanvas } from "./core"
import { wrap } from "../wrap"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { cleanLabel, blankRow, writeVisual, padVisual, drawHorizontalConnector, putOverlay, connectorGlyph } from "./legacy-shared"
import type { ConnectorDirection } from "./legacy-shared"

export function renderGitGraph(input: string, width = 1600): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (!/^gitGraph\b/i.test(lines[0]! ?? "")) return undefined

  type GitBranch = { name: string; start: number; last: number }
  type GitCommit = { branch: string; column: number; label: string; mergeFrom?: string | undefined; mergeStart?: number | undefined; merge?: boolean | undefined }
  const branches: GitBranch[] = [{ name: "main", start: 0, last: 0 }]
  const commits: GitCommit[] = []
  let currentBranch = "main"
  let timeline = 0
  const branchFor = (name: string) => branches.find((branch) => branch.name === name)
  for (const line of lines.slice(1)) {
    const commit = /^commit(?:\s+id:\s*"?([^"]+)"?)?/i.exec(line)
    if (commit) {
      timeline++
      const branch = branchFor(currentBranch)
      if (!branch) continue
      branch.last = timeline
      commits.push({ branch: currentBranch, column: timeline, label: cleanLabel(commit[1]!) || "commit" })
      continue
    }
    const branch = /^branch\s+(.+)$/i.exec(line)
    if (branch) {
      const name = cleanLabel(branch[1]!)
      const source = branchFor(currentBranch)
      if (name && !branchFor(name)) branches.push({ name, start: source?.last ?? timeline, last: source?.last ?? timeline })
      if (name) currentBranch = name
      continue
    }
    const checkout = /^(?:checkout|switch)\s+(.+)$/i.exec(line)
    if (checkout) {
      currentBranch = cleanLabel(checkout[1]!) || currentBranch
      if (!branchFor(currentBranch)) return undefined
      continue
    }
    const merge = /^merge\s+(.+)$/i.exec(line)
    if (merge) {
      const sourceName = cleanLabel(merge[1]!).split(/\s+/)[0]!
      const source = branchFor(sourceName)
      const target = branchFor(currentBranch)
      if (!target || !source || source === target) return undefined
      timeline++
      target.last = timeline
      commits.push({
        branch: currentBranch,
        column: timeline,
        label: `merge ${sourceName}`,
        mergeFrom: sourceName,
        mergeStart: source?.last,
        merge: true,
      })
    }
  }
  if (commits.length === 0) return undefined

  const labelWidth = Math.max(10, ...branches.map((branch) => Bun.stringWidth(branch.name) + 2))
  const stride = Math.max(10, ...commits.map((commit) => Bun.stringWidth(commit.label) + 4))
  const graphStart = labelWidth + 2
  const canvasWidth = graphStart + (timeline + 1) * stride
  if (canvasWidth > width) {
    const laneWidth = branches.length * 3
    if (width - laneWidth < 8) return undefined
    const output = ["Git graph", ...wrap(branches.map((branch, index) => `${index + 1}: ${branch.name}`).join(" · "), width)]
    for (const commit of commits) {
      const target = branches.findIndex((branch) => branch.name === commit.branch)
      const source = branches.findIndex((branch) => branch.name === commit.mergeFrom)
      const lanes = branches.map((_, index) => index === target ? commit.merge ? "◎  " : "●  " : index === source ? "╯  " : source >= 0 && index > Math.min(source, target) && index < Math.max(source, target) ? "┼──" : "│  ")
      wrap(commit.label, width - laneWidth).forEach((text, index) => output.push((index ? branches.map(() => "│  ") : lanes).join("") + text))
      output.push(branches.map(() => "│  ").join(""))
    }
    return output.join("\n")
  }
  const rowCount = branches.length * 4
  assertCanvas(canvasWidth, rowCount)
  const rows = Array.from({ length: rowCount }, () => blankRow(canvasWidth))
  const connectors = Array.from({ length: rowCount }, () =>
    Array.from({ length: canvasWidth }, () => new Set<ConnectorDirection>()),
  )
  const overlays = new Map<number, string>()
  const graphRow = (branchName: string) => branches.findIndex((branch) => branch.name === branchName) * 4 + 2
  const graphColumn = (column: number) => graphStart + column * stride

  for (const branch of branches) {
    const row = graphRow(branch.name)
    writeVisual(rows[row]!, 0, padVisual(branch.name, labelWidth))
    const branchStartColumn = graphColumn(branch.start)
    const visibleStart = branch.name === "main" ? branchStartColumn : Math.min(graphColumn(Math.max(branch.start, branch.last)), branchStartColumn + 3)
    drawHorizontalConnector(connectors, row, visibleStart, graphColumn(Math.max(branch.start, branch.last)))
    if (branch.name !== "main") {
      const parent = branches.find((candidate) => candidate !== branch && candidate.start <= branch.start && candidate.last >= branch.start) ?? branches[0]!
      const parentRow = graphRow(parent?.name ?? "main")
      const rowStep = row > parentRow ? 1 : -1
      for (let offset = 1; offset < Math.abs(row - parentRow); offset++) {
        putOverlay(overlays, canvasWidth, parentRow + offset * rowStep, Math.min(canvasWidth - 1, branchStartColumn + offset), rowStep > 0 ? "╲" : "╱")
      }
    }
  }

  for (const commit of commits) {
    const row = graphRow(commit.branch)
    const column = graphColumn(commit.column)
    putOverlay(overlays, canvasWidth, row, column, commit.merge ? "◎" : "●")
    const labelStart = Math.max(graphStart, Math.min(canvasWidth - Bun.stringWidth(commit.label), column - Math.floor(Bun.stringWidth(commit.label) / 2)))
    writeVisual(rows[row - 1]!, labelStart, commit.label)
    if (commit.mergeFrom && commit.mergeStart !== undefined) {
      const sourceRow = graphRow(commit.mergeFrom)
      const sourceColumn = graphColumn(commit.mergeStart)
      const rowDistance = Math.abs(sourceRow - row)
      const diagonalStart = Math.max(sourceColumn, column - rowDistance)
      drawHorizontalConnector(connectors, sourceRow, sourceColumn, diagonalStart)
      const rowStep = row > sourceRow ? 1 : -1
      for (let offset = 1; offset < rowDistance; offset++) {
        putOverlay(overlays, canvasWidth, sourceRow + offset * rowStep, diagonalStart + offset, rowStep > 0 ? "╲" : "╱")
      }
    }
  }

  const rendered = rows.map((row, rowIndex) => row.map((character, column) => {
    const overlay = overlays.get(rowIndex * canvasWidth + column)
    if (overlay) return overlay
    const directions = connectors[rowIndex]!?.[column]!
    return character === " " && directions?.size ? connectorGlyph(directions) : character
  }).join("").trimEnd())
  return ["Git graph", ...rendered].join("\n")
}
