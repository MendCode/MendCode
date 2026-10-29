// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { parseMermaidIndentedEntries, renderBoxedHierarchy } from "./legacy-shared"

export function renderTreeViewDiagram(input: string): string | undefined {
  const entries = parseMermaidIndentedEntries(input, /^treeview-beta$/i)
  if (!entries) return undefined
  return renderBoxedHierarchy("TreeView", entries)
}
