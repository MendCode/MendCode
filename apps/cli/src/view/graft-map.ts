import type { RenderNode } from "@mendcode/protocol"
import { graftReportedSavings } from "@mendcode/protocol/wire"

/**
 * The text of graft's `graft_trace_calls` (an MCP tool, so its result has no render spec) read back into a
 * call map. Only the shape graft prints is accepted:
 *
 *   name · kind · path:L10-L20
 *     calls ← caller (path:L5-L9) [depth 2]
 *     calls → callee (path:L30-L40)
 *
 * graft's own `[graft] tokens saved ≈ N` line, when present, becomes the map's saved-tokens footer. Anything else
 * returns undefined and the card keeps showing the raw text.
 */

const GRAFT_TRACE_TOOL = /(^|__)graft_(trace_calls|callers)$/
const HEADER = /^(\S.*?) · (\w+) · (.+?):L(\d+)(?:-L\d+)?$/
const EDGE = /^\s+calls (←|→) (.+?) \((.+?):L(\d+)(?:-L\d+)?\)(?: \[depth (\d+)\])?\s*$/
const MAX_ENTRIES = 50
const LABEL_MAX = 120

type MapNode = Extract<RenderNode, { type: "codemap" }>
type Entry = MapNode["left"]["entries"][number]

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function isGraftTraceTool(name: string) {
  return GRAFT_TRACE_TOOL.test(name)
}

export function graftTraceMap(text: string): MapNode | undefined {
  const lines = text.replace(/\r/g, "").split("\n")
  const start = lines.findIndex((line) => HEADER.test(line))
  if (start < 0) return undefined
  const head = HEADER.exec(lines[start]!)!
  const callers: Entry[] = []
  const callees: Entry[] = []
  let more = { callers: 0, callees: 0 }
  for (const line of lines.slice(start + 1)) {
    // A second header is another match of an ambiguous name; the map is of the first.
    if (HEADER.test(line)) break
    const edge = EDGE.exec(line)
    if (!edge) continue
    const inbound = edge[1] === "←"
    const target = inbound ? callers : callees
    if (target.length >= MAX_ENTRIES) {
      more = inbound ? { ...more, callers: more.callers + 1 } : { ...more, callees: more.callees + 1 }
      continue
    }
    target.push({ label: clip(edge[2]!, LABEL_MAX), file: clip(edge[3]!, 240), line: Number(edge[4]), ...(edge[5] ? { depth: Math.min(9, Number(edge[5])) } : {}) })
  }
  const saved = graftReportedSavings(text)
  return {
    type: "codemap",
    ...(saved !== undefined ? { saved: Math.min(saved, 1_000_000_000) } : {}),
    center: { label: clip(head[1]!, LABEL_MAX), kind: head[2]!, file: clip(head[3]!, 240), line: Number(head[4]) },
    left: { title: "callers", entries: callers, more: more.callers, flow: "in" },
    right: { title: "callees", entries: callees, more: more.callees, flow: "out" },
  }
}

/** A call map for a graft trace tool's text, or undefined for any other tool or an unreadable result. */
export function graftTraceRender(tool: string, text: string): RenderNode | undefined {
  return isGraftTraceTool(tool) ? graftTraceMap(text) : undefined
}
