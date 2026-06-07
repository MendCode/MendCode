import type { TimelineToolClass, TimelineToolEvent, TimelineToolState } from "./types"
import type { MendPresentationProfile } from "../presentation"

const artifactTools = new Set(["write", "edit", "apply_patch"])
const commandTools = new Set(["bash", "shell"])
const simpleReadTools = new Set(["read", "glob", "grep", "codesearch"])
const planningTools = new Set(["task", "todowrite", "skill"])
const interactionTools = new Set(["question", "permission"])
const webTools = new Set(["webfetch", "websearch"])

export function toolClass(tool: string, state?: TimelineToolState): TimelineToolClass {
  if (state === "error") return "failure"
  if (webTools.has(tool)) return "web"
  if (artifactTools.has(tool)) return "artifact"
  if (commandTools.has(tool)) return "command"
  if (simpleReadTools.has(tool)) return "simple-read"
  if (planningTools.has(tool)) return "planning"
  if (interactionTools.has(tool)) return "interaction"
  return "generic"
}

export function shouldRenderCompactTool(profile: MendPresentationProfile, tool: string) {
  if (profile === "raw") return false
  if (tool === "task") return false
  if (tool === "todowrite") return false
  if (toolClass(tool) === "artifact") return false
  if (profile === "minimal") return true
  return toolClass(tool) !== "artifact" && toolClass(tool) !== "command"
}

export function normalizeToolEvent(input: {
  tool: string
  state: TimelineToolState
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: unknown
}): TimelineToolEvent {
  const eventInput = input.input ?? {}
  const klass = toolClass(input.tool, input.state)
  const summary = toolSummary(input.tool, eventInput, input.metadata, input.output)
  return {
    type: "tool",
    tool: input.tool,
    class: klass,
    state: input.state,
    input: eventInput,
    metadata: input.metadata,
    output: input.output,
    title: summary.title,
    lines: summary.lines,
    result: summary.result,
  }
}

export function toolSummary(
  tool: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  output?: unknown,
): Pick<TimelineToolEvent, "title" | "lines" | "result"> {
  const file = stringValue(input.filePath) || stringValue(input.path) || stringValue(input.file)
  if (tool === "webfetch") return webFetchSummary(input)
  if (tool === "websearch") return webSearchSummary(input, metadata)
  if (tool === "read") return { title: `Read ${file || compactInput(input)}${readRange(input, output)}`.trim(), lines: [] }
  if (tool === "glob") return { title: `List ${stringValue(input.pattern) || compactInput(input)}${matchCount(metadata?.count)}`.trim(), lines: [] }
  if (tool === "grep" || tool === "codesearch")
    return { title: `Search ${quote(stringValue(input.pattern) || compactInput(input))}${matchCount(metadata?.matches)}`.trim(), lines: [] }
  if (tool === "bash" || tool === "shell") return { title: `Shell ${stringValue(input.description) || stringValue(input.command) || ""}`.trim(), lines: [] }
  if (tool === "write") return { title: `Write ${file || compactInput(input)}`.trim(), lines: [] }
  if (tool === "edit") return { title: `Edit ${file || compactInput(input)}`.trim(), lines: [] }
  if (tool === "apply_patch") return { title: "Patch files", lines: [] }
  if (tool === "task") return { title: `Task ${stringValue(input.description) || compactInput(input)}`.trim(), lines: [] }
  if (tool === "todowrite") return { title: "Todo list", lines: [] }
  if (tool === "question") return { title: "Question", lines: [] }
  if (tool === "skill") return { title: `Skill ${stringValue(input.name) || compactInput(input)}`.trim(), lines: [] }
  return { title: `${tool} ${compactInput(input)}`.trim(), lines: [] }
}

function webFetchSummary(input: Record<string, unknown>) {
  const url = stringValue(input.url) || stringValue(input.href) || ""
  const domain = domainFromUrl(url)
  const title = domain ? `Web ${domain}` : `Web ${compactInput(input)}`.trim()
  return {
    title,
    lines: usefulLines({ title: stringValue(input.title), link: url && !domain ? url : undefined }),
    result: "fetched",
  }
}

function webSearchSummary(input: Record<string, unknown>, metadata?: Record<string, unknown>) {
  const query = stringValue(input.query) || stringValue(input.q) || compactInput(input)
  return {
    title: `Search web ${query ? quote(query) : ""}${resultCount(metadata?.numResults)}`.trim(),
    lines: [],
    result: undefined,
  }
}

function readRange(input: Record<string, unknown>, output: unknown) {
  if (typeof output === "string") {
    if (output.includes("<type>directory</type>")) {
      const truncated = output.match(/\(Showing (\d+) of (\d+) entries\./)
      if (truncated) return ` (${truncated[1]} of ${truncated[2]} entries)`
      const entries = output.match(/\((\d+) entries\)/)
      if (entries) return ` (${entries[1]} entries)`
      return ""
    }
    const explicit = output.match(/\(Showing lines (\d+)-(\d+) of (\d+)\./)
    if (explicit) return ` (${explicit[1]}-${explicit[2]} of ${explicit[3]})`
    const capped = output.match(/\(Output capped at [^)]+\. Showing lines (\d+)-(\d+)\./)
    if (capped) return ` (${capped[1]}-${capped[2]})`
    const eof = output.match(/\(End of file - total (\d+) lines\)/)
    const offset = numberValue(input.offset) || 1
    const limit = numberValue(input.limit)
    if (eof && limit) return ` (${offset}-${Math.min(offset + limit - 1, Number(eof[1]))} of ${eof[1]})`
  }
  const offset = numberValue(input.offset)
  const limit = numberValue(input.limit)
  if (!offset && !limit) return ""
  if (offset && limit) return ` (${offset}-${offset + limit - 1})`
  if (offset) return ` (from ${offset})`
  return ` (${limit} lines)`
}

function matchCount(value: unknown) {
  const count = numberValue(value)
  if (!count) return ""
  return ` (${count} ${count === 1 ? "match" : "matches"})`
}

function resultCount(value: unknown) {
  const count = numberValue(value)
  if (!count) return ""
  return ` (${count} ${count === 1 ? "result" : "results"})`
}

function usefulLines(values: Record<string, unknown>) {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key.padEnd(7)} ${String(value).trim()}`)
}

function compactInput(input: Record<string, unknown>) {
  const primitives = Object.entries(input).filter(([, value]) => {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function domainFromUrl(value: string) {
  if (!value) return ""
  try {
    return new URL(value).hostname.replace(/^www\./, "")
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0]?.replace(/^www\./, "") || ""
  }
}

function quote(value: string) {
  if (!value) return value
  return value.startsWith('"') ? value : `"${value}"`
}
