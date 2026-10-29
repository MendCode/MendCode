import { graphScene, sceneText } from "./graph-scene"
// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, cleanMermaidLabel } from "./legacy-shared"

type EventModelFrame = { id: string; type: string; entity: string; data?: string | undefined; dataRef?: string | undefined; reset: boolean }

export function renderEventModelingDiagram(input: string, width = 1600): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^eventmodeling$/i.test(lines[0]!?.trim() ?? "")) return undefined
  const frames: EventModelFrame[] = []
  const dataBlocks = new Map<string, string[]>()
  const explicitRelations: Array<{ from: string; to: string; connector: string }> = []
  let currentData: string | undefined
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const dataStart = /^data\s+([A-Za-z_][\w.-]*)\s*(?:`[^`]+`)?\s*\{?(.*)$/i.exec(line)
    if (dataStart) {
      currentData = dataStart[1]!
      const inlineData = dataStart[2]!?.replace(/^\s*\{/, "").replace(/}\s*$/, "").trim()
      dataBlocks.set(currentData, inlineData ? [cleanMermaidLabel(inlineData)] : [])
      if (line.endsWith("}")) currentData = undefined
      continue
    }
    if (currentData) {
      if (line === "}") {
        currentData = undefined
        continue
      }
      const values = dataBlocks.get(currentData) ?? []
      dataBlocks.set(currentData, [...values, cleanMermaidLabel(line.replace(/}\s*$/, ""))])
      if (line.endsWith("}")) currentData = undefined
      continue
    }
    const frame = /^(tf|timeframe|rf|resetframe)\s+(\S+)\s+(ui|pcr|processor|cmd|command|rmo|readmodel|evt|event)\s+(.+?)(?:\s+\{(.+)\})?$/i.exec(line)
    if (frame) {
      const dataRef = /\[\[([^\]]+)\]\]/.exec(frame[4]!)?.[1]!
      frames.push({
        id: frame[2]!,
        type: frame[3]!.toLowerCase(),
        entity: cleanMermaidLabel(frame[4]!.replace(/\[\[[^\]]+\]\]/, "")),
        data: cleanMermaidLabel(frame[5]!),
        dataRef,
        reset: /^rf|resetframe$/i.test(frame[1]!),
      })
      continue
    }
    const relaxed = /^(tf|timeframe|rf|resetframe)\s+(\S+)\s+(.+)$/i.exec(line)
    if (relaxed) {
      const dataRef = /\[\[([^\]]+)\]\]/.exec(relaxed[3]!)?.[1]!
      frames.push({ id: relaxed[2]!, type: "event", entity: cleanMermaidLabel(relaxed[3]!.replace(/\[\[[^\]]+\]\]/, "")), dataRef, reset: /^rf|resetframe$/i.test(relaxed[1]!) })
      continue
    }
    const relation = /^(\S+)\s*(->>|-->|->)\s*(\S+)$/i.exec(line)
    if (relation) explicitRelations.push({ from: relation[1]!, to: relation[3]!, connector: relation[2]! })
  }
  if (frames.length === 0) return undefined
  const laneForType = (type: string) => /^(?:ui|pcr|processor)$/i.test(type) ? "UI / Automation" : /^(?:cmd|command|rmo|readmodel)$/i.test(type) ? "Command / Read Model" : "Events"
  const nodes = frames.map((frame) => ({ id: frame.id, label: `${frame.id} · ${frame.entity}`, fields: [frame.data || (frame.dataRef ? dataBlocks.get(frame.dataRef)?.join(" ") : "") || ""].filter(Boolean), group: laneForType(frame.type) }))
  const edges = explicitRelations.length ? explicitRelations : frames.slice(1).map((frame, i) => ({ from: frames[i]!.id, to: frame.id }))
  const result = sceneText(graphScene(nodes, edges, width))
  return result ? "Event modeling\n" + result : undefined
}
