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
  if (tool === "loop") return false
  if (tool === "todowrite") return profile === "mendcode"
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
  if (tool === "todowrite") return todoWriteSummary(input, metadata, output)
  if (tool === "question") return questionSummary(input, metadata)
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

function todoWriteSummary(input: Record<string, unknown>, metadata?: Record<string, unknown>, output?: unknown) {
  const todos = todoItems(input.todos)
  const fallbackTodos = todos.length ? todos : todoItems(metadata?.todos)
  const outputTodos = fallbackTodos.length ? fallbackTodos : parseTodoOutput(output)
  return {
    title: "Todos",
    lines: outputTodos.map((todo) => `${todoSymbol(todo.status)} ${todo.content}`),
  }
}

function todoItems(value: unknown): Array<{ content: string; status: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const todo = item as Record<string, unknown>
    const content = typeof todo.content === "string" ? todo.content.replace(/\s+/g, " ").trim() : ""
    if (!content) return []
    return [{ content, status: typeof todo.status === "string" ? todo.status : "" }]
  })
}

function parseTodoOutput(output: unknown): Array<{ content: string; status: string }> {
  if (typeof output !== "string" || !output.trim()) return []
  try {
    return todoItems(JSON.parse(output))
  } catch {
    return []
  }
}

function todoSymbol(status: string) {
  const normalized = status.toLowerCase().replace(/[-\s]+/g, "_")
  if (normalized === "completed" || normalized === "done" || normalized === "success") return "✓"
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "failed" || normalized === "error") return "×"
  if (normalized === "in_progress" || normalized === "running" || normalized === "active") return "→"
  return "○"
}

function questionSummary(input: Record<string, unknown>, metadata?: Record<string, unknown>) {
  const questions = questionItems(input.questions)
  const answers = answerItems(metadata?.answers)
  const count = questions.length
  const title = count === 1 ? "Question" : `Questions (${count})`
  const lines = questions.flatMap((question, index) => {
    const answer = answers[index]
    const header = question.header ? `${question.header}: ` : ""
    const options = question.options.length ? `choices: ${question.options.join(", ")}` : ""
    return [
      ...wrapTimelineLine("? ", `${header}${question.question}`),
      ...(options ? wrapTimelineLine("  ", options) : []),
      ...(answer?.length ? wrapTimelineLine("→ ", answer.join(", ")) : []),
    ]
  })
  return { title, lines }
}

function wrapTimelineLine(prefix: string, text: string, width = 76) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  const continuation = "  "
  let current = prefix

  const pushCurrent = () => {
    if (current.trim()) lines.push(current)
    current = continuation
  }

  for (const word of words) {
    const separator = current.trim() === prefix.trim() || current === continuation ? "" : " "
    const next = `${current}${separator}${word}`
    if (Bun.stringWidth(next) <= width) {
      current = next
      continue
    }

    pushCurrent()
    if (Bun.stringWidth(`${current}${word}`) <= width) {
      current = `${current}${word}`
      continue
    }

    let remaining = word
    while (Bun.stringWidth(`${current}${remaining}`) > width) {
      let cut = 0
      let measured = Bun.stringWidth(current)
      for (const char of remaining) {
        const charWidth = Bun.stringWidth(char)
        if (measured + charWidth > width) break
        measured += charWidth
        cut += char.length
      }
      lines.push(`${current}${remaining.slice(0, Math.max(1, cut))}`)
      remaining = remaining.slice(Math.max(1, cut))
      current = continuation
    }
    current = `${current}${remaining}`
  }

  pushCurrent()
  return lines.length ? lines : [prefix.trimEnd()]
}

function questionItems(value: unknown): Array<{ header: string; question: string; options: string[] }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const question = item as Record<string, unknown>
    const text = stringValue(question.question)?.replace(/\s+/g, " ").trim()
    if (!text) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== "object") return []
          const label = stringValue((option as Record<string, unknown>).label)?.replace(/\s+/g, " ").trim()
          return label ? [label] : []
        })
      : []
    return [{ header: stringValue(question.header)?.replace(/\s+/g, " ").trim() ?? "", question: text, options }]
  })
}

function answerItems(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map((answer) =>
    Array.isArray(answer)
      ? answer.flatMap((item) => {
          const text = stringValue(item)?.replace(/\s+/g, " ").trim()
          return text ? [text] : []
        })
      : [],
  )
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
