// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { parseMermaidIndentedEntries, renderBoxedHierarchy } from "./legacy-shared"

export function renderMindmapDiagram(input: string, width: number): string | undefined {
  const entries = parseMermaidIndentedEntries(input, /^mindmap$/i)
  if (!entries) return undefined
  return renderBoxedHierarchy("Mindmap", entries, width)
}
